/**
 * Claude calls for /api/identify and /api/teardown.
 * Model from ANTHROPIC_MODEL (default claude-opus-5-5). Effort per call (#95): the parts list uses
 * ANTHROPIC_EFFORT (default medium), naming uses ANTHROPIC_IDENTIFY_EFFORT (default low, to answer inside
 * the identify limits); see anthropicEffort in env.ts. Each call logs one line (call, model, effort, seconds).
 * Replies must be one JSON object; we validate with zod, clamp sizes and offsets into range, and retry
 * once with the validation errors if the answer is invalid.
 *
 * No lenses: a request's `lens` is only a hint. Claude decides whether the thing is a machine
 * ("engineering") or a living thing ("biology") and sets the parts list's `lens` itself.
 */
import Anthropic from '@anthropic-ai/sdk';
import {
  IdentifyResponseSchema,
  TeardownSchema,
  LensSchema,
  type IdentifyRequest,
  type IdentifyResponse,
  type Lens,
  type Teardown,
  type TeardownRequest,
} from '../../shared/teardown';
import { anthropicEffort, anthropicModel, type AnthropicEffort } from './env';
import { listCheckedObjects, safeId } from './cache';

let client: Anthropic | null = null;
const getClient = () => {
  // At low effort a parts list takes ~10-20 s; the timeout only stops a stuck call. One SDK retry for
  // 429/5xx/network; invalid JSON is retried separately in teardownLive. Identify sets its own, shorter limit.
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 60_000, maxRetries: 1 });
  return client;
};

/**
 * Identify answers quickly or not at all, with no retry: "analyse this" stops waiting after 6 s and
 * goes on with the detector's label (IDENTIFY_TIMEOUT_MS in src/lib/flow.ts, #84; 6 s rather than 4 s
 * since Opus, #95). A little longer here (7 s) so the client's limit decides; on a time-out the route
 * answers with the label (fallback). With no label (the middle of the view, nothing detected there, #80)
 * the client waits up to 12 s (CENTRE_IDENTIFY_TIMEOUT_MS), so this stops just before it and the client
 * gets the fallback.
 */
const identifyRequest = (req: IdentifyRequest) => ({ timeout: req.hint ? 7_000 : 11_000, maxRetries: 0 });

/** The request's effort field, or nothing for "none" (older models reject effort). */
function effortConfig(effort: AnthropicEffort | 'none'): { output_config?: { effort: AnthropicEffort } } {
  return effort === 'none' ? {} : { output_config: { effort } };
}

/** Runs one Claude call and logs one line: which call, model, effort, seconds (and tokens, or "failed"). */
async function logged(
  call: string,
  model: string,
  effort: AnthropicEffort | 'none',
  run: () => Promise<Anthropic.Message>,
): Promise<Anthropic.Message> {
  const started = Date.now();
  const line = (outcome: string) =>
    console.info(`[claude] ${call}: ${model}, effort ${effort}, ${((Date.now() - started) / 1000).toFixed(1)} s, ${outcome}`);
  try {
    const msg = await run();
    line(`${msg.usage?.input_tokens ?? '?'} in / ${msg.usage?.output_tokens ?? '?'} out tokens, stop ${msg.stop_reason}`);
    return msg;
  } catch (err) {
    line('failed');
    throw err;
  }
}

/** Short sentences the voice tutor can say when a live call fails. */
export const TEARDOWN_FAIL_MESSAGE = (name: string) => `I could not work out the parts for the ${name}. Try again in a moment.`;

const clamp = (n: unknown, lo: number, hi: number, fallback: number) => {
  const v = typeof n === 'number' ? n : Number(n);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
};

/** Pull sizes into 0..1, offsets into -0.5..0.5 and layers to integers >= 0 before validation. */
function normalisePart(p: Record<string, unknown>): Record<string, unknown> {
  const size = Array.isArray(p.size) ? p.size : [];
  const offset = Array.isArray(p.offset) ? p.offset : [];
  return {
    ...p,
    layer: Math.round(clamp(p.layer, 0, 99, 0)),
    size: [clamp(size[0], 0.01, 1, 0.3), clamp(size[1], 0.01, 1, 0.3), clamp(size[2], 0.01, 1, 0.05)],
    offset: [clamp(offset[0], -0.5, 0.5, 0), clamp(offset[1], -0.5, 0.5, 0)],
    color: typeof p.color === 'string' && /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : '#9aa4ae',
    safety: typeof p.safety === 'string' && p.safety.trim() ? p.safety : null,
    // Optional: a missing or empty phrase is dropped (partPrompt then uses the name) rather than failing the list.
    visual: typeof p.visual === 'string' && p.visual.trim() ? p.visual.trim() : undefined,
    mesh_url: null,
  };
}

function textOf(msg: Anthropic.Message): string {
  let text = '';
  for (const block of msg.content) if (block.type === 'text') text += block.text;
  // Current models think by default and thinking counts towards max_tokens; say so instead of "no JSON".
  if (msg.stop_reason === 'refusal') throw new Error('Claude declined this request');
  if (!text.trim() && msg.stop_reason === 'max_tokens') {
    throw new Error('reply hit max_tokens before any text (thinking used the budget); raise max_tokens');
  }
  return text;
}

