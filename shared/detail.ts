/**
 * "Detail" (behind `?detail=1`): a small schematic 3D model of one sub-part, mechanism, material or
 * process ("how is the label wrapped onto the bottle", "what is the battery made of"), drawn beside the
 * model on stage while the tutor explains it. Shared by the server (POST /api/detail, which cleans and
 * validates Claude's answer), the browser (src/overlay/DetailStage.tsx draws it) and scripts/predetail.ts.
 *
 * A DetailScene is made of simple primitives in a unit scene (about -1..1 on each axis, x right, y up,
 * z towards the viewer), optional paths that things flow along, a few animations and 2 to 5 spoken steps,
 * each naming the parts that light up while it is said. Every server answer is AI-made (`source: "ai"`) and the
 * app shows it as an "AI sketch", never as checked; only the hand-written test fixture is `"sample"` ("Sample").
 *
 * sanitiseDetail clamps and repairs a reply before the schema check (as expandSketch does for sketches):
 * unknown shapes become boxes, bad parts are dropped (never the whole scene for one), ids become unique
 * kebab-case, references to parts and paths are resolved by id or name, and the whole scene is recentred
 * and scaled to fit the unit box. Pure (no I/O), so scripts can check it on its own.
 */
import { z } from 'zod';
import type { RailsScene } from './rails';

/* ---------- limits ---------- */

export const DETAIL_LIMITS = { parts: 14, paths: 4, animations: 6, steps: 5, pathPoints: 24, flowDots: 40 } as const;

/* ---------- schema ---------- */

