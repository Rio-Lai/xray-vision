/**
 * Faces -> eyes as scene objects (#94: "analyse the eye").
 *
 * The MediaPipe face landmarker gives 478 landmarks per face (with the irises), 52 blendshapes and
 * a head transform. From them, per face:
 *  - two eye boxes from the eye-contour and iris landmarks (padded, smoothed), published as scene
 *    objects with `anchor: 'face'` and label `eye`: ids `eye-left` / `eye-right` (the person's left
 *    and right) for the first face, `eye-left-2` / `eye-right-2` for a second one;
 *  - the face outline (a box round all its landmarks), used only for focus (engine.ts): looking at a
 *    face makes its nearer eye "this" even though an eye box is small. The face itself is never a
 *    scene object and has no label, and nothing here identifies anyone; no image is kept;
 *  - per eye, open or closed and where it is looking, for the get_pose voice tool.
 *
 * Which eye is the person's left: the camera is not mirrored (handTuning.swapHandedness, as for
 * hands), so the eye on the image's left is the person's right; `?hands=raw` (a mirrored camera)
 * flips both. Open or closed comes from the eye's own lid gap (per eye, so a wink is seen) together
 * with the two blink blendshapes; left and right gaze from where each iris sits between its eye
 * corners, up and down from the look-up / look-down blendshapes (averaged over both eyes, so it does
 * not matter which side MediaPipe calls left).
 *
 * The landmarker runs on a square crop of the middle of the frame (engine.ts), so a face one to two
 * metres away is big enough for its detector; landmarks are mapped back to the full frame here.
 */
import type { Box, SceneObject } from '../state/store';
import { handTuning } from './handTracker';

export type Gaze = 'left' | 'right' | 'up' | 'down' | 'centre';
export type EyeSide = 'left' | 'right';

interface Pt {
  x: number;
  y: number;
}

/** One eye as measured in one frame (frame-normalised boxes). */
export interface EyeMeasure {
  box: Box;
  /** 0 = wide open, 1 = shut */
  closed: number;
  /** iris offset from the middle of the eye, in eye widths, + = towards the image's right */
  gazeX: number;
}

/** One face as measured in one frame: from landmarks (measureFace) or made up (?mock=eye). */
export interface FaceMeasure {
  /** box round the whole face, frame-normalised */
  outline: Box;
  eyes: Record<EyeSide, EyeMeasure>;
  /** look-up / look-down blendshapes, averaged over both eyes (0..1) */
  up: number;
  down: number;
  /** head turn from the transform matrix, degrees (raw, for the debug panel), or null */
  headYaw: number | null;
  headPitch: number | null;
  score: number;
}

export interface EyeView {
  id: string;
  side: EyeSide;
  box: Box;
  open: boolean;
  looking: Gaze;
}

export interface FaceView {
  /** 1 for the first face, 2 for a second one */
  slot: number;
  outline: Box;
  eyes: EyeView[];
  headYaw: number | null;
  headPitch: number | null;
  score: number;
}

/* ------------------------------ landmark indices ------------------------------ */

/** Eye contours (16 points each) and irises (centre first) of the 478-point face mesh. */
const EYE_A = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
const IRIS_A = [468, 469, 470, 471, 472];
const EYE_B = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466];
const IRIS_B = [473, 474, 475, 476, 477];
/** corners (outer, inner) and lids (upper, lower) */
const CORNERS_A: [number, number] = [33, 133];
const LIDS_A: [number, number] = [159, 145];
const CORNERS_B: [number, number] = [263, 362];
const LIDS_B: [number, number] = [386, 374];

/* ---------------------------------- tuning ---------------------------------- */

/** Eye box: this many eye widths across, and at least this many eye widths tall. */
const EYE_BOX_W = 1.35;
const EYE_BOX_MIN_H = 0.75;
/** ...and the lid-to-lid height times this. */
const EYE_BOX_H = 1.6;
/** Face outline padding (fraction of its size, each side): looking near a face still counts. */
const OUTLINE_PAD = 0.1;
/** Lid gap / eye width: about 0.3 open, under 0.12 shut. */
const EAR_OPEN = 0.24;
const EAR_SHUT = 0.12;
/** closed >= this: the eye counts as closed. */
const CLOSED_AT = 0.55;
/** Iris offset (eye widths) that counts as looking to a side. */
const GAZE_X = 0.07;
/** Look-up / look-down blendshape that counts as looking up / down. */
const GAZE_UP = 0.35;
const GAZE_DOWN = 0.4;
/** Smoothing per update (the landmarker runs every few frames). */
const BOX_ALPHA = 0.5;
const VALUE_ALPHA = 0.5;
/** A face is dropped after this long unseen. */
const DROP_AFTER_MS = 600;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/* ------------------------------- measuring ------------------------------- */