/** Pull the JSON object out of a reply, tolerating code fences or stray prose (even prose with braces). */
function extractJson(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('reply had no JSON object');
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (err) {
    // Fall back to each balanced {...} in turn (string-aware), largest first.
    const candidates: string[] = [];
    for (let i = cleaned.indexOf('{'); i >= 0; i = cleaned.indexOf('{', i + 1)) {
      let depth = 0;
      let inStr = false;
      for (let j = i; j < cleaned.length; j++) {
        const c = cleaned[j];
        if (inStr) {
          if (c === '\\') j++;
          else if (c === '"') inStr = false;
        } else if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) {
          candidates.push(cleaned.slice(i, j + 1));
          break;
        }
      }
    }
    candidates.sort((a, b) => b.length - a.length);
    for (const c of candidates) {
      try {
        return JSON.parse(c);
      } catch {
        /* try the next one */
      }
    }
    throw err;
  }
}

/* ---------------- identify ---------------- */

const IDENTIFY_SYSTEM = `You identify what is in a camera crop for Blowfish, an AR "x-ray vision" app. The thing can be a machine
or object (a laptop, a phone, a mouse) or a living thing or body part (a hand, a leaf).
Reply with exactly one JSON object and nothing else:
{"object_id": "kebab-case-id", "name": "Human readable name", "confidence": 0.0-1.0, "summary": "One plain sentence."}
object_id: lowercase kebab-case, specific (brand, model, generation, size) when you can tell, generic otherwise (e.g. "wireless-mouse").
For a body part, name the system the app should show (e.g. "Hand and finger muscles"), not jewellery or clothes.
Be honest about confidence. If you cannot tell the exact model, say so in the name (e.g. "MacBook Air 13-inch (M2 or M3)").`;

export async function identifyLive(req: IdentifyRequest): Promise<IdentifyResponse> {
  const known = listCheckedObjects()
    .map((o) => `- ${o.object_id}: ${o.name}`)
    .join('\n');
  const prompt = [
    req.hint
      ? `The on-device detector thinks this is: "${req.hint}".`
      : 'This is the middle of the wearer\'s view; the on-device detector found nothing there. Name the main thing in it. If there is no clear object, use object_id "unknown" and confidence 0.',
    known
      ? `Objects we already have checked teardowns for. If the object plausibly matches one, use its object_id exactly (the M2 and M3 13-inch MacBook Air look the same from outside):\n${known}`
      : '',
    'Reply with the JSON object only.',
  ]
    .filter(Boolean)
    .join('\n\n');

  const model = anthropicModel();
  const effort = anthropicEffort('identify');
  const msg = await logged(req.hint ? 'identify' : 'identify (centre)', model, effort, () =>
    getClient().messages.create({
      model,
      // Room for (low-effort) adaptive thinking plus the short JSON reply.
      max_tokens: 4000,
      ...effortConfig(effort),
      system: IDENTIFY_SYSTEM,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: req.image } },
            { type: 'text', text: prompt },
          ],
        },
      ],
    }, identifyRequest(req)),
  );

  const raw = extractJson(textOf(msg)) as Record<string, unknown>;
  const conf = Number(raw.confidence);
  return IdentifyResponseSchema.parse({
    object_id: safeId(String(raw.object_id ?? 'object')),
    name: String(raw.name ?? req.hint ?? 'Unknown object'),
    confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0.5,
    summary: String(raw.summary ?? ''),
  });
}

/* ---------------- teardown ---------------- */

