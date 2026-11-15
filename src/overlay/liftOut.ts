/**
 * The lift-out and the put-away (#109), shared by the three stage renderers (boxRig.ts for the
 * MacBook, live objects and saved models; ArmStage.tsx; EyeStage.tsx). One timeline per model:
 *
 *  1. Outline (LIFT_OUTLINE_S): a thin accent outline of the object's box draws on round it.
 *  2. Appear: the model shows exactly over the object (its box's place and size; a flat thing
 *     seen flat-on, as the camera sees it), fully opaque within LIFT_APPEAR_S. It waits here (outline
 *     drawn) until the renderer says its models are ready, so nothing pops in mid-air.
 *  3. Rise (LIFT_MOVE_S after a short hold): position, size and angle travel together on one
 *     ease-out curve with a slight overshoot (liftCurve: backOut, LIFT_OVERSHOOT, after a short
 *     take-off from rest). The start point follows the
 *     tracked object for the first third, then lets go; the parts only begin to separate in the last
 *     third (spreadK); the outline fades as the model leaves.
 *  4. Up: labels and the title fade in (labels; `arrived` for the HUD).
 *  5. Put away (AWAY_S, shorter if it was not up yet): labels out at once, the parts close in the
 *     first half, it shrinks and settles (ease in-out) into the object's current box, or the saved
 *     pill, fading over the last AWAY_FADE_S. Opened again while going away, it rises from there.
 * prefers-reduced-motion: no outline and no travel; a short cross-fade in place on the stage instead.
 * Time advances at most MAX_STEP_S per frame (#125): after a late frame it carries on from where it
 * was instead of jumping ahead. OpenMeter measures how smooth the first two seconds of an open were.
 *
 * Pure apart from reading the reduced-motion setting; update() allocates nothing.
 */
import { smoothstep } from './explodeAnimator';
import type { ScreenBox } from './boxRig';

/** The outline draws on for this long before the model appears (s). */
export const LIFT_OUTLINE_S = 0.15;
/** The model goes from invisible to fully opaque over the object in this time (s). */
export const LIFT_APPEAR_S = 0.12;
/** It sits on the object this long after it starts to appear, before it rises (s): opaque on the object first. */
export const LIFT_HOLD_S = 0.12;
/** The rise from the object to the middle of the view (s). */
export const LIFT_MOVE_S = 1.0;
/** backOut constant: 0.8 overshoots by about 2.3% of the way, at 70% of the rise (0 = a plain cubic ease-out). */
export const LIFT_OVERSHOOT = 0.8;
/** The first this share of the rise picks up speed from rest (a lift-off, not a jump to full speed). */
export const LIFT_TAKEOFF = 0.1;
/** The start point follows the tracked object until this share of the rise. */
export const LIFT_FOLLOW_UNTIL = 1 / 3;
/** The parts begin to separate from this share of the rise (and are at the asked amount on arrival). */
export const LIFT_SPREAD_FROM = 2 / 3;
/** Labels and the title fade in over this once it has arrived (s). */
export const LIFT_LABELS_S = 0.3;
/** Put away: back into the object (s); the parts are closed by AWAY_CLOSE of it; it fades over the last AWAY_FADE_S. */
export const AWAY_S = 0.6;
export const AWAY_CLOSE = 0.55;
export const AWAY_FADE_S = 0.15;
/** prefers-reduced-motion: the cross-fade in and out (s). */
export const REDUCED_FADE_S = 0.25;
/**
 * The most an animation step advances in one frame (s), for the lift, the put-away and the stage
 * springs: a late frame (a stall) does not jump them ahead. Idle timers stay on real time.
 */
export const MAX_STEP_S = 1 / 30;

