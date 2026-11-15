/**
 * Runs the gesture recogniser (gestures.ts) once per animation frame on the tracked hands and
 * turns its output into model control (#121, Rio's mapping of 15 Nov):
 *  - one-hand pinch (drag) and fist grab -> modelControl.panBy: the model follows the hand on screen
 *    (panGain times); with ?pinchturn=1 a pinch turns it instead (modelControl.turn, inertia on release);
 *  - globe (two open hands) -> modelControl.turn;
 *  - two-hand pinch apart / together -> modelControl.setExplode and, past fully open, setZoom
 *    (spreadExplodeZoom, #109); moved together the same way (?pan=1) -> panBy;
 *  - sweep (a flat hand from the top of the frame down) -> closes the exploded view (STAGE_MIN_EXPLODE);
 *  - burst (?burst=1: fist <-> open hand, quickly) -> burstAction: open one stage further, close one back.
 * It tells the recogniser where the model is on screen (modelBox), so an open hand over it can grab it.
 * Active only while a model is on stage; any free hand can gesture, including one that is itself the
 * subject of the current teardown, but not one that is typing or resting on the laptop (#107: it
 * passes key presses and laptop boxes to the recogniser).
 * `gestureLive` is read by the overlay (the hand markers and the one-word hint) and the debug panel.
 * Allocation-free per frame: the recogniser's inputs and context are reused.
 */
import { MODEL_ZOOM_MAX, useStore } from '../state/store';
import type { FingerName } from '../state/store';
import { frameSize, getCoverMap, viewToFrame } from '../camera/frame';
import { devLog } from '../hud/hudStore';
import { PAN_UNIT_VH, STAGE_MIN_EXPLODE, modelControl, panPx, stageInputActive } from '../stage/modelControl';
import { BOTTOM_MARGIN, STAGE_SIZE, TOP_MARGIN } from '../overlay/boxRig';
import { live } from './live';
import { GestureRecognizer, burstAction, spreadExplodeZoom } from './gestures';
import type { GestureContext, GestureHandInput, GestureOutput } from './gestures';
import { gestureTuning } from './gestureTuning';
import type { TrackedHand } from './handTracker';

/** The one-word cue shown above the voice pill while a gesture is doing something. */
export type GestureHint = 'Turning' | 'Opening' | 'Closing' | 'Zooming' | 'Moving';

export interface GestureLive {
  out: GestureOutput | null;
  /** the last events, for the debug panel */
  last: string;
  lastAt: number;
  /** the one-word cue now, or null */
  hint: GestureHint | null;
}

export const gestureLive: GestureLive = { out: null, last: '-', lastAt: 0, hint: null };

const recognizer = new GestureRecognizer();
/** Explode amount, zoom and pan when the current two-hand pinch began, and what it last set. */
const two = { e0: 0, z0: 1, px0: 0, py0: 0, e: -1, z: -1, hint: null as GestureHint | null };
/** Changes smaller than these are tracking jitter: not written (as the recogniser does for explode). */
const SPREAD_MIN_DE = 0.002;
const SPREAD_MIN_DZ = 0.003;
/** The cue stays this long after a burst (ms), and while a globe turn moved the model this recently. */
const BURST_HINT_MS = 900;
const GLOBE_HINT_MS = 300;
const burstHint = { word: null as GestureHint | null, at: -1e9 };

/**
 * Key presses of these fingers mean the hand is typing. Not the thumb or the index: closing a pinch
 * moves them just like a key press.
 */
const TYPING_FINGERS: FingerName[] = ['middle', 'ring', 'pinky'];
/** Detector labels a hand rests and types on. */
const REST_LABELS = new Set(['laptop', 'keyboard']);

