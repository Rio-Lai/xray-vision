/**
 * #124: where each part of a solid parts list (layout "solid") goes when it explodes. Pure (no three.js),
 * worked out once per parts list, so it can be checked on its own.
 *
 * The largest part (body, cabinet, case) stays put. Every other part moves away from the centre along
 * the direction it sits in, measured in the object's own proportions (its offset divided by the half
 * size, so a TV's mainboard goes sideways and its stand down although the TV is far wider than deep);
 * a part whose centre is inside a larger part is measured from that container instead. Parts at the
 * centre (closer than CENTRE_REL) have no direction of their own: they go along the object's longest
 * axis, alternating ends, or across it when they sit in the middle of a container (the water in a
 * bottle slides out sideways rather than stacking the bottle into one long column). Parts are placed from the centre outwards: each starts
 * at a distance in proportion to how far out it sits, never nearer than a part already placed in the
 * same direction (so the order is kept: a cap stays beyond the neck), and is pushed further out until
 * its box is CLEAR of every part already placed. Fully exploded, no two parts' boxes overlap.
 * `start`: when each part begins to move (0..STAGGER), outermost first: a fixed order.
 */
import type { TeardownPart } from '../../shared/teardown';

type V3 = [number, number, number];

/** Parts closer to the centre than this (in half-sizes of the assembly) count as central. */
export const CENTRE_REL = 0.15;
/** Base travel, in longest sides of the object per unit of relative offset. */
export const SPREAD = 0.3;
/** Clear gap between parts' boxes when fully exploded, in longest sides of the object. */
export const CLEAR = 0.04;
/** Search step and furthest travel, in longest sides. */
const STEP = 0.01;
const MAX_TRAVEL = 8;
/** The last part starts this late (as a share of the explode). */
export const STAGGER = 0.3;

export interface SolidPartLayout {
  /** centre and size in mm, object frame */
  c: V3;
  s: V3;
  /** unit direction of travel (0 for the part that stays) */
  dir: V3;
  /** travel in mm when fully exploded */
  t: number;
  /** when it starts moving, 0..STAGGER */
  start: number;
}

export interface SolidLayout {
  parts: SolidPartLayout[];
  /** longest side of the assembled object (mm) */
  maxDim: number;
}

const norm = (v: V3): number => Math.hypot(v[0], v[1], v[2]);

/** The part's box (mm) from its solid fields, or from its flat fields when they are missing. */
export function partBox(p: Pick<TeardownPart, 'size_mm' | 'position_mm' | 'size' | 'offset'>): { c: V3; s: V3 } {
  if (p.size_mm && p.position_mm) return { c: [...p.position_mm], s: [...p.size_mm] };
  // never on a server-made solid list; a hand-edited one gets a 300 mm frame
  const k = 300;
  return { c: [p.offset[0] * k, -p.offset[1] * k, 0], s: [Math.max(1, p.size[0] * k), Math.max(1, p.size[1] * k), Math.max(1, p.size[2] * k)] };
}

function overlaps(a: { c: V3; s: V3 }, b: { c: V3; s: V3 }, gap: number): boolean {
  for (let i = 0; i < 3; i++) if (Math.abs(a.c[i] - b.c[i]) >= (a.s[i] + b.s[i]) / 2 + gap) return false;
  return true;
}

