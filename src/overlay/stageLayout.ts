/**
 * Stage mode (the model floating in the middle of the view): where each part of a box-anchored
 * teardown sits in the model's own frame, assembled and exploded, and how big the model may be
 * drawn. Pure maths (no three.js) so it can be checked on its own.
 *
 * Model frame = the camera's view of the object from above, as in explodeLayout: x right, y up the
 * image (the far side of the object), z towards the camera (the object's "up"). The object's box is
 * W x H model units.
 *  - Each part keeps its place in the box (part.offset; image +y is down, flipped here), lying flat.
 *  - Layers are stacked along z, layer 0 on top (nearest the camera), each layer as thick as its
 *    thickest part (but at most STACK_STEP_MAX of the width: round parts, whose depth is their
 *    diameter, and nested parts such as an eye's shells overlap instead of making a tower), so
 *    at explode 0 the parts form one solid object.
 *  - Exploding, layer r lifts by (deepest rank - r) * stageGap(e): at the "analyse" amount (0.12)
 *    the layers are just apart (thin gaps); at 1 they are spread out like an exploded drawing.
 *    Objects with more than 5 layers get proportionally smaller gaps (same total height).
 *    Parts of one layer that overlap (live parts lists often put several on one spot) are pushed
 *    apart as the layer explodes.
 *  - The stack is centred on z = 0 and the box centre on x = y = 0: the model turns about its middle.
 */
import type { TeardownPart } from '../../shared/teardown';
import { PART_GAP, partDims } from './explodeLayout';

/** Gap between neighbouring layers at full explode, as a fraction of the object's box height. */
export const LAYER_LIFT = 0.46;
/** Most a layer adds to the assembled stack's height, as a fraction of the object's width. */
export const STACK_STEP_MAX = 0.04;
/** The total explode height is that of this many gaps, however many layers there are. */
const GAP_BUDGET = 4;
/** gap(e) = LAYER_LIFT * H * e^GAP_POWER: about 2.5% of H at e = 0.12 (thin), all of it at 1. */
export const GAP_POWER = 1.4;
/** Seen from this far above the object's plane when on stage (radians from horizontal), before pitch. */
export const STAGE_ELEVATION = (30 * Math.PI) / 180;

export interface StagePart {
  /** assembled centre (model units, y up) */
  ax: number;
  ay: number;
  /** exploded centre within its layer (pushed apart from overlapping neighbours) */
  px: number;
  py: number;
  /** box size: width (x), height (y, in the object's plane), depth / thickness (z) */
  w: number;
  h: number;
  d: number;
  round: boolean;
  /** 0 = outermost layer */
  rank: number;
}

export interface StageLayout {
  parts: StagePart[];
  /** what each layer rank adds to the assembled stack (its thickest part, capped) */
  thick: number[];
  /** gap scale for many-layer objects (1 for up to GAP_BUDGET + 1 layers) */
  gapScale: number;
  ranks: number;
  /** distance from the turning axis to the furthest corner of any part (assembled or exploded) */
  radius: number;
  W: number;
  H: number;
}

export function stageLayout(parts: TeardownPart[], rankOf: (layer: number) => number, ranks: number, W: number, H: number): StageLayout {
  const n = Math.max(1, ranks);
  const out: StagePart[] = parts.map((part) => {
    const { w, h, d, round } = partDims(part, W, H);
    const ax = part.offset[0] * W;
    const ay = -part.offset[1] * H;
    const rank = Math.min(n - 1, Math.max(0, rankOf(part.layer)));
    return { ax, ay, px: ax, py: ay, w, h, d, round, rank };
  });
  // Push apart overlapping parts of one layer, top to bottom of the image (as explodeLayout does).
  const minGap = PART_GAP * H;
  for (let r = 0; r < n; r++) {
    const idx = out.map((_, i) => i).filter((i) => out[i].rank === r);
    idx.sort((a, b) => out[b].py - out[a].py);
    for (let k = 1; k < idx.length; k++) {
      const p = out[idx[k]];
      for (let j = 0; j < k; j++) {
        const q = out[idx[j]];
        const crossOverlap = Math.min(p.px + p.w / 2, q.px + q.w / 2) - Math.max(p.px - p.w / 2, q.px - q.w / 2);
        if (crossOverlap > 0) p.py = Math.min(p.py, q.py - q.h / 2 - minGap - p.h / 2);
      }
    }
  }
  // Re-centre the pushed-apart layers on the box centre, so a layer that grew stays balanced.
  for (let r = 0; r < n; r++) {
    const idx = out.map((_, i) => i).filter((i) => out[i].rank === r);
    if (idx.length < 2) continue;
    const loA = Math.min(...idx.map((i) => out[i].ay - out[i].h / 2));
    const hiA = Math.max(...idx.map((i) => out[i].ay + out[i].h / 2));
    const loP = Math.min(...idx.map((i) => out[i].py - out[i].h / 2));
    const hiP = Math.max(...idx.map((i) => out[i].py + out[i].h / 2));
    const shift = (loA + hiA) / 2 - (loP + hiP) / 2;
    for (const i of idx) out[i].py += shift;
  }
  const thick: number[] = new Array(n).fill(0);
  const stepMax = STACK_STEP_MAX * W;
  for (const p of out) thick[p.rank] = Math.max(thick[p.rank], Math.min(p.d, stepMax));
  let radius = 1;
  for (const p of out) {
    radius = Math.max(
      radius,
      Math.hypot(Math.abs(p.ax) + p.w / 2, Math.abs(p.ay) + p.h / 2),
      Math.hypot(Math.abs(p.px) + p.w / 2, Math.abs(p.py) + p.h / 2),
    );
  }
  return { parts: out, thick, gapScale: Math.min(1, GAP_BUDGET / Math.max(1, n - 1)), ranks: n, radius, W, H };
}