const inputs: GestureHandInput[] = [];
const restBoxes: NonNullable<GestureContext['restBoxes']> = [];
const modelBox = { x: 0, y: 0, w: 0, h: 0 };
const ctx: GestureContext = { enabled: false, explode: 0, minExplode: STAGE_MIN_EXPLODE, restBoxes, modelBox: null };
/** The model counts as this much bigger than its normal size for "over the model" (a hand near it can grab it). */
const GRAB_BOX_GROW = 1.35;
const sweepHint = { at: -1e9 };

/** Where the model on stage is (every stage renderer: centre of the free area plus pan, STAGE_SIZE times zoom), normalised frame coords. */
function updateModelBox(s: ReturnType<typeof useStore.getState>): void {
  const map = getCoverMap();
  const vw = map.vw;
  const vh = map.vh;
  const availH = Math.max(100, vh - TOP_MARGIN - BOTTOM_MARGIN);
  const cx = vw / 2 + panPx(s.modelPanX, vh);
  const cy = TOP_MARGIN + availH / 2 + panPx(s.modelPanY, vh);
  const half = (STAGE_SIZE * vh * Math.max(0.5, s.modelZoom) * GRAB_BOX_GROW) / 2;
  const a = viewToFrame(map, cx - half, cy - half);
  const b = viewToFrame(map, cx + half, cy + half);
  modelBox.x = Math.min(a.x, b.x);
  modelBox.y = Math.min(a.y, b.y);
  modelBox.w = Math.abs(b.x - a.x);
  modelBox.h = Math.abs(b.y - a.y);
}

function lastTypingPress(t: TrackedHand): number {
  let m = -1e9;
  for (const f of TYPING_FINGERS) m = Math.max(m, t.dyn[f].lastPressAt);
  return m;
}

