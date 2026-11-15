/**
 * The pointer (HeyClicky style): a small glowing dot that shows the wearer where to look while
 * Blowfish talks about a part. When the tutor highlights a part (highlight_part, show_step) or
 * lights a step of the detail model (detail_step), it flies from where it was (from the voice pill
 * at the bottom centre the first time) to that part's centre on a spring, pulses once when it
 * gets there (a thin accent ring grows out and fades), then stays on the part every frame while
 * the model turns, zooms or opens, the live hand moves or the object moves in the view.
 *
 *  - Target: src/overlay/pointerTarget.ts (each stage writes the highlighted part's label anchor).
 *  - Dot 12 px, solid accent; halo 32 px, accent at 18 percent. Steady: nothing breathes or blinks.
 *  - Pulse, once per new target, on arrival: a 2 px accent ring, radius 8 to 42 px, opacity 0.9 to
 *    0, over 700 ms, ease-out.
 *  - Motion: a spring (stiffness 120, damping 0.9 of critical) pulls the pointer's offset from its
 *    target to zero, so a new target 300 px away is reached in about 0.4 s, and once there it rides
 *    on the target (a 40 ms smoothing of the anchor, no spring lag) as it moves.
 *  - Nothing highlighted: it glides back towards the voice pill and fades to 0 in 300 ms.
 *  - Target outside the view: it waits at the nearest edge at half opacity.
 *  - Hidden in the clean view (overlay off). `?pointer=0`: not mounted at all.
 *  - One layer over the whole view above every stage canvas (z-index 1 in the stage), pointer
 *    events off; per frame one transform write, plus opacity only while it changes and the ring
 *    only during its pulse. No layout reads.
 * The maths is in pure functions and PointerMotion (no DOM), checked under Node.
 */
import { currentPointer } from './pointerTarget';
import type { PointerAnchor } from './pointerTarget';

/** Spring: stiffness (1/s^2) and damping (1/s), 0.9 of critical. */
export const SPRING_K = 120;
export const SPRING_C = 0.9 * 2 * Math.sqrt(SPRING_K);
/** At most this much time per frame (s), and per integration step inside it. */
export const MAX_DT = 0.05;
const SUB_DT = 1 / 120;
/** The anchor is smoothed at this rate (1/s): about 40 ms behind a moving part, no jitter. */
export const FOLLOW_RATE = 25;
/** Arrived (the pulse starts) once this close to the target (px). */
export const ARRIVE_PX = 10;
/** Pulse: duration (ms), ring radius from / to (px), starting opacity. */
export const PULSE_MS = 700;
export const RING_FROM = 8;
export const RING_TO = 42;
export const RING_OPACITY = 0.9;
/** Fade out (no target) and in (ms). */
export const FADE_OUT_MS = 300;
export const FADE_IN_MS = 150;
/** Off screen: the pointer waits this far inside the edge (px), at this opacity. */
export const EDGE_PX = 16;
export const EDGE_OPACITY = 0.5;
/** The edge factor eases at this rate (1/s), so crossing the edge never blinks. */
const EDGE_RATE = 10;
/** Where it starts and goes back to: the voice pill's middle, this far above the bottom (px). */
export const PILL_FROM_BOTTOM = 44;

export const DOT_PX = 12;
export const HALO_PX = 32;
const ACCENT = 'var(--bf-color-accent, #4DA3FF)';
const HALO = 'rgba(77, 163, 255, 0.18)';

/** One spring step of the offset (x, v) towards 0 over dt seconds (sub-stepped: stable at any dt up to MAX_DT). */
export function springStep(x: number, v: number, dt: number): [number, number] {
  let t = Math.min(MAX_DT, Math.max(0, dt));
  while (t > 1e-6) {
    const h = Math.min(SUB_DT, t);
    v += (-SPRING_K * x - SPRING_C * v) * h;
    x += v * h;
    t -= h;
  }
  return [x, v];
}

export const easeOutCubic = (u: number): number => 1 - Math.pow(1 - Math.min(1, Math.max(0, u)), 3);

/** The pulse ring at `ms` after it started: radius and opacity (opacity 0 once it is over). */
export function pulseAt(ms: number): { r: number; opacity: number } {
  if (ms < 0 || ms >= PULSE_MS) return { r: RING_TO, opacity: 0 };
  const e = easeOutCubic(ms / PULSE_MS);
  return { r: RING_FROM + (RING_TO - RING_FROM) * e, opacity: RING_OPACITY * (1 - e) };
}

/** The point in the view the pointer aims for: the anchor, kept EDGE_PX inside the edges. */
export function clampToView(x: number, y: number, vw: number, vh: number): { x: number; y: number } {
  const m = Math.min(EDGE_PX, vw / 2, vh / 2);
  return { x: Math.min(vw - m, Math.max(m, x)), y: Math.min(vh - m, Math.max(m, y)) };
}

/** The voice pill's middle (bottom centre). */
export function pillPoint(vw: number, vh: number): { x: number; y: number } {
  return { x: vw / 2, y: Math.max(0, vh - PILL_FROM_BOTTOM) };
}