/** Gap between neighbouring layers for an explode amount (model units). */
export function stageGap(e: number, H: number): number {
  return LAYER_LIFT * H * Math.pow(Math.max(0, e), GAP_POWER);
}

export interface StageStack {
  /** centre z of each part (same order as layout.parts), stack centred on 0 */
  z: number[];
  /** z of the highest and the lowest point of any part */
  top: number;
  bottom: number;
}

/** Per-part z for per-layer explode amounts `eOfRank(rank)`. */
export function stageStack(layout: StageLayout, eOfRank: (rank: number) => number): StageStack {
  const n = layout.ranks;
  const centre: number[] = new Array(n).fill(0);
  let acc = 0;
  for (let r = 0; r < n; r++) {
    const t = layout.thick[r];
    centre[r] = -acc - t / 2;
    acc += t;
  }
  const lift: number[] = new Array(n).fill(0);
  for (let r = 0; r < n; r++) lift[r] = (n - 1 - r) * layout.gapScale * stageGap(eOfRank(r), layout.H);
  let top = -Infinity;
  let bottom = Infinity;
  for (const p of layout.parts) {
    const zc = centre[p.rank] + lift[p.rank];
    top = Math.max(top, zc + p.d / 2);
    bottom = Math.min(bottom, zc - p.d / 2);
  }
  if (!Number.isFinite(top) || !Number.isFinite(bottom)) {
    top = 0;
    bottom = 0;
  }
  const mid = (top + bottom) / 2;
  const z = layout.parts.map((p) => centre[p.rank] + lift[p.rank] - mid);
  return { z, top: top - mid, bottom: bottom - mid };
}

/**
 * Largest scale (px per model unit) at which the model fits a w x h screen area whatever its yaw:
 * its footprint is a disc of `radius`, seen from `elevation` above, plus the stack's height.
 */
export function stageFit(radius: number, stackHeight: number, elevation: number, w: number, h: number): number {
  const el = Math.min(Math.PI / 2, Math.max(0, Math.abs(elevation)));
  const sw = 2 * radius;
  const sh = 2 * radius * Math.sin(el) + stackHeight * Math.cos(el);
  return Math.max(1e-4, Math.min(w / Math.max(1e-6, sw), h / Math.max(1e-6, sh)));
}

/**
 * One step of a critically damped spring (no overshoot) towards `goal`; returns [x, v].
 * omega in rad/s: about 97% of the way after 4.7 / omega seconds.
 */
export function springStep(x: number, v: number, goal: number, omega: number, dt: number): [number, number] {
  let remaining = Math.min(0.1, Math.max(0, dt));
  while (remaining > 1e-6) {
    const h = Math.min(remaining, 1 / 120);
    remaining -= h;
    const a = omega * omega * (goal - x) - 2 * omega * v;
    v += a * h;
    x += v * h;
  }
  return [x, v];
}

/** The multiple of 2*pi nearest to `a` (so a turned model can settle without unwinding). */
export function nearestTurn(a: number): number {
  return Math.round(a / (2 * Math.PI)) * 2 * Math.PI;
}