const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);
export type DetailVec3 = z.infer<typeof Vec3Schema>;
const HexSchema = z.string().regex(/^#[0-9a-f]{6}$/i);

export const DETAIL_SHAPES = ['box', 'cylinder', 'sphere', 'capsule', 'cone', 'torus', 'sheet', 'tube'] as const;
export const DetailShapeSchema = z.enum(DETAIL_SHAPES);
export type DetailShape = z.infer<typeof DetailShapeSchema>;

export const DetailPartSchema = z.object({
  /** kebab-case, unique within the scene */
  id: z.string().min(1),
  name: z.string().min(1),
  /**
   * Every shape fills `size` (its full extents before rotation), centred on `position`. cylinder, tube,
   * capsule and cone run along their own y axis; sheet is a thin panel in its x-y plane; torus is a ring
   * in its x-y plane (z = the ring's thickness).
   */
  shape: DetailShapeSchema,
  size: Vec3Schema,
  position: Vec3Schema,
  /** degrees about x, y and z (three.js Euler order XYZ) */
  rotation: Vec3Schema,
  color: HexSchema,
  opacity: z.number().min(0.15).max(1),
  /** a few words, optional */
  note: z.string().optional(),
});
export type DetailPart = z.infer<typeof DetailPartSchema>;

export const DetailPathSchema = z.object({
  id: z.string().min(1),
  points: z.array(Vec3Schema).min(2).max(DETAIL_LIMITS.pathPoints),
  closed: z.boolean().optional(),
});
export type DetailPath = z.infer<typeof DetailPathSchema>;

export const DetailAnimationSchema = z.discriminatedUnion('kind', [
  /** turns a part about a scene axis through its centre (rollers, gears, drums); negative rpm turns the other way */
  z.object({ kind: z.literal('spin'), part: z.string(), axis: z.enum(['x', 'y', 'z']), rpm: z.number() }),
  /** moves a part's centre from `from` to `to` in `seconds`: loop = jump back and go again (a conveyor), yoyo = there and back */
  z.object({ kind: z.literal('slide'), part: z.string(), from: Vec3Schema, to: Vec3Schema, seconds: z.number().positive(), mode: z.enum(['loop', 'yoyo']) }),
  /** dots moving along a path (electrons, ions, fluid, light, signals); speed in scene units per second, size = dot diameter */
  z.object({ kind: z.literal('flow'), path: z.string(), count: z.number().int().min(1), speed: z.number(), color: HexSchema, size: z.number().positive() }),
  /** a part that glows and swells a little, once every `seconds` */
  z.object({ kind: z.literal('pulse'), part: z.string(), seconds: z.number().positive() }),
]);
export type DetailAnimation = z.infer<typeof DetailAnimationSchema>;

export const DetailStepSchema = z.object({
  /** one short spoken sentence */
  say: z.string().min(1),
  /** the part ids that light up while it is said */
  focus: z.array(z.string()),
});
export type DetailStep = z.infer<typeof DetailStepSchema>;

export const DetailSceneSchema = z.object({
  title: z.string().min(1),
  /** one sentence */
  summary: z.string().min(1),
  /**
   * ai = made by Claude (every server answer: shown as "AI sketch", never as checked);
   * sample = the hand-written test fixture below (`?detail=mock`: shown as "Sample", never as generated)
   */
  source: z.enum(['ai', 'sample']),
  parts: z.array(DetailPartSchema).min(1).max(DETAIL_LIMITS.parts),
  paths: z.array(DetailPathSchema).max(DETAIL_LIMITS.paths),
  animations: z.array(DetailAnimationSchema).max(DETAIL_LIMITS.animations),
  steps: z.array(DetailStepSchema).min(2).max(DETAIL_LIMITS.steps),
  /** one sentence when the model is simplified */
  caveat: z.string().optional(),
});
export type DetailScene = z.infer<typeof DetailSceneSchema>;

/*
 * A checked "rails" view (shared/rails.ts): a flat comparison written and reviewed by hand, bundled into the
 * app, never sent by the server. Its own kind, so nothing that reads a DetailScene ever gets one.
 */
const RailsPartSchema = z.object({ part_id: z.string().nullable(), label: z.string().min(1), also: z.array(z.string()).optional() });
const RailsRailSchema = z.object({ id: z.enum(['iphone', 'eye']), label: z.string().min(1), object_id: z.string().min(1) });
export const RailsSceneSchema: z.ZodType<RailsScene> = z.object({
  id: z.string().min(1),
  kind: z.literal('rails'),
  title: z.string().min(1),
  summary: z.string().min(1),
  source: z.literal('checked'),
  triggers: z.array(z.string().min(1)).min(1),
  rails: z.tuple([RailsRailSchema, RailsRailSchema]),
  columns: z.array(z.object({ id: z.string().min(1), iphone: RailsPartSchema, eye: RailsPartSchema })).min(1).max(8),
  steps: z.array(z.object({ column: z.string().min(1), say: z.string().min(1) })).min(1).max(DETAIL_LIMITS.steps),
});

/** POST /api/detail */
export const DetailRequestSchema = z.object({
  /** what to model, in a few words: "battery cell discharging", "label wrapping machine" */
  topic: z.string().trim().min(1).max(200),
  /** the name of the model on stage, if any ("MacBook Air 13-inch") */
  object: z.string().trim().max(200).optional(),
  /** the part of that model it is about, if any ("Battery") */
  part: z.string().trim().max(200).optional(),
  /** anything else that helps (the part's one-line summary) */
  context: z.string().trim().max(1000).optional(),
});
export type DetailRequest = z.infer<typeof DetailRequestSchema>;

/** What POST /api/detail adds to a scene: where it came from (no field = generated just now) and how long it took. */
export interface DetailAnswerFlags {
  cached?: 'memory' | 'disk' | 'premade';
  /** with cached "premade": the id of the pre-made topic (docs/detail-topics.json) whose rule matched */
  premade?: string;
  seconds?: number;
}

/* ---------- small helpers ---------- */

const NEUTRAL = '#9aa4ae';
const FLOW_COLOR = '#ffd166';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
const numOr = (v: unknown, fallback: number): number => {
  const n = num(v);
  return Number.isFinite(n) ? n : fallback;
};
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

export function kebab(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'part'
  );
}

/** [x, y, z] from an array (a missing z is 0) or an {x, y, z} object; null when not three finite numbers. */
function vec3(v: unknown): DetailVec3 | null {
  let a: unknown[];
  if (Array.isArray(v)) a = v.length === 2 ? [...v, 0] : v.slice(0, 3);
  else if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    a = [o.x, o.y, o.z ?? 0];
  } else return null;
  if (a.length !== 3) return null;
  const out = a.map(num) as DetailVec3;
  return out.every((n) => Number.isFinite(n)) ? out : null;
}

/** A size may also be one number (a cube or a ball). */
function size3(v: unknown): DetailVec3 | null {
  const n = num(v);
  if (Number.isFinite(n)) return [n, n, n];
  return vec3(v);
}

function hex(v: unknown, fallback: string): string {
  if (typeof v !== 'string') return fallback;
  const s = v.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  const m = s.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/);
  return m ? `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}` : fallback;
}

