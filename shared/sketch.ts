/**
 * #124, live objects in seconds: POST /api/sketch (one Claude look at the crop -> a small 3D assembly of
 * simple solids) and POST /api/enrich (the longer text afterwards). Shared by the server (which expands
 * Claude's compact reply) and the client (the ?mock=1 bottle uses the same expansion, and merges enrich).
 *
 * The compact reply (short keys, positional parts, so the answer is a few hundred tokens):
 *   {"id": "plastic-water-bottle", "n": "Plastic water bottle", "c": 0.9, "bio": 0, "d": [x, y, z],
 *    "p": [[id, name, shape, axis, [sx, sy, sz], [px, py, pz], "#rrggbb", "One sentence."], ...]}
 *   shape: box | board | cyl | tube | sph; axis: x | y | z for cyl and tube ("" otherwise);
 *   sizes and centres in millimetres, x right, y up, z towards the viewer, origin at the object's centre.
 *   A checked object: {"id": "<its id>", "n": "...", "c": 0.9, "known": 1} and no parts.
 *   Nothing clear: {"id": "unknown", "n": "Unknown", "c": 0}.
 *
 * expandSketch validates and clamps it, drops bad parts (never the whole list for one), makes ids
 * kebab-case and unique, recentres the assembly, settles any part that floats onto its nearest
 * neighbour, and derives the flat fields the schema requires (size, offset, layer, explode_axis) from
 * the front view, outer parts first. Pure (no I/O), so it can be checked on its own.
 */
import { z } from 'zod';
import { LensSchema, TeardownSchema, type PartShape, type Teardown, type TeardownPart } from './teardown';

/** At most this many parts in a sketch. */
export const SKETCH_MAX_PARTS = 8;

/* ---------- API shapes ---------- */

/** POST /api/sketch */
export const SketchRequestSchema = z.object({
  /** base64 JPEG (no data: prefix) of the object's crop */
  image: z.string(),
  /** what the object is thought to be: the detector's label, or a name Claude already gave it */
  hint: z.string().optional(),
  /** a name Claude already gave it (its object_id): a stored or cached sketch for it answers at once */
  object_id: z.string().optional(),
  lens: LensSchema.optional(),
});
export type SketchRequest = z.infer<typeof SketchRequestSchema>;

/**
 * POST /api/sketch answers one of: a Teardown (layout "solid") plus `confidence` and `summary`;
 * `{ checked: true, object_id, name, confidence }` (open the stored list instead);
 * `{ unknown: true, ... }` (nothing clear in the crop); `{ mock: true }` (no key);
 * `{ fallback: true, error }` (the call failed or timed out: use the old path).
 */
export interface SketchAnswer {
  checked?: boolean;
  unknown?: boolean;
  mock?: boolean;
  fallback?: boolean;
  shortcut?: boolean;
  cached?: boolean;
  error?: string;
  object_id?: string;
  name?: string;
  confidence?: number;
  summary?: string;
}

/** POST /api/enrich */
export const EnrichRequestSchema = z.object({
  object_id: z.string(),
  name: z.string(),
  parts: z
    .array(z.object({ id: z.string(), name: z.string(), summary: z.string().optional() }))
    .min(1)
    .max(SKETCH_MAX_PARTS * 2),
});
export type EnrichRequest = z.infer<typeof EnrichRequestSchema>;

export interface EnrichResponse {
  parts: { id: string; details: string; safety: string | null }[];
  steps: { n: number; text: string; part_ids: string[] }[];
}

/* ---------- worked examples (also the prompt's) ---------- */