/** A frame's animation step (s) from two frame times (ms): at most MAX_STEP_S; 1/60 for the first. */
export function frameStep(now: number, last: number): number {
  return last ? Math.min(MAX_STEP_S, Math.max(0, (now - last) / 1000)) : 1 / 60;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Ease-out with a small overshoot ("back out"): 0 -> 1, peaking a little above 1 near the end. */
export function backOut(u: number, c = LIFT_OVERSHOOT): number {
  const v = clamp01(u) - 1;
  return 1 + (c + 1) * v * v * v + c * v * v;
}

/**
 * The rise: backOut, with its first LIFT_TAKEOFF of time picking up speed from rest (the time is
 * remapped: quadratic, then linear, slope continuous), so it lifts off instead of jumping to speed.
 */
export function liftCurve(u: number): number {
  const x = clamp01(u);
  const a = LIFT_TAKEOFF;
  const g = (x < a ? (x * x) / (2 * a) : x - a / 2) / (1 - a / 2);
  return backOut(g);
}

/** Cubic ease in-out, 0 -> 1. */
export function easeInOut(u: number): number {
  const x = clamp01(u);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/**
 * True for the short cross-fade instead of the lift-out: the system's reduced-motion setting, or
 * `?lift=0` in the address (a way back if the transition misbehaves on the real rig).
 */
export function prefersReducedMotion(): boolean {
  try {
    if (typeof window === 'undefined') return false;
    if (new URLSearchParams(window.location.search).get('lift') === '0') return true;
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export type LiftPhase = 'idle' | 'out' | 'up' | 'away';

export class Lift {
  phase: LiftPhase = 'idle';
  /** 0 = on the object, 1 = in the middle of the view (a few % past it at the overshoot) */
  pos = 0;
  /** the model's opacity */
  opacity = 0;
  /** the object's outline: how much of it is drawn (0..1), and its opacity */
  outlineDrawn = 0;
  outlineOpacity = 0;
  /** the start point (the object's box) follows the tracked object */
  follow = true;
  /** multiplies the explode amount shown: 0 while it rises, 1 on arrival, back to 0 as it is put away */
  spreadK = 0;
  /** part labels: 0..1 (only once it has arrived) */
  labels = 0;
  /** up in the middle of the view (the HUD shows the title) */
  arrived = false;
  /** time in the current phase (s) */
  private t = 0;
  /** phase 'out': when the model started to appear (-1 = not yet) */
  private appearAt = -1;
  /** phase 'out' / 'away': where it started from, the opacity and spread then, and the put-away's length */
  private p0 = 0;
  private o0 = 0;
  private k0 = 0;
  private awayS = AWAY_S;
  private reduced = false;

  /** Nothing to draw: never opened, or put away and finished. */
  get done(): boolean {
    return this.phase === 'idle';
  }

  /** Has the model started to appear (so a model attached now must not fade in)? */
  get shown(): boolean {
    return this.phase !== 'idle' && !(this.phase === 'out' && this.appearAt < 0);
  }

  /**
   * One frame. on = the model is wanted (false = put it away); ready = its models are loaded (or the
   * renderer gave up waiting): the model appears only once ready.
   */
  update(dtIn: number, on: boolean, ready: boolean): void {
    const dt = Math.min(MAX_STEP_S, Math.max(0, dtIn));
    if (on && (this.phase === 'idle' || this.phase === 'away')) this.startOut();
    else if (!on && (this.phase === 'out' || this.phase === 'up')) this.startAway();
    this.t += dt;
    if (this.phase === 'out') this.stepOut(ready);
    else if (this.phase === 'up') this.stepUp();
    else if (this.phase === 'away') this.stepAway();
  }

  private startOut(): void {
    this.reduced = prefersReducedMotion();
    // Opened again while going away: rise from where it is (no outline, no second appear).
    this.p0 = this.phase === 'away' ? this.pos : 0;
    this.o0 = this.phase === 'away' ? this.opacity : 0;
    this.appearAt = this.p0 > 0 || this.o0 > 0 ? 0 : -1;
    this.phase = 'out';
    this.t = 0;
    this.arrived = false;
  }

  private startAway(): void {
    this.p0 = this.pos;
    this.o0 = this.opacity;
    this.k0 = this.spreadK;
    // Not up yet: a shorter way back (never under a third of the full put-away).
    this.awayS = this.reduced ? REDUCED_FADE_S : AWAY_S * Math.min(1, Math.max(0.35, this.p0));
    this.phase = 'away';
    this.t = 0;
    this.arrived = false;
    this.labels = 0;
    this.follow = true;
    this.outlineOpacity = 0;
  }

  private stepOut(ready: boolean): void {
    this.labels = 0;
    if (this.appearAt < 0) {
      // 1. the outline draws on; the model appears once that is done and its models are ready
      this.pos = 0;
      this.opacity = 0;
      this.spreadK = 0;
      this.follow = true;
      this.outlineDrawn = this.reduced ? 0 : clamp01(this.t / LIFT_OUTLINE_S);
      this.outlineOpacity = this.reduced ? 0 : 1;
      if (ready && (this.reduced || this.t >= LIFT_OUTLINE_S)) this.appearAt = this.t;
      else return;
    }
    const tau = this.t - this.appearAt;
    if (this.reduced) {
      // a cross-fade on the stage, no travel
      this.pos = 1;
      this.opacity = Math.max(this.o0, clamp01(tau / REDUCED_FADE_S));
      this.spreadK = 1;
      this.follow = false;
      this.outlineDrawn = this.outlineOpacity = 0;
      if (tau >= REDUCED_FADE_S) this.toUp();
      return;
    }
    // 2. appear on the object (or keep the opacity it had when it was opened again)
    this.opacity = Math.max(this.o0, clamp01(tau / LIFT_APPEAR_S));
    // 3. rise: one curve for position, size and angle
    const move = LIFT_MOVE_S * (this.p0 > 0 ? Math.max(0.3, 1 - this.p0) : 1);
    const hold = this.p0 > 0 ? 0 : LIFT_HOLD_S;
    const u = clamp01((tau - hold) / move);
    this.pos = this.p0 + (1 - this.p0) * liftCurve(u);
    this.follow = this.p0 === 0 && u < LIFT_FOLLOW_UNTIL;
    this.spreadK = smoothstep(LIFT_SPREAD_FROM, 1, u);
    this.outlineDrawn = 1;
    this.outlineOpacity = this.p0 > 0 ? 0 : 1 - smoothstep(0, 0.4, u);
    if (u >= 1) this.toUp();
  }

  private toUp(): void {
    this.phase = 'up';
    this.t = 0;
    this.stepUp();
  }

  private stepUp(): void {
    this.pos = 1;
    this.opacity = 1;
    this.spreadK = 1;
    this.follow = false;
    this.outlineDrawn = 0;
    this.outlineOpacity = 0;
    this.arrived = true;
    this.labels = this.reduced ? clamp01(this.t / 0.15) : clamp01(this.t / LIFT_LABELS_S);
  }

  private stepAway(): void {
    const v = clamp01(this.t / this.awayS);
    if (this.reduced) {
      this.opacity = this.o0 * (1 - v);
      this.spreadK = this.k0;
    } else {
      this.pos = this.p0 * (1 - easeInOut(v));
      this.opacity = this.o0 * clamp01((this.awayS - this.t) / AWAY_FADE_S);
      this.spreadK = this.k0 * (1 - smoothstep(0, AWAY_CLOSE, v));
    }
    if (this.t >= this.awayS) {
      this.phase = 'idle';
      this.pos = 0;
      this.opacity = 0;
      this.spreadK = 0;
    }
  }
}

/** How long after a model is asked for its frames are watched (ms). */
export const OPEN_WINDOW_MS = 2000;

/** The last open's measurement, for the debug panel (D); '' until one has finished. */
export const openReport = { text: '' };

/**
 * #125: the longest gap between frames in the OPEN_WINDOW_MS after a model was asked for, and
 * whether its models were warm. The overlay calls frame() every frame, start() when a model is asked
 * for (or arrives unasked) and note() when its parts list is known.
 */
export class OpenMeter {
  private at = -1;
  private last = 0;
  private worst = 0;
  private what = '';
  private warm: boolean | null = null;

  /** A model was asked for. Ignored while an open is being measured. */
  start(now: number): void {
    if (this.at >= 0) return;
    this.at = now;
    this.worst = 0;
    this.what = '';
    this.warm = null;
  }

  /** Its parts list arrived: what it is and whether its models were warm (the first note counts). */
  note(what: string, warm: boolean): void {
    if (this.at < 0 || this.warm !== null) return;
    this.what = what;
    this.warm = warm;
  }

  /** Every frame (ms). Returns the report once, when the window has passed. */
  frame(now: number): string | null {
    const prev = this.last;
    this.last = now;
    if (this.at < 0) return null;
    // Every frame that began inside the window counts, the one that crosses its end too.
    if (prev && prev >= this.at && prev - this.at < OPEN_WINDOW_MS) this.worst = Math.max(this.worst, now - prev);
    if (now - this.at < OPEN_WINDOW_MS) return null;
    this.at = -1;
    const warm = this.warm === null ? 'no model' : this.warm ? 'warm' : 'cold';
    const text = `last open: ${this.what || '-'}, longest frame gap ${Math.round(this.worst)} ms in the first ${OPEN_WINDOW_MS / 1000} s, models ${warm}`;
    openReport.text = text;
    return text;
  }
}

/** Saved pills (src/hud/SavedRow.tsx): where each was last drawn, for lifting out of / going into it. */
const pillBoxes = new Map<string, ScreenBox>();

/** SavedRow: record a pill's picture (the round thumb at its left) in viewport px. */
export function notePillBox(id: string, box: ScreenBox): void {
  pillBoxes.set(id, box);
}

/** Where the first pill's picture is when none has been seen yet (the saved row's top left). */
const FIRST_PILL: ScreenBox = { cx: 36, cy: 38, w: 28, h: 28 };

/** A saved model's pill picture, else the first pill of the saved row (top left). Read only. */
export function pillBox(id: string | null): ScreenBox {
  const hit = id ? pillBoxes.get(id) : undefined;
  return hit ?? FIRST_PILL;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
/** The outline sits this far outside the object's box (px). */
const OUTLINE_PAD = 4;

/**
 * The thin accent outline of the object's box that draws on just before the model appears (one
 * per renderer, in its label host). Accent: the look's --bf-color-accent (kit), #4DA3FF otherwise.
 */
export class LiftOutline {
  private readonly svg: SVGSVGElement;
  private readonly rect: SVGRectElement;
  private shown = false;

  constructor(host: HTMLElement) {
    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.setAttribute('width', '100%');
    this.svg.setAttribute('height', '100%');
    Object.assign(this.svg.style, { position: 'absolute', inset: '0', overflow: 'visible', pointerEvents: 'none', display: 'none' });
    this.rect = document.createElementNS(SVG_NS, 'rect');
    this.rect.setAttribute('fill', 'none');
    this.rect.setAttribute('rx', '10');
    this.rect.setAttribute('pathLength', '1');
    this.rect.setAttribute('stroke-dasharray', '1 1');
    this.rect.setAttribute('stroke-linecap', 'round');
    this.rect.setAttribute('stroke-width', '2');
    Object.assign(this.rect.style, {
      stroke: 'var(--bf-color-accent, #4DA3FF)',
      filter: 'drop-shadow(0 0 4px rgba(77, 163, 255, 0.55))',
    });
    this.svg.appendChild(this.rect);
    host.appendChild(this.svg);
  }

  /** The box (viewport px), how much of the outline is drawn, and its opacity; null or 0 hides it. */
  update(box: ScreenBox | null, drawn: number, opacity: number): void {
    if (!box || opacity < 0.01 || drawn <= 0) {
      if (this.shown) {
        this.shown = false;
        this.svg.style.display = 'none';
      }
      return;
    }
    if (!this.shown) {
      this.shown = true;
      this.svg.style.display = '';
    }
    const r = this.rect;
    r.setAttribute('x', (box.cx - box.w / 2 - OUTLINE_PAD).toFixed(1));
    r.setAttribute('y', (box.cy - box.h / 2 - OUTLINE_PAD).toFixed(1));
    r.setAttribute('width', Math.max(1, box.w + 2 * OUTLINE_PAD).toFixed(1));
    r.setAttribute('height', Math.max(1, box.h + 2 * OUTLINE_PAD).toFixed(1));
    r.setAttribute('stroke-dashoffset', (1 - clamp01(drawn)).toFixed(3));
    r.setAttribute('opacity', clamp01(opacity).toFixed(3));
  }

  dispose(): void {
    this.svg.remove();
  }
}