/** Shown opacity for the fade level p (0..1): flat near 1, so a frame without a target does not show. */
export const fadeCurve = (p: number): number => 1 - (1 - p) * (1 - p);

export interface PointerFrame {
  x: number;
  y: number;
  opacity: number;
  ringR: number;
  ringOpacity: number;
  /** the target id the pointer is on (or flying to), null when idle */
  id: string | null;
}

/** The pointer's motion, fade and pulse, without any DOM (pointer.ts draws it; tests drive it). */
export class PointerMotion {
  /** the current target id, null = none */
  private id: string | null = null;
  /** smoothed aim point, and the offset of the pointer from it (springs to 0) with its velocity */
  private ax = 0;
  private ay = 0;
  private ox = 0;
  private oy = 0;
  private vx = 0;
  private vy = 0;
  /** the aim point must be re-based (new target, or back to the pill): the pointer keeps its place */
  private rebase = false;
  /** fade level 0..1 and the edge factor (1 in view, EDGE_OPACITY off screen) */
  private fade = 0;
  private edge = 1;
  /** a new target's pulse waits for arrival; then it runs from pulseStart (ms) */
  private pulseArmed = false;
  private pulseStart = -1;
  private lastNow = -1;
  private placed = false;
  /** last frame had a target to aim at (a change re-bases the aim: to the target, or back to the pill) */
  private aimed = false;

  /** A different id is a new target (flight, then one pulse); the same id does nothing. */
  setTarget(id: string | null): void {
    if (id === this.id) return;
    this.id = id;
    this.rebase = true;
    if (id !== null) {
      this.pulseArmed = true;
      this.pulseStart = -1;
    }
  }

  get target(): string | null {
    return this.id;
  }

  /** Straight to idle (overlay off, or reset): invisible, parked at the voice pill. */
  hide(vw: number, vh: number): void {
    this.id = null;
    this.park(vw, vh);
  }

  private park(vw: number, vh: number): void {
    const p = pillPoint(vw, vh);
    this.ax = p.x;
    this.ay = p.y;
    this.ox = this.oy = this.vx = this.vy = 0;
    this.fade = 0;
    this.edge = 1;
    this.pulseArmed = false;
    this.pulseStart = -1;
    this.rebase = false;
    this.aimed = false;
    this.placed = true;
  }

