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
import { anthropicEffort, anthropicModel, anthropicSketchEffort, anthropicSketchModel, type AnthropicEffort } from './env';
import {
  SKETCH_EXAMPLES,
  SKETCH_MAX_PARTS,
  cleanEnrichment,
  expandSketch,
  salvageJson,
  type EnrichRequest,
  type EnrichResponse,
  type SketchOutcome,
  type SketchRequest,
} from '../../shared/sketch';
import { listCheckedObjects, safeId } from './cache';

let client: Anthropic | null = null;
const getClient = () => {
  // The timeout only stops a stuck call. Sonnet at low effort wrote a parts list in ~10-20 s; Opus at medium
  // effort writes more (thinking plus a longer JSON with "visual" phrases) and may pass 60 s, so 120 s (#95).
  // One SDK retry for 429/5xx/network; invalid JSON is retried separately in teardownLive. Identify sets its
  // own, shorter limit.
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 120_000, maxRetries: 1 });
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

/** dimensions_mm (#120): kept only as three positive finite numbers, else dropped (never fails the list). */
function realSize(v: unknown): [number, number, number] | undefined {
  if (!Array.isArray(v) || v.length !== 3) return undefined;
  return v.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0) ? [v[0], v[1], v[2]] : undefined;
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
  "dimensions_mm": [w, d, h],          // the real object's size in millimetres (see Rules)
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
- dimensions_mm: your best estimate of the real object's size in millimetres, in the pose the parts are laid out in:
  w = across the bounding box (left to right), d = its other side (top to bottom), h = its thickness towards the
  camera; e.g. a 13-inch laptop base seen from above is about [304, 215, 11]. The floating 3D model takes its
  proportions from it, so give the real object's proportions, not the camera's foreshortened view.
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
        dimensions_mm: realSize(raw.dimensions_mm),
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

/* ---------------- scan (#122) ---------------- */

/**
 * The overlay's whole-view scan: one downscaled picture of the wearer's view (faces blacked out by the
 * app) -> the raw JSON reply, `{ things: [...] }`. server/routes/scan.ts validates it, clamps the boxes
 * and keeps at most 10. Model and effort come from the route (ANTHROPIC_SCAN_MODEL / ANTHROPIC_SCAN_EFFORT);
 * a limit of 8 s and no retry: the app scans again a few seconds later anyway. One log line (logged).
 */
export async function scanLive(req: { image: string; width: number; height: number; model: string; effort: AnthropicEffort | 'none' }): Promise<unknown> {
  const { width: w, height: h } = req;
  const known = listCheckedObjects()
    .filter((o) => o.lens !== 'biology')
    .map((o) => `- ${o.object_id}: ${o.name}`)
    .join('\n');
  const system = `You list the things in one picture from a head-mounted camera for Blowfish, an AR "x-ray vision" app: the
wearer can ask to see inside any of them or to learn about it. Reply with exactly one JSON object and nothing else:
{"things": [{"name": "Casio scientific calculator", "box": [x0, y0, x1, y1], "interest": 0.9, "centre": true}]}
Rules:
- Up to 10 distinct physical things someone might want to look inside or learn about, most interesting first.
- name: short and specific, in sentence case, 1 to 5 words ("Casio scientific calculator", "Desk lamp", "Potted basil"),
  never generic ("device", "object", "item", "electronics"). A brand or model only when you can read it or clearly tell it.
- box: a tight box round the thing, in pixels of this picture (x0, y0 = top-left corner, x1, y1 = bottom-right corner).
- interest: 0 to 1, how rewarding it would be to look inside it or learn about it. Gadgets, tools, machines,
  mechanisms, instruments, plants and food score high; plain containers, papers and furniture low.
- Leave out people and every part of a person (faces, hands, arms, hair, worn clothes), and walls, floors, ceilings,
  tables, desks, windows, doors and plain surfaces. Never list, name, describe or guess anything about a person.
  Black areas were blacked out on purpose: ignore them.
- Each thing once. Do not list parts of something you already listed (a laptop, not also its keyboard and screen).
- centre: true on the one thing at the centre of the picture (the point x = ${Math.round(w / 2)}, y = ${Math.round(h / 2)}), if a
  thing is there; leave the field out on every other thing.
- If a thing plausibly is one of these objects we have checked parts lists for, add "object_id" with its id exactly:
${known || '- (none)'}
- Nothing worth listing: {"things": []}.`;
  const msg = await logged('scan', req.model, req.effort, () =>
    getClient().messages.create(
      {
        model: req.model,
        // Room for (low-effort) thinking plus ten short things.
        max_tokens: 4000,
        ...effortConfig(req.effort),
        system,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: req.image } },
              { type: 'text', text: `The picture is ${w} x ${h} pixels. Reply with the JSON object only.` },
            ],
          },
        ],
      },
      { timeout: 8_000, maxRetries: 0 },
    ),
  );
  return extractJson(textOf(msg));
}

/* ---------------- sketch (#124): one look, simple solids, in seconds ---------------- */

/** The sketch call gives up after this long (no retry): the client then goes the old way. */
export const SKETCH_TIMEOUT_MS = 12_000;
/**
 * Room for low-effort thinking plus the compact reply (~300-500 tokens for 6-8 parts). Output length is
 * what costs seconds; a reply cut short here still keeps the parts written before the cut (salvageJson).
 */
export const SKETCH_MAX_TOKENS = 2000;

