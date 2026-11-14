/**
 * Where each part of a box-anchored teardown sits, assembled and exploded. Pure maths (no three.js)
 * so it can be checked on its own. Units: px of the object's on-screen box, root-local, y up.
 *
 * Assembled: a part's centre is its part.offset in the box (image +y down, flipped), so it lies
 * exactly on its region of the frozen frame. Exploded (axis 'z'): every plate tilts back by PITCH
 * (seen from the front, like parts laid out on a table), so it projects to h*cos + d*sin tall;
 * a layer keeps its own arrangement, with offsets shrunk only to SLAB_SPREAD so neighbours in one
 * layer separate, and any parts of one layer that would still overlap are pushed apart (live parts
 * lists often put several parts on the same spot); layers are stacked top to bottom, outermost
 * first, LAYER_GAP apart, wrapped into up to 4 columns when that fits the screen much bigger.
 * Round parts (spheres, lying cylinders) keep their round profile when tilted.
 * Axis 'y': the same stack without the tilt. Axis 'x': layers side by side, left to right.
 */
import type { Teardown, TeardownPart } from '../../shared/teardown';

/** Exploded plates tilt back by this much (axis 'z'), radians: top edge away from the camera. */
export const PITCH = (60 * Math.PI) / 180;
/** Within a layer, offsets shrink less than the plates foreshorten, so neighbouring parts separate. */
export const SLAB_SPREAD = 0.75;
/** Gap between layers in the exploded stack, as a fraction of the object's height (width for axis 'x'). */
export const LAYER_GAP = 0.06;
/** Smallest gap between two overlapping parts of the same layer, as a fraction of the object's height. */
export const PART_GAP = 0.03;

export interface PartPose {
  /** assembled centre */
  ax: number;
  ay: number;
  /** exploded centre */
  ex: number;
  ey: number;
  /** mesh scale: width, height (in the image plane), depth (towards the camera) */
  w: number;
  h: number;
  d: number;
  /** true when the cross-section seen from the side is round (sphere, cylinder lying along x) */
  round: boolean;
}