export function tickGestures(now: number): void {
  const s = useStore.getState();
  const { w, h } = frameSize();
  const hands = live.hands;
  inputs.length = hands.length;
  for (let i = 0; i < hands.length; i++) {
    const t = hands[i];
    let o = inputs[i];
    if (!o) inputs[i] = o = { id: t.id, lm: t.lm, handSize: t.handSize };
    o.id = t.id;
    o.lm = t.lm;
    o.handSize = t.handSize;
    o.lastPressAt = lastTypingPress(t);
    o.seenAt = t.lastSeen;
    o.world = t.world;
  }
  restBoxes.length = 0;
  for (const o of live.objects) if (REST_LABELS.has(o.label)) restBoxes.push(o.box);
  ctx.enabled = stageInputActive(s);
  ctx.explode = s.explodeAmount;
  if (ctx.enabled) {
    updateModelBox(s);
    ctx.modelBox = modelBox;
  } else {
    ctx.modelBox = null;
  }
  const out = recognizer.update(inputs, now, w, h, ctx, gestureTuning);
  gestureLive.out = out;

  // Turning: a pinch dragging with ?pinchturn=1, or two open hands (the globe). Steps come with new camera frames.
  const turning = out.moved;
  if (out.moved) modelControl.turn(out.dYaw, out.dPitch, now);
  if (out.dragEnd === 'release') modelControl.release(now);
  else if (out.dragEnd === 'cancel') modelControl.stop();
  if (out.mode !== 'idle') modelControl.touch(now);

  // Two hands pinching: apart / together opens and zooms, the same way moves it. A pinch or a grab
  // moves it too: every move is measured from the model's pan when that gesture began.
  if (out.events.includes('two-start') || out.events.includes('drag-start') || out.events.includes('grab-start')) {
    two.e0 = s.explodeAmount;
    two.z0 = s.modelZoom;
    two.px0 = s.modelPanX;
    two.py0 = s.modelPanY;
    two.e = two.z = -1;
    two.hint = null;
  }
  if (out.spreadDelta !== null) {
    // One motion: open up to 1, then zoom in; together: zoom back to 1, then close.
    const ez = spreadExplodeZoom(two.e0, two.z0, out.spreadDelta, STAGE_MIN_EXPLODE, MODEL_ZOOM_MAX);
    if (two.z >= 0 && Math.abs(ez.zoom - two.z) > SPREAD_MIN_DZ * ez.zoom) two.hint = 'Zooming';
    else if (two.e >= 0 && Math.abs(ez.explode - two.e) > SPREAD_MIN_DE) two.hint = ez.explode > two.e ? 'Opening' : 'Closing';
    // (the ends, fully open or closed and zoom 1, are always written: setExplode / setZoom skip no change)
    if (Math.abs(ez.explode - two.e) > SPREAD_MIN_DE || ez.explode >= 1 || ez.explode <= STAGE_MIN_EXPLODE) {
      two.e = ez.explode;
      modelControl.setExplode(ez.explode, now);
    }
    if (Math.abs(ez.zoom - two.z) > SPREAD_MIN_DZ * ez.zoom || ez.zoom === 1 || ez.zoom >= MODEL_ZOOM_MAX) {
      two.z = ez.zoom;
      modelControl.setZoom(ez.zoom, now);
    }
  }
  if (out.pan) {
    // The model follows the hands on screen: frame px -> viewport px -> stage sizes.
    const map = getCoverMap();
    const unit = Math.max(1, PAN_UNIT_VH * map.vh);
    const tx = two.px0 + (out.panX * map.scale) / unit;
    const ty = two.py0 + (out.panY * map.scale) / unit;
    const cur = useStore.getState();
    modelControl.panBy(tx - cur.modelPanX, ty - cur.modelPanY, now);
  }

  // Burst: one stage further open, or one stage back.
  if (out.burst) {
    const a = burstAction(out.burst, s.explodeAmount, s.modelZoom, STAGE_MIN_EXPLODE, MODEL_ZOOM_MAX);
    if (a.explode !== null) modelControl.setExplode(a.explode, now);
    if (a.zoom !== null) modelControl.setZoom(a.zoom, now);
    modelControl.touch(now);
    burstHint.word = a.hint;
    burstHint.at = now;
    devLog(`Gesture: burst-${out.burst} -> ${a.hint ?? 'nothing (already at the end)'}`);
  }

  // Sweep down: close the exploded view (back to the analysed state).
  if (out.sweep) {
    const closing = s.explodeAmount > STAGE_MIN_EXPLODE + 0.01;
    if (closing) modelControl.setExplode(STAGE_MIN_EXPLODE, now);
    modelControl.touch(now);
    if (closing) sweepHint.at = now;
    devLog(`Gesture: sweep down -> ${closing ? 'closed' : 'nothing (already closed)'}`);
  }

  // The one-word cue.
  let hint: GestureHint | null = null;
  if (out.mode === 'drag') hint = out.pan ? 'Moving' : 'Turning';
  else if (out.mode === 'grab') hint = 'Moving';
  else if (out.mode === 'globe') hint = now - recognizer.globeMovedAt < GLOBE_HINT_MS ? 'Turning' : null;
  else if (out.mode === 'spread') hint = two.hint;
  else if (out.mode === 'pan') hint = 'Moving';
  const busy = turning || out.pan || out.mode === 'spread';
  if (!busy && now - burstHint.at < BURST_HINT_MS) hint = burstHint.word;
  if (!busy && now - sweepHint.at < BURST_HINT_MS) hint = 'Closing';
  gestureLive.hint = ctx.enabled ? hint : null;

  if (out.events.length > 0) {
    let shown = false;
    for (const e of out.events) {
      if (e === 'pinch' || e === 'unpinch') continue;
      shown = true;
      if (e === 'spread-start' || e === 'pan-start' || e === 'globe-start' || e === 'grab-start') devLog(`Gesture: ${e}`);
    }
    if (shown) {
      gestureLive.last = out.events.join(', ');
      gestureLive.lastAt = now;
    }
  }
}

export function resetGestures(): void {
  recognizer.reset();
  gestureLive.out = null;
  gestureLive.hint = null;
}
