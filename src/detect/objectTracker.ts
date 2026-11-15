/**
 * Stable ids for detector boxes (#110):
 *  - two thresholds: the detector reports down to KEEP_SCORE; a new thing needs APPEAR_HITS
 *    detections at APPEAR_SCORE or more (within CANDIDATE_MS of each other) before it becomes a
 *    track with a label; a track is kept while detections at KEEP_SCORE or more match it, and stays
 *    at its last place for DROP_AFTER_MS without a match before it is dropped
 *  - greedy matching, same label: by overlap; failing that (it moved fast, or came back after a
 *    miss), an appear-level box whose centre is within REACQUIRE average sides keeps the id
 *  - a detection over a labelled thing of another class (IoU >= OTHER_LABEL_IOU) starts nothing,
 *    so a second label does not flicker on the same thing
 *  - boxes smoothed with a One Euro filter (calm when still, quick when it moves), in place
 * Ids reuse the lowest free number per label, so a laptop that comes back is "laptop-1" again.
 */
import type { Box, SceneObject } from '../state/store';
import { urlNumber } from '../camera/frame';

export interface RawDetection {
  label: string;
  score: number;
  box: Box;
}

interface Track {
  /** '' while a candidate (not yet seen APPEAR_HITS times; not published) */
  id: string;
  label: string;
  score: number;
  box: Box;
  /** One Euro state: centre x, centre y, w, h, then their filtered speeds (per second) */
  f: Float64Array;
  lastSeen: number;
  hits: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Lowest score the detector reports, and that keeps a track alive (`?keep=`). */
export const KEEP_SCORE = clamp(urlNumber('keep', 0.25), 0.05, 0.9);
/** Score a new thing must reach to get a label (`?appear=`); never below KEEP_SCORE. */
export const APPEAR_SCORE = Math.max(KEEP_SCORE, clamp(urlNumber('appear', 0.45), 0.05, 0.95));
const APPEAR_HITS = 2;
const CANDIDATE_MS = 500;
const DROP_AFTER_MS = 1000;
const REACQUIRE = 1.2;
const OTHER_LABEL_IOU = 0.6;

/** One Euro filter: cutoff (Hz) = MIN_CUTOFF + BETA * |speed in frame units per second|. */
const EURO_MIN_CUTOFF = 0.3;
const EURO_BETA = 15;
const EURO_D_CUTOFF = 0.7;

export function iou(a: Box, b: Box): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const uni = a.w * a.h + b.w * b.h - inter;
  return uni > 0 ? inter / uni : 0;
}

/** Centre distance in average box sides. */
function centreGap(a: Box, b: Box): number {
  const dx = a.x + a.w / 2 - (b.x + b.w / 2);
  const dy = a.y + a.h / 2 - (b.y + b.h / 2);
  return Math.hypot(dx, dy) / Math.max(1e-6, (a.w + a.h + b.w + b.h) / 4);
}

/** Overlap pairs score above 0.2; a near miss (loose, for appear-level detections only) scores 0..0.2; 0 = no match. */
function matchScore(a: Box, b: Box, loose: boolean): number {
  const gap = centreGap(a, b);
  const s = iou(a, b) + (gap < 0.3 ? 0.15 : 0);
  if (s > 0.2) return s;
  return loose && gap < REACQUIRE ? 0.2 * (1 - gap / REACQUIRE) : 0;
}

const alpha = (cutoff: number, dt: number) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));

/** One Euro step for value i of the state (speed at i + 4). */
function euro(f: Float64Array, i: number, raw: number, dt: number): void {
  const speed = f[i + 4] + alpha(EURO_D_CUTOFF, dt) * ((raw - f[i]) / dt - f[i + 4]);
  f[i + 4] = speed;
  f[i] += alpha(EURO_MIN_CUTOFF + EURO_BETA * Math.abs(speed), dt) * (raw - f[i]);
}