/** Blendshape scores by name from one face's result. */
export function blendshapeMap(cats: { categoryName?: string; displayName?: string; score?: number }[] | undefined): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of cats ?? []) {
    const n = c.categoryName || c.displayName;
    if (n) m.set(n, c.score ?? 0);
  }
  return m;
}

function bounds(pts: Pt[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { x0, y0, x1, y1 };
}

/** px <-> frame-normalised */
const toPx = (p: Pt, fw: number, fh: number): Pt => ({ x: p.x * fw, y: p.y * fh });

function measureEye(lm: Pt[], contour: number[], iris: number[], corners: [number, number], lids: [number, number], fw: number, fh: number): EyeMeasure & { cx: number } {
  const pts = contour.map((i) => toPx(lm[i], fw, fh));
  const hasIris = lm.length > iris[iris.length - 1];
  if (hasIris) for (const i of iris) pts.push(toPx(lm[i], fw, fh));
  const b = bounds(pts);
  const outer = toPx(lm[corners[0]], fw, fh);
  const inner = toPx(lm[corners[1]], fw, fh);
  const width = Math.max(1e-6, Math.hypot(outer.x - inner.x, outer.y - inner.y));
  const upper = toPx(lm[lids[0]], fw, fh);
  const lower = toPx(lm[lids[1]], fw, fh);
  const ear = Math.hypot(upper.x - lower.x, upper.y - lower.y) / width;
  const cx = (b.x0 + b.x1) / 2;
  const cy = (b.y0 + b.y1) / 2;
  const halfW = (Math.max(b.x1 - b.x0, width) * EYE_BOX_W) / 2;
  const halfH = Math.max(((b.y1 - b.y0) * EYE_BOX_H) / 2, (width * EYE_BOX_MIN_H) / 2);
  let gazeX = 0;
  if (hasIris) {
    const c = toPx(lm[iris[0]], fw, fh);
    const left = outer.x < inner.x ? outer : inner;
    const right = outer.x < inner.x ? inner : outer;
    gazeX = (c.x - (left.x + right.x) / 2) / Math.max(1e-6, right.x - left.x);
  }
  return {
    cx,
    box: { x: (cx - halfW) / fw, y: (cy - halfH) / fh, w: (2 * halfW) / fw, h: (2 * halfH) / fh },
    closed: clamp01((EAR_OPEN - ear) / (EAR_OPEN - EAR_SHUT)),
    gazeX,
  };
}

/** Head yaw / pitch (degrees) from MediaPipe's column-major 4x4 face transform, or null. */
function headAngles(m: number[] | undefined): { yaw: number | null; pitch: number | null } {
  if (!m || m.length < 16) return { yaw: null, pitch: null };
  // column-major: r(row, col) = m[col * 4 + row]; the face's forward axis is its third column
  const fx = m[8];
  const fy = m[9];
  const fz = m[10];
  const deg = 180 / Math.PI;
  return { yaw: Math.atan2(fx, fz) * deg, pitch: Math.atan2(-fy, Math.hypot(fx, fz)) * deg };
}

/**
 * One face from its landmarks (frame-normalised), blendshapes and transform. `fw` / `fh` are the
 * frame size in px (for aspect-correct boxes).
 */
export function measureFace(lm: Pt[], shapes: Map<string, number>, matrix: number[] | undefined, fw: number, fh: number, score: number): FaceMeasure | null {
  if (lm.length < 468) return null;
  const a = measureEye(lm, EYE_A, IRIS_A, CORNERS_A, LIDS_A, fw, fh);
  const b = measureEye(lm, EYE_B, IRIS_B, CORNERS_B, LIDS_B, fw, fh);
  // The eye on the image's left is the person's right (camera not mirrored); ?hands=raw flips it.
  const aOnLeft = a.cx <= b.cx;
  const personRightIsA = handTuning.swapHandedness ? aOnLeft : !aOnLeft;
  const right = personRightIsA ? a : b;
  const left = personRightIsA ? b : a;
  // Both blink blendshapes high = both shut; a wink shows in that eye's own lid gap.
  const blink = Math.min(shapes.get('eyeBlinkLeft') ?? 0, shapes.get('eyeBlinkRight') ?? 0);
  const closedOf = (e: EyeMeasure) => clamp01(Math.max(e.closed, blink * 0.5 + e.closed * 0.5, blink >= 0.6 ? blink : 0));
  const f = bounds(lm);
  const pw = (f.x1 - f.x0) * OUTLINE_PAD;
  const ph = (f.y1 - f.y0) * OUTLINE_PAD;
  const x0 = clamp01(f.x0 - pw);
  const y0 = clamp01(f.y0 - ph);
  const head = headAngles(matrix);
  const avg = (k1: string, k2: string) => ((shapes.get(k1) ?? 0) + (shapes.get(k2) ?? 0)) / 2;
  return {
    outline: { x: x0, y: y0, w: clamp01(f.x1 + pw) - x0, h: clamp01(f.y1 + ph) - y0 },
    eyes: {
      left: { box: left.box, closed: closedOf(left), gazeX: left.gazeX },
      right: { box: right.box, closed: closedOf(right), gazeX: right.gazeX },
    },
    up: avg('eyeLookUpLeft', 'eyeLookUpRight'),
    down: avg('eyeLookDownLeft', 'eyeLookDownRight'),
    headYaw: head.yaw,
    headPitch: head.pitch,
    score,
  };
}

/**
 * Where an eye is looking, in the person's own terms (their left, as for "Left eye"). Up and down
 * win when strong (a person reading a laptop looks down); otherwise the iris position decides.
 */
export function gazeOf(gazeX: number, up: number, down: number): Gaze {
  if (down >= GAZE_DOWN && down >= up) return 'down';
  if (up >= GAZE_UP) return 'up';
  // + = iris towards the image's right = the person's left (camera not mirrored; ?hands=raw flips it)
  const towardsImageRight = gazeX >= GAZE_X;
  const towardsImageLeft = gazeX <= -GAZE_X;
  if (!towardsImageRight && !towardsImageLeft) return 'centre';
  const personLeft = handTuning.swapHandedness ? towardsImageRight : towardsImageLeft;
  return personLeft ? 'left' : 'right';
}

/* -------------------------------- tracking -------------------------------- */

interface EyeTrack {
  box: Box;
  closed: number;
  gazeX: number;
}

interface FaceTrack {
  slot: number;
  outline: Box;
  eyes: Record<EyeSide, EyeTrack>;
  up: number;
  down: number;
  headYaw: number | null;
  headPitch: number | null;
  score: number;
  lastSeen: number;
}

function lerpBox(a: Box, b: Box, t: number): Box {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, w: a.w + (b.w - a.w) * t, h: a.h + (b.h - a.h) * t };
}