const SHAPES: Record<string, DetailShape> = {
  box: 'box', cube: 'box', block: 'box', cuboid: 'box', slab: 'box', board: 'box',
  cylinder: 'cylinder', cyl: 'cylinder', disc: 'cylinder', disk: 'cylinder', rod: 'cylinder', roller: 'cylinder', wheel: 'cylinder',
  sphere: 'sphere', sph: 'sphere', ball: 'sphere', ellipsoid: 'sphere', blob: 'sphere',
  capsule: 'capsule', pill: 'capsule',
  cone: 'cone', funnel: 'cone',
  torus: 'torus', ring: 'torus', donut: 'torus', doughnut: 'torus',
  sheet: 'sheet', plane: 'sheet', panel: 'sheet', film: 'sheet', membrane: 'sheet', plate: 'sheet', layer: 'sheet',
  tube: 'tube', pipe: 'tube', sleeve: 'tube', hollow: 'tube',
};

const KINDS: Record<string, DetailAnimation['kind']> = {
  spin: 'spin', rotate: 'spin', rotation: 'spin', turn: 'spin',
  slide: 'slide', move: 'slide', translate: 'slide', oscillate: 'slide', travel: 'slide',
  flow: 'flow', particles: 'flow', dots: 'flow', stream: 'flow',
  pulse: 'pulse', glow: 'pulse', blink: 'pulse', beat: 'pulse', flash: 'pulse',
};

/* ---------- bounds (also the renderer's fit) ---------- */

/** Row-major rotation matrix for Euler angles in degrees, order XYZ (as three.js Matrix4.makeRotationFromEuler). */
export function rotationMatrix(deg: DetailVec3): number[] {
  const [x, y, z] = deg.map((d) => (d * Math.PI) / 180);
  const a = Math.cos(x), b = Math.sin(x), c = Math.cos(y), d = Math.sin(y), e = Math.cos(z), f = Math.sin(z);
  const ae = a * e, af = a * f, be = b * e, bf = b * f;
  return [c * e, -c * f, d, af + be * d, ae - bf * d, -b * c, bf - ae * d, be + af * d, a * c];
}

/** Half-extents along the scene axes of a box `size` turned by `rotation` (degrees). */
export function rotatedHalf(size: DetailVec3, rotation: DetailVec3): DetailVec3 {
  const m = rotationMatrix(rotation);
  const h = size.map((s) => Math.abs(s) / 2);
  return [0, 1, 2].map((i) => Math.abs(m[3 * i]) * h[0] + Math.abs(m[3 * i + 1]) * h[1] + Math.abs(m[3 * i + 2]) * h[2]) as DetailVec3;
}

type BoundsInput = Pick<DetailScene, 'parts' | 'paths' | 'animations'>;

/** Axis-aligned bounds of everything drawn: parts (turned, and at both ends of a slide), path points. */
export function sceneBounds(sc: BoundsInput): { lo: DetailVec3; hi: DetailVec3 } {
  const lo: DetailVec3 = [Infinity, Infinity, Infinity];
  const hi: DetailVec3 = [-Infinity, -Infinity, -Infinity];
  const add = (c: DetailVec3, h: DetailVec3) => {
    for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i], c[i] - h[i]);
      hi[i] = Math.max(hi[i], c[i] + h[i]);
    }
  };
  const halves = new Map<string, DetailVec3>();
  for (const p of sc.parts) {
    const h = rotatedHalf(p.size, p.rotation);
    halves.set(p.id, h);
    add(p.position, h);
  }
  for (const a of sc.animations) {
    if (a.kind !== 'slide') continue;
    const h = halves.get(a.part);
    if (!h) continue;
    add(a.from, h);
    add(a.to, h);
  }
  for (const path of sc.paths) for (const pt of path.points) add(pt, [0, 0, 0]);
  if (!Number.isFinite(lo[0])) return { lo: [-1, -1, -1], hi: [1, 1, 1] };
  return { lo, hi };
}

/** Radius of a sphere round the bounds' centre that holds all of it (for the camera fit). */
export function sceneRadius(sc: BoundsInput): number {
  const { lo, hi } = sceneBounds(sc);
  return Math.max(0.1, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2);
}

/* ---------- sanitise and validate ---------- */

interface Ref {
  byKey: Map<string, string>;
}

function makeRefs(): Ref {
  return { byKey: new Map() };
}
function addRef(r: Ref, id: string, ...aliases: unknown[]) {
  for (const a of [id, ...aliases]) {
    if (typeof a !== 'string' || !a.trim()) continue;
    const k = kebab(a);
    if (!r.byKey.has(k)) r.byKey.set(k, id);
  }
}
function findRef(r: Ref, v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  return r.byKey.get(kebab(v)) ?? null;
}