/** The prompt's worked examples, compact. Also the ?mock=1 bottle's built-in sketch. */
export const SKETCH_EXAMPLES: Record<'bottle' | 'mug' | 'chair' | 'tv' | 'washer' | 'projector', string> = {
  bottle:
    '{"id":"plastic-water-bottle-500ml","n":"Plastic water bottle (500 ml)","c":0.9,"bio":0,"d":[66,210,66],"p":[' +
    '["body","Body","cyl","y",[65,140,65],[0,-35,0],"#d8eaf3","The thin clear PET wall that holds the water."],' +
    '["shoulder","Shoulder","cyl","y",[52,28,52],[0,49,0],"#d8eaf3","The tapered top of the bottle that narrows to the neck."],' +
    '["neck","Neck","cyl","y",[27,32,27],[0,79,0],"#e3eff5","The threaded opening the cap screws onto."],' +
    '["cap","Cap","cyl","y",[31,22,31],[0,94,0],"#1f63c6","A screw cap with a liner that seals the neck."],' +
    '["label","Label","tube","y",[66,70,66],[0,-25,0],"#2f86d6","A thin printed plastic sleeve wrapped round the body."],' +
    '["water","Water","cyl","y",[61,125,61],[0,-40,0],"#bfe1f6","The contents, filling most of the body."]]}',
  mug:
    '{"id":"ceramic-mug","n":"Ceramic mug","c":0.9,"bio":0,"d":[104,95,82],"p":[' +
    '["body","Body","tube","y",[82,95,82],[-11,0,0],"#f2f1ec","The glazed ceramic wall that holds the drink."],' +
    '["base","Base","cyl","y",[78,6,78],[-11,-44.5,0],"#e6e4dd","The thick bottom that closes the cup and stands on the table."],' +
    '["handle","Handle","tube","z",[36,60,12],[34,4,0],"#f2f1ec","A loop of ceramic fused to the side to hold it by."]]}',
  chair:
    '{"id":"wooden-dining-chair","n":"Wooden dining chair","c":0.85,"bio":0,"d":[450,850,420],"p":[' +
    '["seat","Seat","box","",[450,30,420],[0,10,0],"#a8743f","The flat board you sit on, which ties the legs together."],' +
    '["backrest","Backrest","box","",[450,400,25],[0,225,-197.5],"#a8743f","The upright panel that supports your back."],' +
    '["leg-front-left","Front left leg","cyl","y",[30,420,30],[-210,-215,195],"#93622f","One of four legs carrying the seat to the floor."],' +
    '["leg-front-right","Front right leg","cyl","y",[30,420,30],[210,-215,195],"#93622f","One of four legs carrying the seat to the floor."],' +
    '["leg-back-left","Back left leg","cyl","y",[30,420,30],[-210,-215,-195],"#93622f","One of four legs carrying the seat to the floor."],' +
    '["leg-back-right","Back right leg","cyl","y",[30,420,30],[210,-215,-195],"#93622f","One of four legs carrying the seat to the floor."]]}',
  tv:
    '{"id":"flat-screen-tv-43in","n":"43-inch flat-screen TV","c":0.85,"bio":0,"d":[970,625,220],"p":[' +
    '["bezel","Bezel","box","",[970,565,10],[0,30,35],"#1b1c1f","The thin plastic frame round the screen."],' +
    '["panel","LCD panel","box","",[955,550,14],[0,30,25],"#2a2d33","The glass LCD and backlight that make the picture."],' +
    '["back-cover","Back cover","box","",[960,555,50],[0,30,-5],"#3a3c40","The moulded plastic shell that closes the back."],' +
    '["mainboard","Mainboard","board","",[200,130,8],[250,-12.5,10],"#2f7a4a","The board with the processor, tuner and HDMI ports."],' +
    '["power-board","Power board","board","",[220,150,10],[-250,-12.5,10],"#2f6f7a","Turns mains power into the low voltages the TV runs on."],' +
    '["speakers","Speakers","box","",[700,30,40],[0,-227.5,-5],"#202124","A pair of small downward-firing speakers along the bottom."],' +
    '["stand-neck","Stand neck","box","",[80,90,30],[0,-252.5,-25],"#2b2c2f","The post that holds the TV up on its base."],' +
    '["stand-base","Stand base","box","",[300,15,220],[0,-305,0],"#2b2c2f","The flat foot that keeps the TV upright on the table."]]}',
  washer:
    '{"id":"front-loading-washing-machine","n":"Front-loading washing machine","c":0.85,"bio":0,"d":[600,850,620],"p":[' +
    '["cabinet","Cabinet","box","",[600,850,570],[0,0,-25],"#eef0f2","The painted steel box that holds everything."],' +
    '["door","Door","cyl","z",[320,320,60],[0,-25,280],"#c9d2da","The round glass porthole door with its seal."],' +
    '["drum","Drum","cyl","z",[480,480,450],[0,-25,-45],"#b8bec6","The perforated stainless drum that turns the washing."],' +
    '["motor","Motor","cyl","x",[220,150,150],[0,-330,-160],"#6f757c","The electric motor under the drum that spins it."],' +
    '["detergent-drawer","Detergent drawer","box","",[180,80,300],[-190,325,110],"#dfe3e7","The pull-out tray the powder and softener go in."],' +
    '["control-panel","Control panel","board","",[400,100,25],[90,330,252.5],"#d5dade","The dial, buttons and display with the control board behind them."]]}',
  projector:
    '{"id":"home-projector","n":"Home projector","c":0.8,"bio":0,"d":[300,100,260],"p":[' +
    '["case","Case","box","",[300,100,230],[0,0,-15],"#e9e9ea","The plastic housing with vents on the sides."],' +
    '["lens","Lens","cyl","z",[60,60,40],[-80,0,110],"#2a2e35","The focusing lens that throws the picture onto the wall."],' +
    '["light-engine","LED light engine","box","",[90,70,110],[-80,0,35],"#7c8693","The LED light source and imaging chip behind the lens."],' +
    '["fan","Fan","cyl","x",[20,70,70],[140,0,-55],"#4a4f57","Blows hot air from the light engine out of the side vent."],' +
    '["mainboard","Mainboard","board","",[260,6,200],[0,-40,-15],"#2f7a4a","The board that decodes the video and drives the light engine."],' +
    '["power-supply","Power supply","box","",[80,50,80],[70,-10,-65],"#5b6068","Turns mains power into the low voltages inside."]]}',
};