const centreOf = (b: Box): Pt => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/** Scene object id of a face's eye: "eye-left", "eye-right", then "eye-left-2", ... */
export function eyeId(slot: number, side: EyeSide): string {
  return slot <= 1 ? `eye-${side}` : `eye-${side}-${slot}`;
}

/** True for the scene ids this module publishes. */
export function isEyeObjectId(id: string | null | undefined): boolean {
  return !!id && /^eye-(left|right)(-\d+)?$/.test(id);
}

/** For focus (engine.ts): a face's outline and its two eye ids. */
export interface FaceFocus {
  outline: Box;
  eyeIds: string[];
}

export class FaceTracker {
  private tracks: FaceTrack[] = [];

  /** New measurements (any number of faces; the landmarker gives at most two). */
  update(faces: FaceMeasure[], now: number): void {
    const used = new Set<FaceTrack>();
    // Match each face to the nearest track (by outline centre, within half a face width).
    for (const f of faces) {
      const c = centreOf(f.outline);
      let best: FaceTrack | null = null;
      let bestD = Infinity;
      for (const t of this.tracks) {
        if (used.has(t)) continue;
        const tc = centreOf(t.outline);
        const d = Math.hypot(c.x - tc.x, c.y - tc.y);
        if (d < bestD && d < Math.max(t.outline.w, f.outline.w) * 0.5) {
          bestD = d;
          best = t;
        }
      }
      if (best) {
        used.add(best);
        best.outline = lerpBox(best.outline, f.outline, BOX_ALPHA);
        for (const side of ['left', 'right'] as EyeSide[]) {
          const e = best.eyes[side];
          const m = f.eyes[side];
          e.box = lerpBox(e.box, m.box, BOX_ALPHA);
          e.closed += (m.closed - e.closed) * VALUE_ALPHA;
          e.gazeX += (m.gazeX - e.gazeX) * VALUE_ALPHA;
        }
        best.up += (f.up - best.up) * VALUE_ALPHA;
        best.down += (f.down - best.down) * VALUE_ALPHA;
        best.headYaw = f.headYaw;
        best.headPitch = f.headPitch;
        best.score += (f.score - best.score) * 0.4;
        best.lastSeen = now;
      } else {
        const t: FaceTrack = {
          slot: this.nextSlot(),
          outline: { ...f.outline },
          eyes: {
            left: { box: { ...f.eyes.left.box }, closed: f.eyes.left.closed, gazeX: f.eyes.left.gazeX },
            right: { box: { ...f.eyes.right.box }, closed: f.eyes.right.closed, gazeX: f.eyes.right.gazeX },
          },
          up: f.up,
          down: f.down,
          headYaw: f.headYaw,
          headPitch: f.headPitch,
          score: f.score,
          lastSeen: now,
        };
        this.tracks.push(t);
        used.add(t);
      }
    }
    this.prune(now);
  }

