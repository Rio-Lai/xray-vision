/**
 * Claude calls for /api/identify and /api/teardown.
 * Model from ANTHROPIC_MODEL. Replies must be one JSON object; we validate with zod
 * and retry once with the validation errors if the first answer is invalid.
 */
import Anthropic from '@anthropic-ai/sdk';
import {
  IdentifyResponseSchema,
  TeardownSchema,
  type IdentifyRequest,
  type IdentifyResponse,
  type Teardown,
  type TeardownRequest,
} from '../../shared/teardown';
import { anthropicModel } from './env';
import { listCheckedObjects, safeId } from './cache';

let client: Anthropic | null = null;
const getClient = () => {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 90_000 });
  return client;
};

function textOf(msg: Anthropic.Message): string {
  let text = '';
  for (const block of msg.content) if (block.type === 'text') text += block.text;
  return text;
}

/** Pull the first {...} out of a reply, tolerating code fences or stray prose. */
function extractJson(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('reply had no JSON object');
  return JSON.parse(cleaned.slice(start, end + 1));
}

/* ---------------- identify ---------------- */

const IDENTIFY_SYSTEM = `You identify what is in a camera crop for an AR "x-ray vision" app.
Reply with exactly one JSON object and nothing else:
{"object_id": "kebab-case-id", "name": "Human readable name", "confidence": 0.0-1.0, "summary": "One plain sentence."}
object_id: lowercase kebab-case, specific (brand, model, generation, size) when you can tell, generic otherwise (e.g. "wireless-mouse").
Be honest about confidence. If you cannot tell the exact model, say so in the name (e.g. "MacBook Air 13-inch (M2 or M3)").`;

export async function identifyLive(req: IdentifyRequest): Promise<IdentifyResponse> {
  const known = listCheckedObjects()
    .map((o) => `- ${o.object_id}: ${o.name} [${o.lens}]`)
    .join('\n');
  const lensLine =
    req.lens === 'biology'
      ? 'Lens: biology. Name the body part in view and the system the app should show (e.g. "Hand and finger muscles"), not objects.'
      : 'Lens: engineering. Name the device or object in view.';

  const prompt = [
    lensLine,
    req.hint ? `The on-device detector thinks this is: "${req.hint}".` : '',
    known
      ? `Objects we already have checked teardowns for. If the object plausibly matches one, use its object_id exactly (the M2 and M3 13-inch MacBook Air look the same from outside):\n${known}`
      : '',
    'Reply with the JSON object only.',
  ]
    .filter(Boolean)
    .join('\n\n');

  const msg = await getClient().messages.create({
    model: anthropicModel(),
    max_tokens: 400,
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
  });

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
  "lens": "engineering" | "biology",   // given to you; copy it
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
    "summary": string,                 // ONE plain sentence
    "details": string,                 // 2-4 plain sentences for "tell me more"
    "safety": string | null,           // a real safety note, or null
    "mesh_url": null
  } ],
  "steps": [ { "n": 1, "text": string, "part_ids": [part ids] } ]
}

Rules:
- 8 to 12 parts. Real parts only, named the way a repair technician or an anatomy teacher would.
- Lay parts out so the placeholder shapes look like the real internal arrangement seen from the camera.
- Engineering: steps = a short, safe repair or disassembly walkthrough (5-8 steps). Safety notes must be real:
  lithium batteries (never puncture or bend; disconnect before other work), mains voltage, capacitors, sharp glass, springs.
- Biology: steps = how the part works in order (e.g. what happens during a movement). Put "Educational, not medical advice."
  in the safety field of the first part; other parts null unless there is a genuine caution.
- Only state facts you are confident of. Keep numbers few. No marketing language.`;

export async function teardownLive(req: TeardownRequest): Promise<Teardown> {
  const objectId = safeId(req.object_id);
  const user = `object_id: ${objectId}\nname: ${req.name}\nlens: ${req.lens}\n\nWrite the teardown JSON.`;

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: user }];
  let lastError = '';

  for (let attempt = 0; attempt < 2; attempt++) {
    const msg = await getClient().messages.create({
      model: anthropicModel(),
      max_tokens: 6000,
      system: TEARDOWN_SYSTEM,
      messages,
    });
    const text = textOf(msg);
    try {
      const raw = extractJson(text) as Record<string, unknown>;
      const parts = Array.isArray(raw.parts)
        ? (raw.parts as Record<string, unknown>[]).map((p) => ({ ...p, mesh_url: null }))
        : raw.parts;
      const parsed = TeardownSchema.safeParse({
        ...raw,
        object_id: objectId,
        lens: req.lens,
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