/* ---------- expansion ---------- */

export type Vec3 = [number, number, number];

const SHAPES: Record<string, PartShape> = {
  box: 'box',
  board: 'board',
  cyl: 'cylinder',
  cylinder: 'cylinder',
  tube: 'tube',
  sph: 'sphere',
  sphere: 'sphere',
};

const NEUTRAL = '#9aa4ae';
const UNKNOWN_IDS = new Set(['unknown', 'unknown-object', 'object', 'nothing', 'none', 'unclear']);

export function kebab(s: string): string {
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || 'part';
}

const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);

function vec(v: unknown): Vec3 | null {
  if (!Array.isArray(v) || v.length !== 3) return null;
  const out = v.map(num) as Vec3;
  return out.every((n) => Number.isFinite(n)) ? out : null;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The axis whose cross-section (the other two extents) is roundest; ties go to the longest. */
export function guessAxis(size: Vec3): 'x' | 'y' | 'z' {
  const names = ['x', 'y', 'z'] as const;
  let best = 1;
  let bestScore = Infinity;
  for (let a = 0; a < 3; a++) {
    const b = size[(a + 1) % 3];
    const c = size[(a + 2) % 3];
    const score = Math.abs(b - c) / Math.max(b, c) - 0.001 * (size[a] / Math.max(...size));
    if (score < bestScore) {
      bestScore = score;
      best = a;
    }
  }
  return names[best];
}

export interface Box3 {
  c: Vec3;
  s: Vec3;
}

/** Clear distance between two boxes (0 when they touch or overlap). */
export function boxGap(a: Box3, b: Box3): number {
  let d2 = 0;
  for (let i = 0; i < 3; i++) {
    const g = Math.abs(a.c[i] - b.c[i]) - (a.s[i] + b.s[i]) / 2;
    if (g > 0) d2 += g * g;
  }
  return Math.sqrt(d2);
}

/** Overlap volume test with a clearance: true when the boxes come closer than `gap` on every axis. */
export function boxesOverlap(a: Box3, b: Box3, gap = 0): boolean {
  for (let i = 0; i < 3; i++) if (Math.abs(a.c[i] - b.c[i]) >= (a.s[i] + b.s[i]) / 2 + gap) return false;
  return true;
}

/** Union bounds of boxes: centre and size. */
export function unionBox(boxes: Box3[]): Box3 {
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const b of boxes) {
    for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i], b.c[i] - b.s[i] / 2);
      hi[i] = Math.max(hi[i], b.c[i] + b.s[i] / 2);
    }
  }
  if (!Number.isFinite(lo[0])) return { c: [0, 0, 0], s: [1, 1, 1] };
  return { c: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2], s: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]] };
}

/**
 * Parts never float (#124): starting from the largest part, any part that neither touches nor overlaps
 * the parts already joined (more than `tol` apart) is moved straight towards its nearest joined
 * neighbour until it touches. Mutates the centres; returns how many parts were moved.
 */