export function solidLayout(parts: Pick<TeardownPart, 'size_mm' | 'position_mm' | 'size' | 'offset'>[]): SolidLayout {
  const boxes = parts.map(partBox);
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const b of boxes) {
    for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i], b.c[i] - b.s[i] / 2);
      hi[i] = Math.max(hi[i], b.c[i] + b.s[i] / 2);
    }
  }
  if (!Number.isFinite(lo[0])) return { parts: [], maxDim: 1 };
  const centre: V3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const half: V3 = [(hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2, (hi[2] - lo[2]) / 2];
  const maxDim = Math.max(1, 2 * Math.max(...half));
  // a very thin assembly still has a usable depth for directions
  const halfSafe = half.map((h) => Math.max(h, 0.05 * maxDim)) as V3;
  const longest = half.indexOf(Math.max(...half));
  const vol = (i: number) => boxes[i].s[0] * boxes[i].s[1] * boxes[i].s[2];

  // The largest part (the body, cabinet, case) stays put: everything else moves away from it.
  const anchor = boxes.map((_, i) => i).sort((a, b) => vol(b) - vol(a))[0];
  const inside = (i: number, j: number) =>
    vol(j) > vol(i) && [0, 1, 2].every((k) => Math.abs(boxes[i].c[k] - boxes[j].c[k]) <= boxes[j].s[k] / 2);
  // Sideways for a part that sits in the middle of its container (water in a bottle, a drum in a
  // cabinet): across the object, not along its longest axis (which would stack them in one long column).
  const side = longest === 0 ? 1 : 0;
  let alternate = 0;
  const rel: V3[] = [];
  const relLen: number[] = [];
  const dirs: V3[] = [];
  boxes.forEach((b, i) => {
    // measured from its container (the largest part round its centre), else from the assembly
    const cont = boxes.map((_, j) => j).filter((j) => j !== i && inside(i, j)).sort((a, c) => vol(c) - vol(a))[0];
    const from = cont === undefined ? centre : boxes[cont].c;
    const scale = cont === undefined ? halfSafe : (boxes[cont].s.map((v) => Math.max(v / 2, 0.05 * maxDim)) as V3);
    const r = [0, 1, 2].map((k) => (b.c[k] - from[k]) / scale[k]) as V3;
    const len = norm(r);
    const whole = [0, 1, 2].map((k) => (b.c[k] - centre[k]) / halfSafe[k]) as V3;
    rel.push(whole);
    relLen.push(norm(whole));
    if (i === anchor) dirs.push([0, 0, 0]);
    else if (len >= CENTRE_REL) dirs.push(r.map((x) => x / len) as V3);
    else {
      const d: V3 = [0, 0, 0];
      d[cont === undefined ? longest : side] = alternate++ % 2 === 0 ? 1 : -1;
      dirs.push(d);
    }
  });

  const order = boxes.map((_, i) => i).sort((a, b) => (a === anchor ? -1 : b === anchor ? 1 : relLen[a] - relLen[b] || vol(b) - vol(a)));
  const t = new Array<number>(boxes.length).fill(0);
  const placed: number[] = [];
  const gap = CLEAR * maxDim;
  for (const i of order) {
    const d = dirs[i];
    if (norm(d) === 0) {
      placed.push(i);
      continue;
    }
    let ti = SPREAD * Math.min(2, relLen[i]) * maxDim;
    for (const j of placed) {
      const dot = d[0] * dirs[j][0] + d[1] * dirs[j][1] + d[2] * dirs[j][2];
      if (dot > 0.9) ti = Math.max(ti, t[j]);
    }
    const at = (tt: number) => ({ c: [0, 1, 2].map((k) => boxes[i].c[k] + d[k] * tt) as V3, s: boxes[i].s });
    const moved = (j: number) => ({ c: [0, 1, 2].map((k) => boxes[j].c[k] + dirs[j][k] * t[j]) as V3, s: boxes[j].s });
    for (let guard = 0; guard < MAX_TRAVEL / STEP; guard++) {
      const here = at(ti);
      if (!placed.some((j) => overlaps(here, moved(j), gap))) break;
      ti += STEP * maxDim;
    }
    t[i] = ti;
    placed.push(i);
  }
  // fixed order: the part that travels furthest starts first
  const byTravel = boxes.map((_, i) => i).sort((a, b) => t[b] - t[a]);
  const start = new Array<number>(boxes.length).fill(0);
  byTravel.forEach((i, k) => (start[i] = boxes.length > 1 ? (STAGGER * k) / (boxes.length - 1) : 0));
  return {
    parts: boxes.map((b, i) => ({ c: b.c, s: b.s, dir: dirs[i], t: t[i], start: start[i] })),
    maxDim,
  };
}

/** A part's own explode progress (0..1) at overall progress e (0..1), eased (smoothstep). */
export function partProgress(e: number, start: number): number {
  const u = Math.min(1, Math.max(0, (e - start) / (1 - STAGGER)));
  return u * u * (3 - 2 * u);
}