export interface Extent {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Mesh scale in px for a part of an object box W x H, and whether its side profile is round. */
export function partDims(part: TeardownPart, W: number, H: number): { w: number; h: number; d: number; round: boolean } {
  const w = Math.max(2, part.size[0] * W);
  const h = Math.max(2, part.size[1] * H);
  if (part.shape === 'board') return { w, h, d: Math.max(2, Math.min(part.size[2] * W, 0.035 * W)), round: false };
  if (part.shape === 'box') return { w, h, d: Math.max(4, Math.min(part.size[2] * W, 0.12 * W)), round: false };
  if (part.shape === 'sphere') return { w, h, d: Math.min(w, h), round: true };
  // cylinder / tube: lying along x when wide (round seen from the side), else standing along y.
  const lying = part.size[0] >= part.size[1] * 0.7;
  return lying ? { w, h, d: h, round: true } : { w, h, d: Math.min(w, h), round: false };
}

/** Half the on-screen height of a part tilted back by `tilt` radians (orthographic). */
export function projectedHalfHeight(h: number, d: number, tilt: number, round = false): number {
  const c = Math.cos(tilt);
  const s = Math.sin(tilt);
  if (round) return Math.sqrt((h * c) ** 2 + (d * s) ** 2) / 2;
  return (h * c + d * s) / 2;
}

/** Most columns the exploded stack may wrap into (objects with many full-size layers). */
const MAX_COLUMNS = 4;
/** Wrap only if it makes the stack at least this much bigger on screen. */
const WRAP_GAIN = 1.35;

/**
 * @param aspect width / height of the screen area the stack must fit in (to decide on columns).
 */
export function explodeLayout(
  parts: TeardownPart[],
  rankOf: (layer: number) => number,
  ranks: number,
  axis: Teardown['explode_axis'],
  W: number,
  H: number,
  aspect = 1.5,
): { poses: PartPose[]; extent: Extent; columns: number } {
  const tilt = axis === 'z' ? PITCH : 0;
  const spread = axis === 'z' ? SLAB_SPREAD : 1;
  const horizontal = axis === 'x';
  const gap = LAYER_GAP * (horizontal ? W : H);
  const poses: PartPose[] = parts.map((part) => {
    const { w, h, d, round } = partDims(part, W, H);
    const ax = part.offset[0] * W;
    const ay = -part.offset[1] * H; // image +y is down
    return { ax, ay, ex: ax, ey: ay * spread, w, h, d, round };
  });
  const halfH = (p: PartPose) => projectedHalfHeight(p.h, p.d, tilt, p.round);
  const n = Math.max(1, ranks);
  const rank = (part: TeardownPart) => Math.min(n - 1, Math.max(0, rankOf(part.layer)));
  // Within each layer, push apart parts that overlap: top to bottom (left to right for axis 'x').
  const minGap = PART_GAP * (horizontal ? W : H);
  for (let r = 0; r < n; r++) {
    const idx = parts.map((_, i) => i).filter((i) => rank(parts[i]) === r);
    if (horizontal) idx.sort((a, b) => poses[a].ex - poses[b].ex);
    else idx.sort((a, b) => poses[b].ey - poses[a].ey);
    for (let k = 1; k < idx.length; k++) {
      const p = poses[idx[k]];
      for (let j = 0; j < k; j++) {
        const q = poses[idx[j]];
        if (horizontal) {
          const crossOverlap = Math.min(p.ey + halfH(p), q.ey + halfH(q)) - Math.max(p.ey - halfH(p), q.ey - halfH(q));
          if (crossOverlap > 0) p.ex = Math.max(p.ex, q.ex + q.w / 2 + minGap + p.w / 2);
        } else {
          const crossOverlap = Math.min(p.ex + p.w / 2, q.ex + q.w / 2) - Math.max(p.ex - p.w / 2, q.ex - q.w / 2);
          if (crossOverlap > 0) p.ey = Math.min(p.ey, q.ey - halfH(q) - minGap - halfH(p));
        }
      }
    }
  }
  // Extent of each layer, outermost first: along the stacking direction (lo/hi) and across it (xlo/xhi).
  const lo: number[] = new Array(n).fill(Infinity);
  const hi: number[] = new Array(n).fill(-Infinity);
  const xlo: number[] = new Array(n).fill(Infinity);
  const xhi: number[] = new Array(n).fill(-Infinity);
  parts.forEach((part, i) => {
    const r = rank(part);
    const p = poses[i];
    lo[r] = Math.min(lo[r], horizontal ? p.ex - p.w / 2 : p.ey - halfH(p));
    hi[r] = Math.max(hi[r], horizontal ? p.ex + p.w / 2 : p.ey + halfH(p));
    xlo[r] = Math.min(xlo[r], p.ex - p.w / 2);
    xhi[r] = Math.max(xhi[r], p.ex + p.w / 2);
  });
  const used = Array.from({ length: n }, (_, r) => r).filter((r) => Number.isFinite(lo[r]));

  // Columns (vertical stacks only): split the layers, in order, into 1..MAX_COLUMNS columns of
  // similar height and keep the split that fits the screen biggest, if it beats one column clearly.
  let groups: number[][] = [used];
  if (!horizontal && used.length > 2) {
    const heightOf = (g: number[]) => g.reduce((sum, r) => sum + hi[r] - lo[r], 0) + gap * Math.max(0, g.length - 1);
    const widthOf = (g: number[]) => Math.max(...g.map((r) => xhi[r] - xlo[r]));
    const colGap = 2 * LAYER_GAP * W;
    const score = (gs: number[][]) => {
      const lw = gs.reduce((sum, g) => sum + widthOf(g), 0) + colGap * (gs.length - 1);
      const lh = Math.max(...gs.map(heightOf));
      return Math.min(aspect / Math.max(1, lw), 1 / Math.max(1, lh));
    };
    const total = heightOf(used);
    const one = score(groups);
    let best = groups;
    let bestScore = one;
    for (let k = 2; k <= Math.min(MAX_COLUMNS, used.length); k++) {
      const gs: number[][] = [[]];
      let acc = 0;
      for (const r of used) {
        const hgt = hi[r] - lo[r];
        const cur = gs[gs.length - 1];
        if (cur.length > 0 && gs.length < k && acc + hgt / 2 > (total / k) * gs.length) gs.push([]);
        gs[gs.length - 1].push(r);
        acc += hgt + gap;
      }
      const sc = score(gs);
      if (sc > bestScore) {
        best = gs;
        bestScore = sc;
      }
    }
    if (bestScore >= one * WRAP_GAIN) groups = best;
  }

  // Stack: within a column, each deeper layer below the previous one; columns left to right.
  // Column 0 keeps layer 0 where it is, so the outermost parts barely move.
  const offX: number[] = new Array(n).fill(0);
  const offY: number[] = new Array(n).fill(0);
  if (horizontal) {
    let prev = -1;
    for (const r of used) {
      offX[r] = prev < 0 ? 0 : offX[prev] + hi[prev] - lo[r] + gap;
      prev = r;
    }
  } else {
    const top = used.length ? hi[used[0]] : 0;
    const widths = groups.map((g) => ({ lo: Math.min(...g.map((r) => xlo[r])), hi: Math.max(...g.map((r) => xhi[r])) }));
    const colGap = 2 * LAYER_GAP * W;
    const totalW = widths.reduce((sum, w) => sum + (w.hi - w.lo), 0) + colGap * (groups.length - 1);
    let cursor = groups.length > 1 ? -totalW / 2 : 0;
    groups.forEach((g, c) => {
      const shift = groups.length > 1 ? cursor - widths[c].lo : 0;
      cursor += widths[c].hi - widths[c].lo + colGap;
      let prev = -1;
      for (const r of g) {
        offY[r] = prev < 0 ? top - hi[r] : offY[prev] + lo[prev] - hi[r] - gap;
        offX[r] = shift;
        prev = r;
      }
    });
  }
  const extent: Extent = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  parts.forEach((part, i) => {
    const p = poses[i];
    const r = rank(part);
    p.ex += offX[r];
    p.ey += offY[r];
    extent.minX = Math.min(extent.minX, p.ex - p.w / 2);
    extent.maxX = Math.max(extent.maxX, p.ex + p.w / 2);
    extent.minY = Math.min(extent.minY, p.ey - halfH(p));
    extent.maxY = Math.max(extent.maxY, p.ey + halfH(p));
  });
  if (!Number.isFinite(extent.minX)) {
    extent.minX = -W / 2;
    extent.maxX = W / 2;
    extent.minY = -H / 2;
    extent.maxY = H / 2;
  }
  return { poses, extent, columns: groups.length };
}