const TEARDOWN_SYSTEM = `You write teardown data for an AR "x-ray vision" app. The user looks at a real object (or a body part)
through a head-mounted camera; the app draws its internal parts as an exploded 3D view floating over it,
and a voice tutor explains each part. Reply with exactly one JSON object and nothing else.

Schema:
{
  "object_id": string,                 // given to you; copy it
  "name": string,                      // human readable
  "lens": "engineering" | "biology",   // YOU decide: "biology" for a living thing or body part, "engineering" for anything else
  "anchor": "box" | "hand" | "face" | "pose",  // box = detector box (objects); hand/face/pose for body parts
  "explode_axis": "z",                 // use "z" (towards the camera) unless the object is long and thin
  "source": "live",
  "parts": [ {
    "id": string,                      // kebab-case, unique
    "name": string,
    "layer": integer >= 0,             // 0 = outermost / nearest the camera; higher = deeper inside
    "size": [w, h, d],                 // fractions of the object's 2D bounding box (0..1); d = thickness, same scale
    "offset": [x, y],                  // part centre minus box centre, as fractions of the box (-0.5..0.5); +y is DOWN (image convention)
    "shape": "box" | "board" | "cylinder" | "sphere" | "tube",  // board = flat slab (PCBs, panels)
    "color": "#rrggbb",                // a colour that looks like the real part
    "visual": string,                  // what this part looks like on its own, for an image model (see Rules)
    "summary": string,                 // ONE plain sentence
    "details": string,                 // 2-4 plain sentences for "tell me more"
    "safety": string | null,           // a real safety note, or null
    "mesh_url": null
  } ],
  "steps": [ { "n": 1, "text": string, "part_ids": [part ids] } ]
}

Rules:
- The request may include a lens hint from the on-device detector; it is only a hint. Decide from the name what the thing is.
- 6 to 12 parts: the main parts a person would actually find on opening this object (for a living thing, the structures
  an anatomy teacher would point to), named the way a repair technician or an anatomy teacher would. No screws, glue,
  labels or tiny fittings on their own (fold them into the assembly they belong to), no duplicates, and no parts this
  object does not have: a simple object gets fewer parts, not invented ones.
- Layout, so the assembled placeholder shapes read as the object seen from the camera:
  - The bounding box is the object's outline as the camera sees it. The outermost part (layer 0: the case, cover, lid,
    shell or skin) fills it: size close to [1, 1, d], offset [0, 0].
  - Every other part lies inside that footprint: |offset x| + w/2 <= 0.5 and |offset y| + h/2 <= 0.5.
  - Sizes are realistic relative to each other and to the object (a laptop battery covers much of the base; a fan or a
    chip is small). d is the part's real thickness on the same scale as w.
  - Layers go from the outside in, in the order you meet the parts taking it apart: 0 = the outer shell, 1 = what you
    see once that is off, and so on. Parts side by side at the same depth share a layer and do not overlap.
  - Pick the shape that matches the part: board for circuit boards and flat panels, cylinder for fans, motors, cells and
    lenses, tube for cables, hoses, tendons and vessels, sphere for round things.
- visual (every part): one plain phrase saying what that part looks like removed and seen on its own, written for an
  image model: shape, colour, material and one distinguishing feature, e.g. "a flat grey rectangular lithium-polymer
  pack of three cells joined by a thin flex cable". No brand or model names, no printed text, labels or logos, and
  nothing about where it sits in the object.
- Engineering: steps = a short, safe repair or disassembly walkthrough (5-8 steps). Safety notes must be real:
  lithium batteries (never puncture or bend; disconnect before other work), mains voltage, capacitors, sharp glass, springs.
- Biology: steps = how the part works in order (e.g. what happens during a movement). Put "Educational, not medical advice."
  in the safety field of the first part; other parts null unless there is a genuine caution.
- Only state facts you are confident of. Keep numbers few. No marketing language.`;

export async function teardownLive(req: TeardownRequest): Promise<Teardown> {
  const objectId = safeId(req.object_id);
  const user =
    `object_id: ${objectId}\nname: ${req.name}\nlens hint (may be wrong): ${req.lens}\n\n` +
    'Write the teardown JSON: 6 to 12 parts a person would really find inside, each with its "visual" phrase, ' +
    "sized and placed inside the object's outline, layered from the outside in.";

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: user }];
  let lastError = '';

  const model = anthropicModel();
  const effort = anthropicEffort('teardown');
  for (let attempt = 0; attempt < 2; attempt++) {
    const msg = await logged(`teardown ${objectId}${attempt ? ' (retry)' : ''}`, model, effort, () =>
      getClient().messages.create({
        model,
        // Thinking counts towards max_tokens. The JSON is ~4-5k tokens (12 parts with "visual", 8 steps);
        // 20k leaves ~15k for medium-effort thinking, so a long think still ends in JSON (#95).
        max_tokens: 20000,
        ...effortConfig(effort),
        system: TEARDOWN_SYSTEM,
        messages,
      }),
    );
    const text = textOf(msg);
    try {
      const raw = extractJson(text) as Record<string, unknown>;
      const parts = Array.isArray(raw.parts)
        ? (raw.parts as unknown[]).map((p) => (p && typeof p === 'object' ? normalisePart(p as Record<string, unknown>) : p))
        : raw.parts;
      // Claude's own choice of lens wins; the request's lens is only the fallback.
      const lensParsed = LensSchema.safeParse(raw.lens);
      const lens: Lens = lensParsed.success ? lensParsed.data : req.lens;
      const parsed = TeardownSchema.safeParse({
        ...raw,
        object_id: objectId,
        lens,
        explode_axis: raw.explode_axis ?? 'z',
        source: 'live',
        parts,
        steps: Array.isArray(raw.steps) ? raw.steps : [],
      });
      if (parsed.success) return parsed.data;
      lastError = parsed.error.issues
        .slice(0, 10)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    console.warn(`[teardown] attempt ${attempt + 1} invalid: ${lastError}`);
    messages.push({ role: 'assistant', content: text || '(empty)' });
    messages.push({
      role: 'user',
      content: `That did not match the schema: ${lastError}. Reply again with the corrected JSON object only.`,
    });
  }
  throw new Error(`Claude teardown invalid after retry: ${lastError}`);
}