export function settleFloating(boxes: Box3[], tol: number): number {
  if (boxes.length < 2) return 0;
  const vol = (b: Box3) => b.s[0] * b.s[1] * b.s[2];
  const order = boxes.map((_, i) => i).sort((a, b) => vol(boxes[b]) - vol(boxes[a]));
  const joined = new Set<number>([order[0]]);
  let moved = 0;
  while (joined.size < boxes.length) {
    // the free part nearest to anything joined
    let best = -1;
    let bestTo = -1;
    let bestGap = Infinity;
    for (const i of order) {
      if (joined.has(i)) continue;
      for (const j of joined) {
        const g = boxGap(boxes[i], boxes[j]);
        if (g < bestGap) {
          bestGap = g;
          best = i;
          bestTo = j;
        }
      }
    }
    if (best < 0) break;
    if (bestGap > tol) {
      const a = boxes[best];
      const b = boxes[bestTo];
      for (let k = 0; k < 3; k++) {
        const g = Math.abs(a.c[k] - b.c[k]) - (a.s[k] + b.s[k]) / 2;
        if (g > 0) a.c[k] += (a.c[k] > b.c[k] ? -1 : 1) * g;
      }
      moved++;
    }
    joined.add(best);
  }
  return moved;
}

export type SketchOutcome =
  | { kind: 'solid'; td: Teardown; confidence: number; summary: string; dropped: number; settled: number }
  | { kind: 'checked'; object_id: string; name: string; confidence: number }
  | { kind: 'unknown'; object_id: string; name: string; confidence: number }
  | { kind: 'empty'; reason: string };

interface RawPart {
  id: string;
  name: string;
  shape: PartShape;
  axis?: 'x' | 'y' | 'z';
  box: Box3;
  color: string;
  summary: string;
}

/** One compact part (an array, or an object with the same short or long keys), or null if it is unusable. */
function readPart(v: unknown, limit: number): RawPart | null {
  let id: unknown, name: unknown, shape: unknown, axis: unknown, size: unknown, pos: unknown, color: unknown, summary: unknown;
  if (Array.isArray(v)) [id, name, shape, axis, size, pos, color, summary] = v;
  else if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    id = o.id;
    name = o.n ?? o.name;
    shape = o.sh ?? o.shape;
    axis = o.ax ?? o.axis;
    size = o.s ?? o.size_mm ?? o.size;
    pos = o.p ?? o.position_mm ?? o.pos;
    color = o.col ?? o.color;
    summary = o.t ?? o.summary;
  } else return null;
  const s = vec(size);
  const c = vec(pos);
  if (!s || !c) return null;
  if (s.some((n) => n <= 0)) return null; // a flat or negative size is a bad part, not a thin one
  const label = typeof name === 'string' && name.trim() ? name.trim().slice(0, 60) : typeof id === 'string' ? id : '';
  if (!label) return null;
  const sh = SHAPES[String(shape ?? '').toLowerCase().trim()] ?? 'box';
  const size3 = s.map((n) => clamp(n, 1, limit)) as Vec3;
  const centre = c.map((n) => clamp(n, -3 * limit, 3 * limit)) as Vec3;
  const ax = typeof axis === 'string' && /^[xyz]$/i.test(axis.trim()) ? (axis.trim().toLowerCase() as 'x' | 'y' | 'z') : undefined;
  return {
    id: kebab(typeof id === 'string' && id.trim() ? id : label),
    name: label,
    shape: sh,
    axis: sh === 'cylinder' || sh === 'tube' ? ax ?? guessAxis(size3) : undefined,
    box: { c: centre, s: size3 },
    color: typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color.trim()) ? color.trim().toLowerCase() : NEUTRAL,
    summary: typeof summary === 'string' && summary.trim() ? summary.trim() : `The ${label.toLowerCase()}.`,
  };
}

/**
 * Layers from the front view (layer 0 = nearest the viewer): by the front face, parts within `band`
 * of each other share a layer; a part inside another (its box inside the other's) is always deeper.
 */
