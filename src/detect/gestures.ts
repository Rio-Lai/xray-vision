/**
 * Hand gestures for the model on stage. Pure: smoothed hands in, gesture state and per-frame
 * actions out (no store, no DOM), so it can be simulated in Node with synthetic landmarks.
 *
 * Every distance is in hand sizes (wrist -> middle MCP, px; TrackedHand.handSize), so it works
 * at any distance from the camera. Per hand, per frame:
 *  - pinch distance = |thumb tip - index tip| / hand size (2D plus half the MediaPipe depth)
 *  - openness       = mean |fingertip - wrist| / hand size over all five fingers
 *                     (open hand ~1.6, fist ~0.8)
 *  - rest openness  = the same over middle, ring and pinky only (a pinch keeps them out; a fist does not)
 *
 * Pinch (hysteresis + hold, like the key-press detector): starts when the distance stays below
 * pinchOn for holdMs while restOpen >= restOpenMin (so a fist never counts); ends when it stays
 * above pinchOff for releaseMs, or when the hand is lost.
 *
 * Gestures (only while `enabled`, i.e. a model is on stage; a pinch already held when they
 * become enabled, or left over from a two-hand spread, must be let go and made again):
 *  - one hand pinching, dragging: turn the model like a globe, rotGain radians per hand size
 *    moved (right = turn right, down = tip the top towards you); on release the caller coasts.
 *    The drag follows the palm centre (wrist and knuckles), not the pinch point, which moves as
 *    the fingers open: letting go never flicks the model. A single pinch becomes a drag only
 *    after DRAG_DELAY_MS, so pinching with both hands goes straight to the spread.
 *  - two hands pinching (twoHand): explode = (amount when both pinches began)
 *    + spreadGain * log2(distance between the pinch points / distance at the start), so doubling
 *    the distance adds spreadGain and halving it takes it away; clamped to [minExplode, 1]
 *  - one hand fist -> spread within burstMs (burst): explode to 1; spread -> fist: back to minExplode.
 *    The hand must have been a fist (or spread) for FIST_HOLD_MS first, and the new state must hold
 *    for holdMs, so typing and resting hands (never a full fist) do not fire it.
 *
 * Only a deliberate, free hand gestures (#107): a judge typing on the laptop in full view must not
 * turn the model. A hand small in the frame (wrist to middle knuckle below restHandMax of the frame
 * height: on the desk at arm's length, not raised towards the head camera) is blocked (no pinch
 * starts, a held pinch goes stale, no burst, no dot) while
 *  - 'typing':  it pressed a key within typingMs (GestureHandInput.lastPressAt, from the hand tracker);
 *  - 'resting': its palm centre is inside a laptop or keyboard box (GestureContext.restBoxes).
 * A raised hand is never 'typing' or 'resting': the key-press detector also fires now and then on a
 * still hand's tracking jitter, and that must never lock out the wearer. Any hand is blocked while
 *  - 'new':     it has been tracked for less than MIN_TRACKED_MS (just come into view, or re-found).
 */

export interface GestureLandmark {
  x: number;
  y: number;
  z: number;
}

export interface GestureHandInput {
  id: string;
  /** 21 smoothed MediaPipe landmarks, normalised frame coords */
  lm: GestureLandmark[];
  /** wrist -> middle MCP in frame px */
  handSize: number;
  /** when this hand last pressed a key (same clock as `now`): a typing hand does not gesture */
  lastPressAt?: number;
}

export interface GestureTuning {
  /** master switch (debug panel) */
  enabled: boolean;
  /** pinch starts below this many hand sizes (thumb tip to index tip) */
  pinchOn: number;
  /** pinch ends above this */
  pinchOff: number;
  /** a pinch (or a fist / spread for the burst) must hold this long before it counts (ms) */
  holdMs: number;
  /** a pinch must stay open this long before it is released (ms): tracking noise does not drop it */
  releaseMs: number;
  /** middle, ring and pinky must be at least this open (hand sizes) for a pinch: not a fist */
  restOpenMin: number;
  /** radians per hand size of pinch-drag */
  rotGain: number;
  /** explode change per doubling of the two-hand distance */
  spreadGain: number;
  /** two-hand pinch spread explodes */
  twoHand: boolean;
  /** one-hand fist -> spread burst explodes */
  burst: boolean;
  /** openness at or below this is a fist */
  fistMax: number;
  /** openness at or above this is a spread hand */
  spreadMin: number;
  /** fist -> spread (or back) must happen within this (ms) */
  burstMs: number;
  /** a hand that pressed a key this recently is typing and does not gesture (ms; 0 = off) */
  typingMs: number;
  /**
   * a hand smaller than this share of the frame height (wrist -> middle MCP) is on the desk, not raised
   * towards the camera: it does not gesture while typing or with its palm on a laptop or keyboard
   */
  restHandMax: number;
}