  prune(now: number): void {
    this.tracks = this.tracks.filter((t) => now - t.lastSeen <= DROP_AFTER_MS);
  }

  clear(): void {
    this.tracks = [];
  }

  get count(): number {
    return this.tracks.length;
  }

  /** Faces with their eyes (open, gaze), first face first. */
  views(): FaceView[] {
    return [...this.tracks]
      .sort((a, b) => a.slot - b.slot)
      .map((t) => ({
        slot: t.slot,
        outline: { ...t.outline },
        eyes: (['left', 'right'] as EyeSide[]).map((side) => ({
          id: eyeId(t.slot, side),
          side,
          box: { ...t.eyes[side].box },
          open: t.eyes[side].closed < CLOSED_AT,
          looking: gazeOf(t.eyes[side].gazeX, t.up, t.down),
        })),
        headYaw: t.headYaw,
        headPitch: t.headPitch,
        score: t.score,
      }));
  }

  /** Eyes as scene objects: label "eye", anchor "face". Nothing for the face itself. */
  sceneObjects(): SceneObject[] {
    const out: SceneObject[] = [];
    for (const t of this.tracks) {
      for (const side of ['left', 'right'] as EyeSide[]) {
        out.push({
          id: eyeId(t.slot, side),
          label: 'eye',
          confidence: t.score,
          box: { ...t.eyes[side].box },
          lens: 'biology',
          anchor: 'face',
        });
      }
    }
    return out;
  }

  /** Face outlines with their eye ids, for focus. */
  focusFaces(): FaceFocus[] {
    return this.tracks.map((t) => ({ outline: { ...t.outline }, eyeIds: [eyeId(t.slot, 'left'), eyeId(t.slot, 'right')] }));
  }

  private nextSlot(): number {
    let n = 1;
    while (this.tracks.some((t) => t.slot === n)) n += 1;
    return n;
  }
}

/* ------------------------------ for get_pose ------------------------------ */

const GAZE_WORDS: Record<Gaze, string> = {
  left: 'to their left (your right)',
  right: 'to their right (your left)',
  up: 'up',
  down: 'down',
  centre: 'straight ahead',
};

/**
 * The `eyes` field of get_pose: the face whose eye is focused or selected, else the first face.
 * null when no face is tracked.
 */
export function describeEyes(
  faces: FaceView[],
  focusedId: string | null,
  selectedId: string | null,
): { left: { open: boolean; looking: Gaze }; right: { open: boolean; looking: Gaze }; note: string } | null {
  if (faces.length === 0) return null;
  const face = faces.find((f) => f.eyes.some((e) => e.id === focusedId || e.id === selectedId)) ?? faces[0];
  const l = face.eyes.find((e) => e.side === 'left');
  const r = face.eyes.find((e) => e.side === 'right');
  if (!l || !r) return null;
  let note: string;
  if (!l.open && !r.open) note = 'Both eyes are closed right now (a blink, or eyes shut).';
  else if (l.open && r.open && l.looking === r.looking) note = `Both eyes are open and looking ${GAZE_WORDS[l.looking]}.`;
  else if (l.open && r.open) note = `Both eyes are open; the left eye is looking ${GAZE_WORDS[l.looking]} and the right eye ${GAZE_WORDS[r.looking]}.`;
  else {
    const open = l.open ? l : r;
    note = `The ${l.open ? 'right' : 'left'} eye is closed and the ${open.side} eye is open, looking ${GAZE_WORDS[open.looking]}.`;
  }
  return { left: { open: l.open, looking: l.looking }, right: { open: r.open, looking: r.looking }, note };
}