/** Filters a track's box towards `b` (dt in seconds), writing `out` in place. */
export function smoothBox(f: Float64Array, out: Box, b: Box, dt: number): void {
  const d = Math.max(0.001, dt);
  euro(f, 0, b.x + b.w / 2, d);
  euro(f, 1, b.y + b.h / 2, d);
  euro(f, 2, b.w, d);
  euro(f, 3, b.h, d);
  out.w = f[2];
  out.h = f[3];
  out.x = f[0] - f[2] / 2;
  out.y = f[1] - f[3] / 2;
}

export function newFilter(b: Box): Float64Array {
  const f = new Float64Array(8);
  f[0] = b.x + b.w / 2;
  f[1] = b.y + b.h / 2;
  f[2] = b.w;
  f[3] = b.h;
  return f;
}

export class ObjectTracker {
  private tracks: Track[] = [];
  /**
   * #131: while the engine runs the detector only every so often (a model up on stage), a labelled
   * track may go this much longer than DROP_AFTER_MS unmatched: the time it could not have been seen.
   */
  extraHoldMs = 0;
  /** #131: labelled tracks the last update did not match (the engine then looks again at the next slot). */
  unmatched = 0;

  update(dets: RawDetection[], now: number): void {
    const pairs: { t: number; d: number; score: number }[] = [];
    this.tracks.forEach((t, ti) => {
      dets.forEach((d, di) => {
        if (t.label !== d.label) return;
        const appear = d.score >= APPEAR_SCORE;
        if (!t.id && !appear) return; // a candidate counts only appear-level sightings
        const s = matchScore(t.box, d.box, appear);
        if (s > 0) pairs.push({ t: ti, d: di, score: s + (t.id ? 0.05 : 0) });
      });
    });
    pairs.sort((a, b) => b.score - a.score);
    const usedT = new Set<number>();
    const usedD = new Set<number>();
    for (const p of pairs) {
      if (usedT.has(p.t) || usedD.has(p.d)) continue;
      usedT.add(p.t);
      usedD.add(p.d);
      const t = this.tracks[p.t];
      const d = dets[p.d];
      smoothBox(t.f, t.box, d.box, (now - t.lastSeen) / 1000);
      t.score += (d.score - t.score) * 0.4;
      t.lastSeen = now;
      if (!t.id && ++t.hits >= APPEAR_HITS) t.id = this.nextId(t.label);
    }
    this.unmatched = 0;
    for (let ti = 0; ti < this.tracks.length; ti++) if (this.tracks[ti].id && !usedT.has(ti)) this.unmatched += 1;
    dets.forEach((d, di) => {
      if (usedD.has(di) || d.score < APPEAR_SCORE) return;
      if (this.tracks.some((t) => t.id && t.label !== d.label && iou(t.box, d.box) >= OTHER_LABEL_IOU)) return;
      this.tracks.push({ id: '', label: d.label, score: d.score, box: { ...d.box }, f: newFilter(d.box), lastSeen: now, hits: 1 });
    });
    this.prune(now);
  }

  prune(now: number): void {
    const keep = DROP_AFTER_MS + this.extraHoldMs;
    let n = 0;
    for (const t of this.tracks) if (now - t.lastSeen <= (t.id ? keep : CANDIDATE_MS)) this.tracks[n++] = t;
    this.tracks.length = n;
  }

  /** After a freeze, pretend everything was just seen so nothing drops on unfreeze. */
  touchAll(now: number): void {
    for (const t of this.tracks) t.lastSeen = now;
  }

  clear(): void {
    this.tracks = [];
  }

  objects(): SceneObject[] {
    const out: SceneObject[] = [];
    for (const t of this.tracks) {
      if (!t.id) continue;
      out.push({ id: t.id, label: t.label, confidence: t.score, box: { ...t.box }, lens: 'engineering', anchor: 'box' });
    }
    return out;
  }

  private nextId(label: string): string {
    const slug = label.trim().toLowerCase().replace(/\s+/g, '-');
    let n = 1;
    while (this.tracks.some((t) => t.id === `${slug}-${n}`)) n += 1;
    return `${slug}-${n}`;
  }
}