export const GESTURE_TUNING_DEFAULTS: GestureTuning = {
  enabled: true,
  pinchOn: 0.25,
  pinchOff: 0.4,
  holdMs: 100,
  releaseMs: 60,
  restOpenMin: 1.05,
  rotGain: 1.1,
  spreadGain: 0.9,
  twoHand: true,
  burst: false,
  fistMax: 1.0,
  spreadMin: 1.5,
  burstMs: 450,
  typingMs: 1500,
  restHandMax: 0.22,
};

/** How long a fist (or a spread hand) must have been held before a burst can start from it. */
const FIST_HOLD_MS = 120;
/** Pitch follows the drag a little less than yaw (tipping is the rarer move). */
const PITCH_FACTOR = 0.8;
/** Depth counts this much in the pinch distance (MediaPipe z is noisy). */
const Z_WEIGHT = 0.5;
/** Smoothing of the pinch point (per frame at ~50 fps), on top of the hand tracker's own. */
const POINT_ALPHA = 0.55;
/** A single frame's drag step is capped (hand sizes): a tracking jump never flings the model. */
const MAX_STEP_HS = 0.6;
/** A lone pinch waits this long for a second one before it starts turning the model. */
const DRAG_DELAY_MS = 110;
/** Palm centre: wrist and the four knuckles (they do not move when the fingers open or close). */
const PALM = [0, 5, 9, 13, 17];
/** A hand must have been tracked this long before its first pinch can start (ms). */
export const MIN_TRACKED_MS = 300;

export type GestureMode = 'idle' | 'drag' | 'spread';
export type GestureEvent = 'pinch' | 'unpinch' | 'drag-start' | 'drag-end' | 'spread-start' | 'spread-end' | 'burst-open' | 'burst-close';
type OpenState = 'fist' | 'mid' | 'spread';
/** Why a hand does not count for gestures right now (null = it does). */
export type HandBlock = 'typing' | 'resting' | 'new' | null;

export interface HandGestureInfo {
  id: string;
  pinchDist: number;
  open: number;
  restOpen: number;
  pinched: boolean;
  /** pinched but waiting for a fresh pinch (held when gestures began, or left from a spread) */
  stale: boolean;
  openState: OpenState;
  /** wrist -> middle MCP as a share of the frame height (compare restHandMax) */
  size: number;
  blocked: HandBlock;
}

export interface GestureDot {
  id: string;
  /** normalised frame coords */
  x: number;
  y: number;
}

export interface GestureOutput {
  mode: GestureMode;
  /** radians to turn by this frame (drag mode only) */
  dYaw: number;
  dPitch: number;
  /** a drag ended this frame: 'release' = let go (coast), 'cancel' = became a spread / disabled (stop) */
  dragEnd: 'release' | 'cancel' | null;
  /** explode amount to set this frame, or null */
  explode: number | null;
  events: GestureEvent[];
  /** active pinch points, for the small on-screen cue */
  dots: GestureDot[];
  hands: HandGestureInfo[];
}

export interface GestureContext {
  enabled: boolean;
  /** current store.explodeAmount (where a two-hand spread starts from) */
  explode: number;
  /** lowest explode amount gestures go to (the analyse state) */
  minExplode: number;
  /** laptop and keyboard boxes in view, normalised frame coords: a small hand resting on one does not gesture */
  restBoxes?: { x: number; y: number; w: number; h: number }[];
}