  /** One frame: the target's anchor (null = none) at time now (ms). */
  step(anchor: { x: number; y: number; visible: boolean } | null, now: number, vw: number, vh: number): PointerFrame {
    if (!this.placed) {
      // the first frame: it starts at the voice pill (a target set before this frame keeps its pulse)
      const p = pillPoint(vw, vh);
      this.ax = p.x;
      this.ay = p.y;
      this.placed = true;
    }
    const dt = this.lastNow < 0 ? 1 / 60 : Math.min(MAX_DT, Math.max(0, (now - this.lastNow) / 1000));
    this.lastNow = now;
    const has = this.id !== null && anchor !== null;
    const aim = has ? clampToView(anchor.x, anchor.y, vw, vh) : pillPoint(vw, vh);
    if (has !== this.aimed) {
      this.aimed = has;
      this.rebase = true;
    }
    if (this.rebase) {
      // the pointer stays where it is: all of the move is in the offset, which the spring pulls to 0
      const px = this.ax + this.ox;
      const py = this.ay + this.oy;
      this.ax = aim.x;
      this.ay = aim.y;
      this.ox = px - aim.x;
      this.oy = py - aim.y;
      this.rebase = false;
    } else {
      const k = 1 - Math.exp(-FOLLOW_RATE * dt);
      this.ax += (aim.x - this.ax) * k;
      this.ay += (aim.y - this.ay) * k;
    }
    [this.ox, this.vx] = springStep(this.ox, this.vx, dt);
    [this.oy, this.vy] = springStep(this.oy, this.vy, dt);

    if (has) {
      this.fade = Math.min(1, this.fade + (dt * 1000) / FADE_IN_MS);
      const e = anchor.visible ? 1 : EDGE_OPACITY;
      this.edge += (e - this.edge) * (1 - Math.exp(-EDGE_RATE * dt));
      if (this.pulseArmed && Math.hypot(this.ox, this.oy) < ARRIVE_PX) {
        this.pulseArmed = false;
        this.pulseStart = now;
      }
    } else {
      this.fade = this.fade - (dt * 1000) / FADE_OUT_MS;
      if (this.fade < 1e-3) this.fade = 0;
      // faded out: park at the pill, so the next target flies from there and pulses
      if (this.fade <= 0 && (this.id !== null || this.ox !== 0 || this.oy !== 0)) {
        this.id = null;
        this.park(vw, vh);
      }
    }
    const ring = this.pulseStart >= 0 ? pulseAt(now - this.pulseStart) : { r: RING_TO, opacity: 0 };
    if (this.pulseStart >= 0 && now - this.pulseStart >= PULSE_MS) this.pulseStart = -1;
    return {
      x: this.ax + this.ox,
      y: this.ay + this.oy,
      opacity: fadeCurve(this.fade) * this.edge,
      ringR: ring.r,
      ringOpacity: ring.opacity,
      id: this.id,
    };
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const RING_BOX = 2 * (RING_TO + 2);

/** The pointer's DOM: one layer over the whole view, drawn from PointerMotion every frame. */
export class PointerLayer {
  private readonly root: HTMLDivElement;
  private readonly mark: HTMLDivElement;
  private readonly ring: SVGCircleElement;
  private readonly motion = new PointerMotion();
  private shownOpacity = -1;
  private ringR = -1;
  private ringOpacity = -1;
  private lastTransform = '';
  /** hidden by hide() and not drawn since */
  private hidden = false;

  constructor(host: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'bf-pointer-layer';
    this.root.setAttribute('aria-hidden', 'true');
    // z-index 1 in the stage: above every stage canvas (arm, eye, solid, detail) and their labels, below the HUD's voice pill
    Object.assign(this.root.style, { position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '1', overflow: 'hidden' });
    this.mark = document.createElement('div');
    Object.assign(this.mark.style, { position: 'absolute', left: '0', top: '0', width: '0', height: '0', opacity: '0', willChange: 'transform, opacity' });
    const disc = (px: number, bg: string): HTMLDivElement => {
      const d = document.createElement('div');
      Object.assign(d.style, { position: 'absolute', left: `${-px / 2}px`, top: `${-px / 2}px`, width: `${px}px`, height: `${px}px`, borderRadius: '50%', background: bg });
      return d;
    };
    this.mark.appendChild(disc(HALO_PX, HALO));
    this.mark.appendChild(disc(DOT_PX, ACCENT));
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', String(RING_BOX));
    svg.setAttribute('height', String(RING_BOX));
    Object.assign(svg.style, { position: 'absolute', left: `${-RING_BOX / 2}px`, top: `${-RING_BOX / 2}px`, overflow: 'visible' });
    this.ring = document.createElementNS(SVG_NS, 'circle');
    this.ring.setAttribute('cx', String(RING_BOX / 2));
    this.ring.setAttribute('cy', String(RING_BOX / 2));
    this.ring.setAttribute('r', String(RING_FROM));
    this.ring.setAttribute('fill', 'none');
    this.ring.setAttribute('stroke-width', '2');
    this.ring.setAttribute('opacity', '0');
    this.ring.style.stroke = ACCENT;
    svg.appendChild(this.ring);
    this.mark.appendChild(svg);
    this.root.appendChild(this.mark);
    host.appendChild(this.root);
  }

  setTarget(id: string | null): void {
    this.motion.setTarget(id);
  }

  /** One frame: the target's anchor (null = nothing highlighted) at time now (ms). */
  update(anchor: { x: number; y: number; visible: boolean } | null, now: number, vw: number, vh: number): void {
    this.hidden = false;
    this.draw(this.motion.step(anchor, now, vw, vh));
  }

  /** Overlay off (the clean view): hidden at once, parked at the voice pill. */
  hide(vw: number, vh: number): void {
    if (this.hidden) return;
    this.hidden = true;
    this.motion.hide(vw, vh);
    this.draw({ x: 0, y: 0, opacity: 0, ringR: RING_FROM, ringOpacity: 0, id: null });
  }

  private draw(f: PointerFrame): void {
    const op = Math.round(f.opacity * 100) / 100;
    if (op !== this.shownOpacity) {
      this.shownOpacity = op;
      this.mark.style.opacity = String(op);
    }
    if (op > 0) {
      const t = `translate3d(${f.x.toFixed(1)}px, ${f.y.toFixed(1)}px, 0)`;
      if (t !== this.lastTransform) {
        this.lastTransform = t;
        this.mark.style.transform = t;
      }
    }
    const ro = Math.round(f.ringOpacity * 100) / 100;
    if (ro !== this.ringOpacity) {
      this.ringOpacity = ro;
      this.ring.setAttribute('opacity', String(ro));
    }
    if (ro > 0) {
      const r = Math.round(f.ringR * 10) / 10;
      if (r !== this.ringR) {
        this.ringR = r;
        this.ring.setAttribute('r', String(r));
      }
    }
  }

  dispose(): void {
    this.root.remove();
  }
}

/** Once a frame from the overlay's tick (after every stage it drives has written its target); overlayOn = store.overlayOn. */
export function tickPointer(layer: PointerLayer, now: number, overlayOn: boolean): void {
  try {
    const vw = Math.max(1, window.innerWidth);
    const vh = Math.max(1, window.innerHeight);
    if (!overlayOn) {
      layer.hide(vw, vh);
      return;
    }
    const a: PointerAnchor | null = currentPointer();
    if (a) layer.setTarget(a.id);
    layer.update(a, now, vw, vh);
  } catch (e) {
    // never stops the overlay's frame; said once
    if (!warned) console.warn('[pointer]', e);
    warned = true;
  }
}

let warned = false;