const SKETCH_SYSTEM = `You look at a camera crop for Blowfish, an AR "x-ray vision" app, name the object, and lay out its main
parts as a small 3D assembly of simple solids, so the app can draw a model of it within seconds. Reply with exactly one
compact JSON object on one line and nothing else (no prose, no code fence):
{"id":"kebab-case-id","n":"Human readable name","c":0.0-1.0,"bio":0|1,"d":[x,y,z],"p":[[id,name,shape,axis,[sx,sy,sz],[px,py,pz],"#rrggbb","One short sentence."],...]}
- id: lowercase kebab-case, specific (brand, model, size) when you can tell, generic otherwise. n: the name. c: how sure you are.
  bio: 1 for a living thing or body part, else 0. d: the whole object's size in millimetres.
- Frame: millimetres, x to the right, y up, z towards the viewer, origin at the centre of the object's bounding box, the
  object in its normal upright pose facing the viewer (a bottle stands up, a TV's screen faces +z).
- Each part: a short kebab-case id, its name, shape (box, board = flat slab such as a circuit board, cyl = cylinder,
  tube = hollow cylinder or ring, sph = sphere or ellipsoid), axis = the long axis of a cyl or tube ("x", "y" or "z"; ""
  for others), its size [sx, sy, sz] (extents along x, y, z) and the position of its centre [px, py, pz], a colour taken
  from what you see in the picture (internal parts: a realistic colour), and one short plain sentence.
- At most ${SKETCH_MAX_PARTS} parts, main parts first. Simple things get few parts (a mug: body, base, handle); never invent parts.
  No screws, glue, stickers or tiny fittings on their own.
- Sizes in real millimetres for this object. Parts touch or nest the way the real ones do and never float: a cap sits on
  its neck, legs meet the seat, a stand meets the TV.
- A hollow container is drawn as its wall parts (body, cap) with the contents as their own part if they are visible.
- Internals that cannot be seen are placed where they really are, inside the outer part (a drum inside the cabinet,
  boards inside the back cover).
- If the object is plausibly one of the checked objects listed in the request, reply only {"id":"<that id>","n":"<name>","c":<c>,"known":1}.
- If there is no clear object, reply {"id":"unknown","n":"Unknown","c":0}.

Worked examples (copy the style, not the numbers):
${Object.values(SKETCH_EXAMPLES).join('\n')}`;

/**
 * POST /api/sketch: one vision call on the crop -> its name and a solid parts list (shared/sketch.ts expands,
 * validates and clamps it). Low effort, a tight token limit, SKETCH_TIMEOUT_MS, no retry, one log line.
 */
export async function sketchLive(req: SketchRequest, checkedIds: string[]): Promise<SketchOutcome> {
  const known = listCheckedObjects()
    .map((o) => `- ${o.object_id}: ${o.name}`)
    .join('\n');
  const prompt = [
    req.hint ? `It is thought to be: "${req.hint}" (may be wrong; trust the picture).` : 'This is the middle of the wearer\'s view; name the main thing in it.',
    known ? `Checked objects (reply with the id only if it plausibly is one of these):\n${known}` : '',
    'Reply with the compact JSON only.',
  ]
    .filter(Boolean)
    .join('\n\n');
  const model = anthropicSketchModel();
  const effort = anthropicSketchEffort();
  const msg = await logged('sketch', model, effort, () =>
    getClient().messages.create(
      {
        model,
        max_tokens: SKETCH_MAX_TOKENS,
        ...effortConfig(effort),
        system: [{ type: 'text', text: SKETCH_SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: req.image } },
              { type: 'text', text: prompt },
            ],
          },
        ],
      },
      { timeout: SKETCH_TIMEOUT_MS, maxRetries: 0 },
    ),
  );
  const raw = salvageJson(textOf(msg));
  if (!raw) throw new Error('sketch reply had no JSON object');
  return expandSketch(raw, { checkedIds, fallbackName: req.hint });
}

/* ---------------- enrich (#124): the details afterwards ---------------- */

const ENRICH_SYSTEM = `You write the explanations for an AR "x-ray vision" app that has just drawn a quick model of an object as
simple solids. The parts are fixed: write text for exactly the part ids given, no others. Reply with exactly one JSON object:
{"parts":[{"id":string,"details":"2-4 plain sentences for 'tell me more'","safety":string|null}],
 "steps":[{"text":"one sentence","part_ids":[ids]}]}
- details: what the part is made of, what it does and how it connects to its neighbours. Only facts you are confident of.
- safety: a real safety note (lithium batteries, mains voltage, capacitors, sharp glass, springs, hot parts), else null.
  For a living thing: "Educational, not medical advice." on the first part.
- steps: 3 to 6 short, safe steps taking it apart (for a living thing: how it works, in order), each naming the ids involved.
- No marketing language.`;

/** POST /api/enrich: the longer text, safety notes and steps for a sketched parts list, at the normal parts-list effort. */
export async function enrichLive(req: EnrichRequest): Promise<EnrichResponse> {
  const ids = req.parts.map((p) => p.id);
  const user =
    `Object: ${req.name} (${safeId(req.object_id)})\nParts:\n` +
    req.parts.map((p) => `- ${p.id}: ${p.name}${p.summary ? `. ${p.summary}` : ''}`).join('\n') +
    '\n\nWrite the JSON object only.';
  const model = anthropicModel();
  const effort = anthropicEffort('teardown');
  const msg = await logged(`enrich ${safeId(req.object_id)}`, model, effort, () =>
    getClient().messages.create({
      model,
      // ~1-2k tokens of JSON plus medium-effort thinking.
      max_tokens: 12000,
      ...effortConfig(effort),
      system: ENRICH_SYSTEM,
      messages: [{ role: 'user', content: user }],
    }),
  );
  const text = textOf(msg);
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch {
    raw = salvageJson(text);
  }
  const out = cleanEnrichment(raw, ids);
  if (out.parts.length === 0 && out.steps.length === 0) throw new Error('enrich reply had no usable parts or steps');
  return out;
}
