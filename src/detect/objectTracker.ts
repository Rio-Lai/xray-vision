/**
 * Stable ids for detector boxes: greedy IoU matching to the previous tracks (same label),
 * EMA-smoothed boxes, a track is dropped only after ~0.7 s unseen.
 * Ids reuse the lowest free number per label, so a laptop that comes back is "laptop-1" again.
 */
import type { Box, SceneObject } from '../state/store';

export interface RawDetection {
  label: string;
  score: number;
  box: Box;
}

interface Track {
  id: string;
  label: string;
  score: number;
  box: Box;
  lastSeen: number;
}

const DROP_AFTER_MS = 700;
const BOX_ALPHA = 0.45;

export function iou(a: Box, b: Box): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const uni = a.w * a.h + b.w * b.h - inter;
  return uni > 0 ? inter / uni : 0;
}

function centreClose(a: Box, b: Box): boolean {
  const dx = a.x + a.w / 2 - (b.x + b.w / 2);
  const dy = a.y + a.h / 2 - (b.y + b.h / 2);
  const size = (a.w + a.h + b.w + b.h) / 4;
  return Math.hypot(dx, dy) < 0.3 * size;
}

function lerpBox(a: Box, b: Box, t: number): Box {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    w: a.w + (b.w - a.w) * t,
    h: a.h + (b.h - a.h) * t,
  };
}

export class ObjectTracker {
  private tracks: Track[] = [];

  update(dets: RawDetection[], now: number): void {
    const pairs: { t: number; d: number; score: number }[] = [];
    this.tracks.forEach((t, ti) => {
      dets.forEach((d, di) => {
        if (t.label !== d.label) return;
        const s = iou(t.box, d.box) + (centreClose(t.box, d.box) ? 0.15 : 0);
        if (s > 0.2) pairs.push({ t: ti, d: di, score: s });
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
      t.box = lerpBox(t.box, d.box, BOX_ALPHA);
      t.score += (d.score - t.score) * 0.4;
      t.lastSeen = now;
    }
    dets.forEach((d, di) => {
      if (usedD.has(di)) return;
      this.tracks.push({ id: this.nextId(d.label), label: d.label, score: d.score, box: { ...d.box }, lastSeen: now });
    });
    this.prune(now);
  }

  prune(now: number): void {
    this.tracks = this.tracks.filter((t) => now - t.lastSeen <= DROP_AFTER_MS);
  }

  /** After a freeze, pretend everything was just seen so nothing drops on unfreeze. */
  touchAll(now: number): void {
    for (const t of this.tracks) t.lastSeen = now;
  }

  clear(): void {
    this.tracks = [];
  }

  objects(): SceneObject[] {
    return this.tracks.map((t) => ({
      id: t.id,
      label: t.label,
      confidence: t.score,
      box: { ...t.box },
      lens: 'engineering',
      anchor: 'box',
    }));
  }

  private nextId(label: string): string {
    const slug = label.trim().toLowerCase().replace(/\s+/g, '-');
    let n = 1;
    while (this.tracks.some((t) => t.id === `${slug}-${n}`)) n += 1;
    return `${slug}-${n}`;
  }
}