interface HandTrack {
  id: string;
  seen: boolean;
  /** when this hand was first tracked */
  bornAt: number;
  pinched: boolean;
  stale: boolean;
  closeSince: number | null;
  openSince: number | null;
  /** smoothed pinch point (the on-screen cue and the two-hand distance), frame px */
  px: number;
  py: number;
  /** smoothed palm centre (the drag), frame px */
  cx: number;
  cy: number;
  /** when the current pinch began */
  pinchAt: number;
  hs: number;
  /** burst */
  openState: OpenState;
  openStateSince: number;
  /** the last held fist / spread: when it was last true */
  lastFistAt: number;
  lastSpreadAt: number;
  fistHeldSince: number | null;
  spreadHeldSince: number | null;
  /** candidate burst: target state and when it started */
  info: HandGestureInfo;
}

const TIPS = [4, 8, 12, 16, 20];
const REST_TIPS = [12, 16, 20];

function dist2(a: GestureLandmark, b: GestureLandmark, fw: number, fh: number): number {
  return Math.hypot((a.x - b.x) * fw, (a.y - b.y) * fh);
}

/** Whether (x, y) (normalised frame coords) is inside any of the boxes. */
function onBox(x: number, y: number, boxes: GestureContext['restBoxes']): boolean {
  return !!boxes && boxes.some((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
}

/** Features of one hand: pinch distance, openness, rest openness (hand sizes), pinch point (frame px). */
export function handFeatures(
  lm: GestureLandmark[],
  handSize: number,
  fw: number,
  fh: number,
): { pinchDist: number; open: number; restOpen: number; px: number; py: number; cx: number; cy: number } {
  const hs = Math.max(8, handSize);
  const t = lm[4];
  const i = lm[8];
  const pinchDist = Math.hypot((t.x - i.x) * fw, (t.y - i.y) * fh, (t.z - i.z) * fw * Z_WEIGHT) / hs;
  let open = 0;
  for (const k of TIPS) open += dist2(lm[k], lm[0], fw, fh);
  open /= TIPS.length * hs;
  let rest = 0;
  for (const k of REST_TIPS) rest += dist2(lm[k], lm[0], fw, fh);
  rest /= REST_TIPS.length * hs;
  let cx = 0;
  let cy = 0;
  for (const k of PALM) {
    cx += lm[k].x;
    cy += lm[k].y;
  }
  return {
    pinchDist,
    open,
    restOpen: rest,
    px: ((t.x + i.x) / 2) * fw,
    py: ((t.y + i.y) / 2) * fh,
    cx: (cx / PALM.length) * fw,
    cy: (cy / PALM.length) * fh,
  };
}

export class GestureRecognizer {
  private tracks = new Map<string, HandTrack>();
  private mode: GestureMode = 'idle';
  private dragId: string | null = null;
  private spreadIds: [string, string] = ['', ''];
  private dragX = 0;
  private dragY = 0;
  private spreadD0 = 1;
  private spreadE0 = 0;
  private lastExplode: number | null = null;
  private wasEnabled = false;

  reset(): void {
    this.tracks.clear();
    this.mode = 'idle';
    this.dragId = null;
    this.lastExplode = null;
  }

  getMode(): GestureMode {
    return this.mode;
  }

  update(hands: GestureHandInput[], now: number, fw: number, fh: number, ctx: GestureContext, tu: GestureTuning): GestureOutput {
    const out: GestureOutput = { mode: 'idle', dYaw: 0, dPitch: 0, dragEnd: null, explode: null, events: [], dots: [], hands: [] };
    const enabled = ctx.enabled && tu.enabled;
    const justEnabled = enabled && !this.wasEnabled;
    this.wasEnabled = enabled;

    // 1. Per-hand features and pinch / openness state.
    for (const t of this.tracks.values()) t.seen = false;
    for (const h of hands) {
      if (!h.lm || h.lm.length < 21) continue;
      const f = handFeatures(h.lm, h.handSize, fw, fh);
      let t = this.tracks.get(h.id);
      if (!t) {
        t = {
          id: h.id,
          seen: true,
          bornAt: now,
          pinched: false,
          stale: false,
          closeSince: null,
          openSince: null,
          px: f.px,
          py: f.py,
          cx: f.cx,
          cy: f.cy,
          pinchAt: now,
          hs: Math.max(8, h.handSize),
          openState: 'mid',
          openStateSince: now,
          lastFistAt: -1e9,
          lastSpreadAt: -1e9,
          fistHeldSince: null,
          spreadHeldSince: null,
          info: { id: h.id, pinchDist: f.pinchDist, open: f.open, restOpen: f.restOpen, pinched: false, stale: false, openState: 'mid', size: 0, blocked: 'new' },
        };
        this.tracks.set(h.id, t);
      }
      t.seen = true;
      t.hs = Math.max(8, h.handSize);
      const wasPinched = t.pinched;
      // Only a deliberate, free hand: not one on the desk typing or resting on the laptop, not one just come into view.
      const size = h.handSize / Math.max(1, fh);
      const onDesk = size < tu.restHandMax;
      const blocked: HandBlock =
        onDesk && h.lastPressAt !== undefined && now - h.lastPressAt < tu.typingMs
          ? 'typing'
          : onDesk && onBox(f.cx / fw, f.cy / fh, ctx.restBoxes)
            ? 'resting'
            : now - t.bornAt < MIN_TRACKED_MS
              ? 'new'
              : null;
      // Pinch with hysteresis and hold times.
      const closeEnough = blocked === null && f.pinchDist < tu.pinchOn && f.restOpen >= tu.restOpenMin;
      if (!t.pinched) {
        t.openSince = null;
        if (closeEnough) {
          if (t.closeSince === null) t.closeSince = now;
          if (now - t.closeSince >= tu.holdMs) {
            t.pinched = true;
            t.stale = !enabled || justEnabled;
            t.pinchAt = now;
            t.px = f.px;
            t.py = f.py;
          }
        } else {
          t.closeSince = null;
        }
      } else {
        t.closeSince = null;
        if (f.pinchDist > tu.pinchOff) {
          if (t.openSince === null) t.openSince = now;
          if (now - t.openSince >= tu.releaseMs) t.pinched = false;
        } else {
          t.openSince = null;
        }
      }
      // A pinch held while gestures were off does not count until it is made again.
      if (t.pinched && justEnabled) t.stale = true;
      if (t.pinched && !enabled) t.stale = true;
      // A held pinch whose hand starts typing or resting stops counting; it must be made again.
      if (t.pinched && blocked !== null) t.stale = true;
      if (!t.pinched) t.stale = false;
      if (t.pinched && !wasPinched) out.events.push('pinch');
      if (!t.pinched && wasPinched) out.events.push('unpinch');

      // Smoothed pinch point (only meaningful while pinched; reset on a new pinch above) and palm centre.
      if (t.pinched) {
        t.px += (f.px - t.px) * POINT_ALPHA;
        t.py += (f.py - t.py) * POINT_ALPHA;
      }
      t.cx += (f.cx - t.cx) * POINT_ALPHA;
      t.cy += (f.cy - t.cy) * POINT_ALPHA;

      // Openness state for the burst, with hold times.
      const raw: OpenState = f.open <= tu.fistMax ? 'fist' : f.open >= tu.spreadMin ? 'spread' : 'mid';
      if (raw === 'fist') {
        if (t.fistHeldSince === null) t.fistHeldSince = now;
        t.spreadHeldSince = null;
      } else if (raw === 'spread') {
        if (t.spreadHeldSince === null) t.spreadHeldSince = now;
        t.fistHeldSince = null;
      } else {
        t.fistHeldSince = null;
        t.spreadHeldSince = null;
      }
      const prevState = t.openState;
      if (t.fistHeldSince !== null && now - t.fistHeldSince >= tu.holdMs) t.openState = 'fist';
      else if (t.spreadHeldSince !== null && now - t.spreadHeldSince >= tu.holdMs) t.openState = 'spread';
      else if (raw === 'mid') t.openState = 'mid';
      if (t.openState !== prevState) t.openStateSince = now;
      // Remember when a fist / spread was last firmly held (FIST_HOLD_MS), for the burst window.
      if (t.fistHeldSince !== null && now - t.fistHeldSince >= FIST_HOLD_MS) t.lastFistAt = now;
      if (t.spreadHeldSince !== null && now - t.spreadHeldSince >= FIST_HOLD_MS) t.lastSpreadAt = now;
      if (enabled && tu.burst && blocked === null && this.mode === 'idle' && t.openState !== prevState) {
        // The confirmed new state started holdMs ago; the old one must have ended within burstMs before that.
        const startedAt = now - tu.holdMs;
        if (t.openState === 'spread' && startedAt - t.lastFistAt <= tu.burstMs) {
          out.events.push('burst-open');
          out.explode = 1;
          t.lastFistAt = -1e9;
        } else if (t.openState === 'fist' && startedAt - t.lastSpreadAt <= tu.burstMs) {
          out.events.push('burst-close');
          out.explode = ctx.minExplode;
          t.lastSpreadAt = -1e9;
        }
      }

      t.info = { id: h.id, pinchDist: f.pinchDist, open: f.open, restOpen: f.restOpen, pinched: t.pinched, stale: t.stale, openState: t.openState, size, blocked };
    }
    // Hands that left the view: their pinch ends at once.
    for (const [id, t] of this.tracks) {
      if (t.seen) continue;
      if (t.pinched) out.events.push('unpinch');
      this.tracks.delete(id);
    }

    // 2. Mode: spread (two fresh pinches), drag (one), idle.
    const live = [...this.tracks.values()].filter((t) => t.pinched && !t.stale);
    if (!enabled) {
      if (this.mode === 'drag') {
        out.dragEnd = 'cancel';
        out.events.push('drag-end');
      }
      if (this.mode === 'spread') out.events.push('spread-end');
      this.mode = 'idle';
      this.dragId = null;
    } else if (this.mode === 'spread') {
      const a = this.tracks.get(this.spreadIds[0]);
      const b = this.tracks.get(this.spreadIds[1]);
      if (!a || !b || !a.pinched || !b.pinched || a.stale || b.stale || !tu.twoHand) {
        // One hand let go: the other must pinch again before it turns the model.
        for (const t of [a, b]) if (t && t.pinched) t.stale = true;
        this.mode = 'idle';
        out.events.push('spread-end');
      } else {
        const d = Math.max(1, Math.hypot(a.px - b.px, a.py - b.py));
        const target = Math.min(1, Math.max(ctx.minExplode, this.spreadE0 + tu.spreadGain * Math.log2(d / this.spreadD0)));
        if (this.lastExplode === null || Math.abs(target - this.lastExplode) > 0.002) {
          out.explode = target;
          this.lastExplode = target;
        }
      }
    } else if (live.length >= 2 && tu.twoHand) {
      if (this.mode === 'drag') {
        out.dragEnd = 'cancel';
        out.events.push('drag-end');
        this.dragId = null;
      }
      const [a, b] = live;
      this.spreadIds = [a.id, b.id];
      this.spreadD0 = Math.max(1, Math.hypot(a.px - b.px, a.py - b.py));
      this.spreadE0 = Math.min(1, Math.max(ctx.minExplode, ctx.explode));
      this.lastExplode = null;
      this.mode = 'spread';
      out.events.push('spread-start');
    } else if (this.mode === 'drag') {
      const t = this.dragId ? this.tracks.get(this.dragId) : undefined;
      if (!t || !t.pinched || t.stale) {
        this.mode = 'idle';
        this.dragId = null;
        // Let go: coast. Blocked mid-drag (it started typing or resting): stop dead, no fling.
        out.dragEnd = t && t.pinched && t.info.blocked !== null ? 'cancel' : 'release';
        out.events.push('drag-end');
      } else {
        const cap = (v: number) => Math.max(-MAX_STEP_HS, Math.min(MAX_STEP_HS, v));
        const dx = cap((t.cx - this.dragX) / t.hs);
        const dy = cap((t.cy - this.dragY) / t.hs);
        this.dragX = t.cx;
        this.dragY = t.cy;
        out.dYaw = dx * tu.rotGain;
        out.dPitch = dy * tu.rotGain * PITCH_FACTOR;
      }
    } else if (live.length >= 1 && now - live[0].pinchAt >= DRAG_DELAY_MS) {
      const t = live[0];
      this.mode = 'drag';
      this.dragId = t.id;
      this.dragX = t.cx;
      this.dragY = t.cy;
      out.events.push('drag-start');
    }

    out.mode = this.mode;
    for (const t of this.tracks.values()) {
      out.hands.push(t.info);
      if (enabled && t.pinched && !t.stale) out.dots.push({ id: t.id, x: t.px / fw, y: t.py / fh });
    }
    return out;
  }
}