function uniqueId(raw: string, seen: Set<string>): string {
  const base = kebab(raw);
  let id = base;
  for (let k = 2; seen.has(id); k++) id = `${base}-${k}`;
  seen.add(id);
  return id;
}

/**
 * Claude's reply (or anything) -> an object shaped like a DetailScene, repaired as far as it safely can be.
 * It may still fail DetailSceneSchema (no usable parts, fewer than two steps): parseDetail says why.
 * Returns the number of parts, paths, animations and steps it dropped too.
 */
export function sanitiseDetail(raw: unknown, opts: { topic?: string } = {}): { scene: unknown; dropped: number } {
  const o = rec(raw);
  let dropped = 0;
  const fallbackTitle = opts.topic ? opts.topic.charAt(0).toUpperCase() + opts.topic.slice(1) : 'Detail';

  // parts
  const partRefs = makeRefs();
  const partIds = new Set<string>();
  const parts: DetailPart[] = [];
  for (const v of Array.isArray(o.parts) ? o.parts : []) {
    if (parts.length >= DETAIL_LIMITS.parts) {
      dropped++;
      continue;
    }
    const p = rec(v);
    const name = text(p.name ?? p.n ?? p.id, 48);
    const size = size3(p.size ?? p.s);
    const position = vec3(p.position ?? p.pos ?? p.p) ?? [0, 0, 0];
    if (!name || !size || size.some((n) => !(Math.abs(n) > 0))) {
      dropped++;
      continue;
    }
    const id = uniqueId(typeof p.id === 'string' && p.id.trim() ? p.id : name, partIds);
    addRef(partRefs, id, p.id, name);
    const rot = vec3(p.rotation ?? p.rot) ?? [0, 0, 0];
    const note = text(p.note, 140);
    parts.push({
      id,
      name,
      shape: SHAPES[String(p.shape ?? '').toLowerCase().trim()] ?? 'box',
      // loose limits first; the fit below scales the whole scene into the unit box
      size: size.map((n) => clamp(Math.abs(n), 1e-3, 100)) as DetailVec3,
      position: position.map((n) => clamp(n, -100, 100)) as DetailVec3,
      rotation: rot.map((n) => clamp(n, -360, 360)) as DetailVec3,
      color: hex(p.color ?? p.colour, NEUTRAL),
      opacity: clamp(numOr(p.opacity, 0.6), 0.15, 1),
      ...(note ? { note } : {}),
    });
  }

  // paths
  const pathRefs = makeRefs();
  const pathIds = new Set<string>();
  const paths: DetailPath[] = [];
  for (const v of Array.isArray(o.paths) ? o.paths : []) {
    const p = rec(v);
    const pts = (Array.isArray(p.points) ? p.points : []).map(vec3).filter((x): x is DetailVec3 => x !== null);
    if (paths.length >= DETAIL_LIMITS.paths || pts.length < 2) {
      dropped++;
      continue;
    }
    const id = uniqueId(typeof p.id === 'string' && p.id.trim() ? p.id : `path-${paths.length + 1}`, pathIds);
    addRef(pathRefs, id, p.id, p.name);
    paths.push({
      id,
      points: pts.slice(0, DETAIL_LIMITS.pathPoints).map((pt) => pt.map((n) => clamp(n, -100, 100)) as DetailVec3),
      ...(p.closed === true || p.closed === 'true' || p.loop === true ? { closed: true } : {}),
    });
  }

  // animations: only ones that point at a real part or path
  const partById = new Map(parts.map((p) => [p.id, p]));
  const animations: DetailAnimation[] = [];
  for (const v of Array.isArray(o.animations) ? o.animations : []) {
    const a = rec(v);
    const kind = KINDS[String(a.kind ?? a.type ?? '').toLowerCase().trim()];
    let out: DetailAnimation | null = null;
    if (kind === 'flow') {
      const path = findRef(pathRefs, a.path);
      if (path) {
        out = {
          kind,
          path,
          count: Math.round(clamp(numOr(a.count, 10), 1, DETAIL_LIMITS.flowDots)),
          speed: clamp(Math.abs(numOr(a.speed, 0.4)), 0.02, 50) * (numOr(a.speed, 1) < 0 ? -1 : 1),
          color: hex(a.color ?? a.colour, FLOW_COLOR),
          size: clamp(numOr(a.size, 0.035), 1e-3, 5),
        };
      }
    } else if (kind) {
      const part = findRef(partRefs, a.part);
      const target = part ? partById.get(part) : undefined;
      if (part && target) {
        if (kind === 'spin') {
          const rpm = numOr(a.rpm, 12);
          const axis = String(a.axis ?? 'y').toLowerCase().trim();
          out = { kind, part, axis: axis === 'x' || axis === 'z' ? axis : 'y', rpm: clamp(Math.abs(rpm), 1, 120) * (rpm < 0 ? -1 : 1) };
        } else if (kind === 'slide') {
          const to = vec3(a.to);
          const from = vec3(a.from) ?? target.position;
          const mode = String(a.mode ?? a.repeat ?? 'yoyo').toLowerCase();
          if (to) {
            out = {
              kind,
              part,
              from: from.map((n) => clamp(n, -100, 100)) as DetailVec3,
              to: to.map((n) => clamp(n, -100, 100)) as DetailVec3,
              seconds: clamp(numOr(a.seconds, 3), 0.5, 20),
              mode: mode === 'loop' || mode === 'repeat' || mode === 'restart' ? 'loop' : 'yoyo',
            };
          }
        } else {
          out = { kind, part, seconds: clamp(numOr(a.seconds, 1.2), 0.3, 6) };
        }
      }
    }
    if (!out || animations.length >= DETAIL_LIMITS.animations) {
      dropped++;
      continue;
    }
    animations.push(out);
  }

  // steps: a sentence each, focus resolved to part ids
  const steps: DetailStep[] = [];
  for (const v of Array.isArray(o.steps) ? o.steps : []) {
    const st = rec(v);
    const say = text(st.say ?? st.text, 160);
    if (!say || steps.length >= DETAIL_LIMITS.steps) {
      dropped++;
      continue;
    }
    const rawFocus = Array.isArray(st.focus) ? st.focus : typeof st.focus === 'string' ? [st.focus] : [];
    const focus = [...new Set(rawFocus.map((f) => findRef(partRefs, f)).filter((f): f is string => f !== null))].slice(0, 4);
    steps.push({ say, focus });
  }

  const scene = { parts, paths, animations };
  fitScene(scene);
  const caveat = text(o.caveat, 200);
  return {
    scene: {
      title: text(o.title, 60) || fallbackTitle.slice(0, 60),
      summary: text(o.summary, 220) || `${text(o.title, 60) || fallbackTitle}.`,
      source: 'ai',
      ...scene,
      steps,
      ...(caveat ? { caveat } : {}),
    },
    dropped,
  };
}