export function frontLayers(boxes: Box3[], band: number): number[] {
  const front = boxes.map((b) => b.c[2] + b.s[2] / 2);
  const order = boxes.map((_, i) => i).sort((a, b) => front[b] - front[a]);
  const layer = new Array<number>(boxes.length).fill(0);
  let cur = 0;
  let ref = order.length ? front[order[0]] : 0;
  for (const i of order) {
    if (ref - front[i] > band) {
      cur++;
      ref = front[i];
    }
    layer[i] = cur;
  }
  const inside = (a: Box3, b: Box3) => {
    for (let k = 0; k < 3; k++) {
      if (a.c[k] - a.s[k] / 2 < b.c[k] - b.s[k] / 2 - 0.5 || a.c[k] + a.s[k] / 2 > b.c[k] + b.s[k] / 2 + 0.5) return false;
    }
    return true;
  };
  for (let pass = 0; pass < boxes.length; pass++) {
    let changed = false;
    for (let i = 0; i < boxes.length; i++) {
      for (let j = 0; j < boxes.length; j++) {
        if (i === j || !inside(boxes[i], boxes[j])) continue;
        // equal boxes: the earlier one is the outer one
        if (inside(boxes[j], boxes[i]) && i < j) continue;
        if (layer[i] <= layer[j]) {
          layer[i] = layer[j] + 1;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  const used = [...new Set(layer)].sort((a, b) => a - b);
  return layer.map((l) => used.indexOf(l));
}

/**
 * Claude's compact reply -> a schema-valid solid parts list (or why not). `checkedIds`: objects with a
 * stored, checked list (a match is answered as `checked`, so the client opens that list instead).
 */
export function expandSketch(raw: unknown, opts: { checkedIds?: string[]; fallbackName?: string } = {}): SketchOutcome {
  if (!raw || typeof raw !== 'object') return { kind: 'empty', reason: 'reply was not an object' };
  const o = raw as Record<string, unknown>;
  const objectId = kebab(String(o.id ?? o.object_id ?? opts.fallbackName ?? 'object'));
  const name = String(o.n ?? o.name ?? opts.fallbackName ?? 'Unknown object').trim().slice(0, 80) || 'Unknown object';
  const confRaw = num(o.c ?? o.confidence);
  const confidence = Number.isFinite(confRaw) ? clamp(confRaw, 0, 1) : 0.6;
  if (opts.checkedIds?.includes(objectId)) return { kind: 'checked', object_id: objectId, name, confidence };
  if (UNKNOWN_IDS.has(objectId) || /^(unknown|unclear|unidentified|nothing|no object)\b/i.test(name) || confidence < 0.2) {
    return { kind: 'unknown', object_id: objectId, name, confidence };
  }
  const d = vec(o.d ?? o.dimensions_mm);
  const objMax = d && d.every((n) => n > 0) ? Math.max(...d) : 0;
  // A part is never more than 1.25 x the object's longest side (or 5 m with no object size).
  const limit = objMax > 0 ? clamp(objMax * 1.25, 10, 5000) : 5000;
  const list = Array.isArray(o.p) ? o.p : Array.isArray(o.parts) ? o.parts : [];
  const parts: RawPart[] = [];
  let dropped = 0;
  const seen = new Set<string>();
  for (const v of list) {
    if (parts.length >= SKETCH_MAX_PARTS) {
      dropped++;
      continue;
    }
    const p = readPart(v, limit);
    if (!p) {
      dropped++;
      continue;
    }
    let id = p.id;
    for (let k = 2; seen.has(id); k++) id = `${p.id}-${k}`;
    seen.add(id);
    parts.push({ ...p, id });
  }
  if (parts.length === 0) return { kind: 'empty', reason: `no usable parts (${dropped} dropped)` };

  // Recentre on the assembly, then join floating parts to their neighbours.
  const boxes = parts.map((p) => p.box);
  const u0 = unionBox(boxes);
  for (const b of boxes) for (let k = 0; k < 3; k++) b.c[k] -= u0.c[k];
  const maxDim = Math.max(...u0.s);
  const settled = settleFloating(boxes, Math.max(1, 0.01 * maxDim));
  const u = unionBox(boxes);
  for (const b of boxes) for (let k = 0; k < 3; k++) b.c[k] = Math.round((b.c[k] - u.c[k]) * 10) / 10;
  const [W, H, D] = u.s.map((n) => Math.max(1, n));
  const layers = frontLayers(boxes, Math.max(2, 0.03 * D));

  const out: TeardownPart[] = parts.map((p, i) => {
    const b = boxes[i];
    return {
      id: p.id,
      name: p.name,
      layer: layers[i],
      // front view: x across, y up (image convention: +y down), depth on the width's scale
      size: [clamp(b.s[0] / W, 0.01, 1), clamp(b.s[1] / H, 0.01, 1), clamp(b.s[2] / W, 0.01, 1)],
      offset: [clamp(b.c[0] / W, -0.5, 0.5), clamp(-b.c[1] / H, -0.5, 0.5)],
      shape: p.shape,
      color: p.color,
      summary: p.summary,
      details: p.summary,
      safety: null,
      mesh_url: null,
      size_mm: [b.s[0], b.s[1], b.s[2]],
      position_mm: [b.c[0], b.c[1], b.c[2]],
      ...(p.axis ? { axis: p.axis } : {}),
    };
  });
  const lensParsed = LensSchema.safeParse(o.bio === 1 || o.bio === true ? 'biology' : 'engineering');
  const parsed = TeardownSchema.safeParse({
    object_id: objectId,
    name,
    lens: lensParsed.success ? lensParsed.data : 'engineering',
    anchor: 'box',
    explode_axis: 'z',
    source: 'live',
    layout: 'solid',
    // [width, depth, height] as the schema has it: x, z, y here
    dimensions_mm: [Math.round(W), Math.round(D), Math.round(H)],
    parts: out,
    steps: [],
  });
  if (!parsed.success) return { kind: 'empty', reason: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  return {
    kind: 'solid',
    td: parsed.data,
    confidence,
    summary: typeof o.t === 'string' ? o.t : typeof o.summary === 'string' ? o.summary : `${name}.`,
    dropped,
    settled,
  };
}

/* ---------- details afterwards ---------- */

/** A solid parts list still waiting for its longer text and steps (POST /api/enrich). */
export function needsDetails(td: Pick<Teardown, 'layout' | 'steps'> | null | undefined): boolean {
  return !!td && td.layout === 'solid' && td.steps.length === 0;
}

/** Validate an enrich reply against the parts asked about: only those ids; empty text keeps the summary. */
export function cleanEnrichment(raw: unknown, ids: string[]): EnrichResponse {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const known = new Set(ids);
  const parts: EnrichResponse['parts'] = [];
  const done = new Set<string>();
  for (const v of Array.isArray(o.parts) ? o.parts : []) {
    const p = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    const id = typeof p.id === 'string' ? p.id : '';
    if (!known.has(id) || done.has(id)) continue;
    const details = typeof p.details === 'string' ? p.details.trim() : '';
    if (!details) continue;
    done.add(id);
    parts.push({ id, details, safety: typeof p.safety === 'string' && p.safety.trim() ? p.safety.trim() : null });
  }
  const steps: EnrichResponse['steps'] = [];
  for (const v of Array.isArray(o.steps) ? o.steps : []) {
    const st = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    const text = typeof st.text === 'string' ? st.text.trim() : '';
    if (!text) continue;
    const pids = Array.isArray(st.part_ids) ? st.part_ids.filter((x): x is string => typeof x === 'string' && known.has(x)) : [];
    steps.push({ n: steps.length + 1, text, part_ids: pids });
    if (steps.length >= 8) break;
  }
  return { parts, steps };
}

/** A parts list with an enrich answer merged in (details, safety, steps); the rest unchanged. */
export function mergeEnrichment(td: Teardown, enr: EnrichResponse): Teardown {
  const byId = new Map(enr.parts.map((p) => [p.id, p]));
  return {
    ...td,
    parts: td.parts.map((p) => {
      const e = byId.get(p.id);
      return e ? { ...p, details: e.details, safety: e.safety ?? p.safety ?? null } : p;
    }),
    steps: enr.steps.length > 0 ? enr.steps : td.steps,
  };
}

/**
 * The JSON object in a reply, even one cut short by max_tokens: the text up to the last complete value
 * is closed with the brackets still open, so the parts written before the cut survive. null if none.
 */
export function salvageJson(text: string): unknown {
  const start = text.indexOf('{');
  if (start < 0) return null;
  const stack: string[] = [];
  let inStr = false;
  let lastGood = -1;
  let closeAt = '';
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') {
      stack.pop();
      lastGood = i + 1;
      closeAt = [...stack].reverse().join('');
      if (stack.length === 0) break;
    }
  }
  if (lastGood < 0) return null;
  try {
    return JSON.parse(text.slice(start, lastGood) + closeAt);
  } catch {
    return null;
  }
}
