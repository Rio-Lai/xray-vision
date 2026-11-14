/**
 * Per-layer critically damped springs toward store.explodeAmount, with a per-layer stagger:
 * exploding, the outermost layer (layer 0) leaves first; collapsing, the deepest returns first
 * (the exact reverse). With 5 layers: 4 x 110 ms stagger + ~0.6 s settle = about 1 s in all.
 * Only a jump (voice, a key, a burst gesture) is staggered: small steps that come every frame
 * (two hands pulling the model apart, the mouse wheel) move every layer at once, so the model
 * follows the hands proportionally instead of waiting for them to stop.
 */
const STAGGER_MS = 110;
/** A target change at least this big is staggered layer by layer. */
const STAGGER_MIN_JUMP = 0.2;
const OMEGA = 9; // rad/s; critically damped => no overshoot, ~97% of the way after 0.6 s

interface LayerState {
  x: number;
  v: number;
  goal: number;
}

export class ExplodeAnimator {
  private layers: number[] = [];
  private state = new Map<number, LayerState>();
  private target = 0;
  private changedAt = 0;
  private rising = true;

  setLayers(layerValues: number[]): void {
    this.layers = Array.from(new Set(layerValues)).sort((a, b) => a - b);
    const next = new Map<number, LayerState>();
    for (const l of this.layers) next.set(l, this.state.get(l) ?? { x: 0, v: 0, goal: 0 });
    this.state = next;
  }

  /** rank 0 = outermost */
  rankOf(layer: number): number {
    const i = this.layers.indexOf(layer);
    return i < 0 ? 0 : i;
  }

  get layerCount(): number {
    return this.layers.length;
  }

  /** 1 for the outermost layer .. 0 for the deepest */
  outerness(layer: number): number {
    const n = this.layers.length;
    return n <= 1 ? 1 : 1 - this.rankOf(layer) / (n - 1);
  }

  update(now: number, dtSec: number, target: number): void {
    if (target !== this.target) {
      const jump = Math.abs(target - this.target);
      this.rising = target > this.target;
      this.target = target;
      this.changedAt = jump >= STAGGER_MIN_JUMP ? now : -Infinity;
    }
    const n = this.layers.length;
    let remaining = Math.min(0.1, Math.max(0, dtSec));
    while (remaining > 1e-6) {
      const h = Math.min(remaining, 1 / 120);
      remaining -= h;
      this.layers.forEach((layer, rank) => {
        const s = this.state.get(layer);
        if (!s) return;
        const order = this.rising ? rank : n - 1 - rank;
        if (now - this.changedAt >= order * STAGGER_MS) s.goal = this.target;
        const a = OMEGA * OMEGA * (s.goal - s.x) - 2 * OMEGA * s.v;
        s.v += a * h;
        s.x += s.v * h;
      });
    }
  }

  /** Current explode amount for a layer (0..1). */
  get(layer: number): number {
    const s = this.state.get(layer);
    return s ? Math.min(1.05, Math.max(0, s.x)) : 0;
  }

  max(): number {
    let m = 0;
    for (const s of this.state.values()) m = Math.max(m, s.x);
    return m;
  }
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