/** Recentre and scale everything into the unit box (only when it is far too big or too small), then apply the final limits. Mutates. */
export function fitScene(sc: { parts: DetailPart[]; paths: DetailPath[]; animations: DetailAnimation[] }): void {
  if (sc.parts.length === 0 && sc.paths.length === 0) return;
  const { lo, hi } = sceneBounds(sc);
  const c = [0, 1, 2].map((i) => (lo[i] + hi[i]) / 2) as DetailVec3;
  const half = Math.max(1e-6, ...[0, 1, 2].map((i) => (hi[i] - lo[i]) / 2));
  const k = half > 1 ? 1 / half : half < 0.5 ? 0.9 / half : 1;
  const move = (v: DetailVec3): DetailVec3 => v.map((n, i) => round3(clamp((n - c[i]) * k, -1.2, 1.2))) as DetailVec3;
  for (const p of sc.parts) {
    p.position = move(p.position);
    p.size = p.size.map((n) => round3(clamp(n * k, 0.02, 2.4))) as DetailVec3;
    // a sheet stays thin (its thinnest side, whichever that is) but visible
    if (p.shape === 'sheet') {
      const t = p.size.indexOf(Math.min(...p.size));
      p.size[t] = Math.min(p.size[t], 0.04);
    }
  }
  for (const path of sc.paths) path.points = path.points.map(move);
  for (const a of sc.animations) {
    if (a.kind === 'slide') {
      a.from = move(a.from);
      a.to = move(a.to);
    } else if (a.kind === 'flow') {
      a.speed = round3(clamp(Math.abs(a.speed * k), 0.05, 3) * Math.sign(a.speed || 1));
      a.size = round3(clamp(a.size * k, 0.012, 0.12));
    }
  }
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export type DetailParse = { ok: true; scene: DetailScene; dropped: number } | { ok: false; errors: string };

/** sanitiseDetail, then the schema: the scene, or the first few problems in one line (for the retry prompt). */
export function parseDetail(raw: unknown, opts: { topic?: string } = {}): DetailParse {
  if (!raw || typeof raw !== 'object') return { ok: false, errors: 'the reply was not a JSON object' };
  const { scene, dropped } = sanitiseDetail(raw, opts);
  const parsed = DetailSceneSchema.safeParse(scene);
  if (parsed.success) return { ok: true, scene: parsed.data, dropped };
  return {
    ok: false,
    errors: parsed.error.issues
      .slice(0, 6)
      .map((i) => `${i.path.join('.') || 'scene'}: ${i.message}`)
      .join('; '),
  };
}

/* ---------- animation maths (the renderer calls these every frame) ---------- */

/** A spin's angle in radians after `t` seconds. */
export function spinAngle(t: number, rpm: number): number {
  return ((t * rpm) / 60) * Math.PI * 2;
}

/**
 * How far along a slide is after `t` seconds, 0 (at `from`) to 1 (at `to`): loop = steady from 0 to 1,
 * then back to 0 at once (a conveyor); yoyo = eased there and back, one way per `seconds`.
 */
export function slideFraction(t: number, seconds: number, mode: 'loop' | 'yoyo'): number {
  const s = Math.max(0.05, seconds);
  if (mode === 'loop') {
    const f = (t / s) % 1;
    return f < 0 ? f + 1 : f;
  }
  const phase = ((t / s) % 2 + 2) % 2; // 0..2: there, then back
  return 0.5 - 0.5 * Math.cos(Math.PI * phase);
}

/** A pulse's level after `t` seconds, 0..1, peaking once every `seconds`. */
export function pulseLevel(t: number, seconds: number): number {
  const s = Math.max(0.05, seconds);
  return 0.5 - 0.5 * Math.cos(((t % s) / s) * Math.PI * 2);
}

/**
 * Where each of a flow's dots is after `t` seconds, as fractions 0..1 of the path's length: evenly spaced,
 * moving at `speed` scene units per second (negative = backwards). Writes into `out` (no allocation per frame).
 */
export function flowOffsets(t: number, count: number, speed: number, length: number, out: number[] = []): number[] {
  const n = Math.max(1, Math.round(count));
  const shift = (t * speed) / Math.max(1e-3, length);
  out.length = n;
  for (let i = 0; i < n; i++) {
    const u = (i / n + shift) % 1;
    out[i] = u < 0 ? u + 1 : u;
  }
  return out;
}

/** On an open path dots shrink away near its two ends (so they do not pop from end to start); 1 on a closed one. */
export function flowEndScale(u: number, closed: boolean): number {
  if (closed) return 1;
  const edge = Math.min(u, 1 - u) / 0.08;
  return edge >= 1 ? 1 : Math.max(0, edge);
}

/* ---------- cache keys ---------- */

const FILLER = new Set(['the', 'a', 'an', 'please', 'me', 'show', 'tell', 'about', 'blowfish', 'hey', 'us', 'this', 'that', 'model', 'detail', 'zoom', 'into']);
const STOP = new Set([
  ...FILLER, 'how', 'what', 'why', 'does', 'do', 'is', 'are', 'it', 'its', 'of', 'in', 'on', 'to', 'for', 'with', 'and', 'from',
  'by', 'at', 'inside', 'during', 'my', 'your', 'our', 'their', 'works', 'work', 'working', 'made', 'make', 'look', 'like', 'between', 'onto', 'when', 'which',
]);

/** Plain lowercase words, possessives and punctuation dropped. */
function words(s: string | undefined): string[] {
  return (s ?? '')
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** A crude stem, so "wraps", "wrapping" and "wrapped" meet, and "discharge" and "discharging". */
function stem(w: string): string {
  // "wrapping" -> "wrapp" -> "wrap" (but "falling" stays "fall")
  const undouble = (s: string) => (/([b-df-hj-km-np-rtv-y])\1$/.test(s) ? s.slice(0, -1) : s);
  const noE = (s: string) => (s.length > 4 && s.endsWith('e') ? s.slice(0, -1) : s);
  if (w.length > 5 && w.endsWith('ing')) return undouble(w.slice(0, -3));
  if (w.length > 4 && w.endsWith('ed')) return undouble(w.slice(0, -2));
  if (w.length > 4 && w.endsWith('es') && !w.endsWith('ses')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return noE(w.slice(0, -1));
  return noE(w);
}

/** Two stemmed words are the same word: equal, or one a short extension of the other ("focu" and "focus"). */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  return s.length >= 4 && l.length - s.length <= 2 && l.startsWith(s);
}

/** The words that carry the meaning, stemmed: "How does the eye's lens focus light?" -> eye, len, focus, light. */
export function topicWords(s: string | undefined): Set<string> {
  return new Set(words(s).filter((w) => !STOP.has(w)).map(stem));
}

/** FNV-1a, 32 bits, as base 36: a short stable suffix for long keys. */
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * The cache key for a request: its object, part and topic in plain words (filler such as "the" and "show me"
 * dropped, word order kept), safe as a file name, at most 80 characters. The part is marked ("--p-"), so
 * "how it works" for two parts of one object are two models.
 */
export function detailKey(topic: string, object?: string, part?: string): string {
  const t = words(topic).filter((w) => !FILLER.has(w)).join('-') || 'topic';
  const ob = words(object).join('-');
  const pt = words(part).join('-');
  const full = [ob, pt ? `p-${pt}` : '', t].filter(Boolean).join('--');
  return full.length <= 80 ? full : `${full.slice(0, 72).replace(/-+$/, '')}-${shortHash(full)}`;
}

/**
 * One pre-made topic (docs/detail-topics.json): generated ahead by npm run predetail so it opens at once.
 * `topic` and `object` make its cache key (detailKey), so they must not change once it is made.
 * `objects`, `any` and `none` are its hand-written match rule (premadeMatch); a topic without `any` is
 * only ever found by its exact key.
 */
export interface PremadeTopic {
  /** a short name, for logs and the answer's `premade` field ("battery") */
  id: string;
  topic: string;
  object?: string;
  /**
   * When a model is open: at least one of these must be in its name or the asked part's name ("MacBook Air
   * 13-inch" has "macbook", a part "Battery" has "battery"). With nothing open this is not checked. Leave it
   * out for a topic that fits any open model.
   */
  objects?: string[];
  /** at least one entry of EVERY group must be in the request's topic + part; an entry of several words ("flex cable") needs all of them */
  any?: string[][];
  /** none of these may be in the request's topic + part */
  none?: string[];
}

/**
 * The stemmed words of a request, for the pre-made rules. Unlike topicWords every word is kept (a rule only
 * names words that matter), except "made" in "made of" / "made from" / "made out of": that asks what it is
 * made of, not how it is made, so "what is the battery made of" is not caught by a rule's "made".
 */
function ruleWords(s: string | undefined): string[] {
  const ws = words(s);
  const out: string[] = [];
  for (let i = 0; i < ws.length; i++) {
    if (ws[i] === 'made' && (ws[i + 1] === 'of' || ws[i + 1] === 'from' || ws[i + 1] === 'out')) continue;
    out.push(stem(ws[i]));
  }
  return out;
}

/**
 * Two stems are the same word for a rule: equal, or one longer by a single letter ("focu" and "focus").
 * Stricter than sameWord, so "flex" is not "flexor"; a rule lists the other forms it means.
 */
function ruleSame(a: string, b: string): boolean {
  if (a === b) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  return s.length >= 4 && l.length - s.length === 1 && l.startsWith(s);
}

/** An entry of a rule ("ribbon", or "flex cable": every word) is in the words, compared as stems. */
function hasEntry(have: string[], entry: string): boolean {
  const need = words(entry).map(stem);
  return need.length > 0 && need.every((w) => have.some((h) => ruleSame(h, w)));
}

/**
 * Whether a request matches one pre-made topic's rule: its `objects` (only when a model is open), every
 * `any` group and no `none` word. `objectMatched` = it has an objects rule and one of those words was
 * found (used to break a tie between two topics).
 */
export function premadeMatch(req: Pick<DetailRequest, 'topic' | 'object' | 'part'>, p: PremadeTopic): { ok: boolean; objectMatched: boolean } {
  const no = { ok: false, objectMatched: false };
  if (!p.any || p.any.length === 0) return no;
  const asked = ruleWords(`${req.topic} ${req.part ?? ''}`);
  if ((p.none ?? []).some((w) => hasEntry(asked, w))) return no;
  if (!p.any.every((group) => group.some((w) => hasEntry(asked, w)))) return no;
  let objectMatched = false;
  if (p.objects && p.objects.length > 0) {
    const about = [...ruleWords(req.object), ...ruleWords(req.part)];
    objectMatched = p.objects.some((w) => hasEntry(about, w));
    // a different kind of model is open (an iPhone's lens is not the eye's)
    if (!objectMatched && (req.object ?? '').trim()) return no;
  }
  return { ok: true, objectMatched };
}

/**
 * The pre-made topic for a request, or null. Used only when the exact key misses. A request gets a
 * pre-made topic only when exactly one rule matches; if several do, the one whose objects rule matched,
 * if that is just one; otherwise none (the request is then made live). So "battery charging" never gets the
 * discharge model, "palisade mesophyll" never the spongy one: each rule's `none` words say what it is not.
 */
export function bestPremade(req: Pick<DetailRequest, 'topic' | 'object' | 'part'>, list: PremadeTopic[]): PremadeTopic | null {
  const hits = list.map((p) => ({ p, m: premadeMatch(req, p) })).filter((h) => h.m.ok);
  if (hits.length === 1) return hits[0].p;
  const byObject = hits.filter((h) => h.m.objectMatched);
  return byObject.length === 1 ? byObject[0].p : null;
}

/* ---------- test fixture ---------- */

/**
 * A hand-written TEST FIXTURE, not an AI answer: `?detail=mock` shows it for every request (no server call)
 * and the Node checks use it. Its title says "Sample:" so it is never mistaken for a generated model.
 * Physics as the prompt asks: discharging, electrons go from the anode through the outer wire and the load to
 * the cathode; lithium ions cross the electrolyte and the separator inside the cell, also anode to cathode.
 */
export const SAMPLE_DETAIL: DetailScene = {
  title: 'Sample: lithium-ion cell discharging',
  summary: 'One layer of a lithium-ion cell powering a small load.',
  source: 'sample',
  parts: [
    { id: 'anode-collector', name: 'Copper foil', shape: 'sheet', size: [0.04, 1.2, 0.8], position: [-0.78, -0.2, 0], rotation: [0, 0, 0], color: '#c77b4a', opacity: 0.85 },
    { id: 'anode', name: 'Graphite anode', shape: 'box', size: [0.36, 1.2, 0.8], position: [-0.56, -0.2, 0], rotation: [0, 0, 0], color: '#3d4148', opacity: 0.8 },
    { id: 'electrolyte', name: 'Electrolyte', shape: 'box', size: [0.4, 1.2, 0.8], position: [0, -0.2, 0], rotation: [0, 0, 0], color: '#9fd3ff', opacity: 0.2 },
    { id: 'separator', name: 'Separator', shape: 'sheet', size: [0.8, 1.2, 0.02], position: [0, -0.2, 0], rotation: [0, 90, 0], color: '#f2f2f2', opacity: 0.45 },
    { id: 'cathode', name: 'Metal oxide cathode', shape: 'box', size: [0.36, 1.2, 0.8], position: [0.56, -0.2, 0], rotation: [0, 0, 0], color: '#5b6f8f', opacity: 0.8 },
    { id: 'cathode-collector', name: 'Aluminium foil', shape: 'sheet', size: [0.04, 1.2, 0.8], position: [0.78, -0.2, 0], rotation: [0, 0, 0], color: '#c9ced6', opacity: 0.85 },
    { id: 'load', name: 'Load', shape: 'sphere', size: [0.22, 0.22, 0.22], position: [0, 0.78, 0], rotation: [0, 0, 0], color: '#ffe08a', opacity: 0.7 },
  ],
  paths: [
    { id: 'outer-circuit', points: [[-0.78, 0.4, 0], [-0.78, 0.78, 0], [-0.11, 0.78, 0], [0.11, 0.78, 0], [0.78, 0.78, 0], [0.78, 0.4, 0]] },
    { id: 'ion-path', points: [[-0.4, -0.1, 0.2], [-0.15, -0.15, 0.2], [0.15, -0.25, 0.2], [0.4, -0.3, 0.2]] },
  ],
  animations: [
    { kind: 'flow', path: 'outer-circuit', count: 12, speed: 0.35, color: '#ffd166', size: 0.04 },
    { kind: 'flow', path: 'ion-path', count: 6, speed: 0.12, color: '#b388ff', size: 0.05 },
    { kind: 'pulse', part: 'load', seconds: 1.4 },
  ],
  steps: [
    { say: 'The graphite anode holds lithium between its carbon layers.', focus: ['anode'] },
    { say: 'Electrons leave the anode through the outer wire and power the load.', focus: ['anode-collector', 'load', 'cathode-collector'] },
    { say: 'Inside, lithium ions cross the electrolyte and the separator.', focus: ['electrolyte', 'separator'] },
    { say: 'Both meet again in the metal oxide cathode.', focus: ['cathode'] },
  ],
  caveat: 'A sample made by hand for testing, not generated.',
};
