/**
 * Runs the gesture recogniser (gestures.ts) once per animation frame on the tracked hands and
 * turns its output into model control: drag -> modelControl.turn (inertia on release), two-hand
 * spread -> modelControl.setExplode and, past fully open, setZoom (spreadExplodeZoom, #109),
 * burst -> modelControl.setExplode. Active only while a model is on stage; any free hand
 * can gesture, including one that is itself the subject of the current teardown, but not one that
 * is typing or resting on the laptop (#107: it passes key presses and laptop boxes to the recogniser).
 * `gestureLive` is read by the overlay (the pinch dot) and by the debug panel.
 */
import { MODEL_ZOOM_MAX, useStore } from '../state/store';
import type { FingerName } from '../state/store';
import { frameSize } from '../camera/frame';
import { devLog } from '../hud/hudStore';
import { STAGE_MIN_EXPLODE, modelControl, stageInputActive } from '../stage/modelControl';
import { live } from './live';
import { GestureRecognizer, spreadExplodeZoom } from './gestures';
import type { GestureOutput } from './gestures';
import { gestureTuning } from './gestureTuning';
import type { TrackedHand } from './handTracker';

export interface GestureLive {
  out: GestureOutput | null;
  /** the last events, for the debug panel */
  last: string;
  lastAt: number;
}

export const gestureLive: GestureLive = { out: null, last: '-', lastAt: 0 };

const recognizer = new GestureRecognizer();
/** Explode amount and zoom when the current two-hand spread began, and what it last set. */
const spread = { e0: 0, z0: 1, e: -1, z: -1 };
/** Changes smaller than these are tracking jitter: not written (as the recogniser does for explode). */
const SPREAD_MIN_DE = 0.002;
const SPREAD_MIN_DZ = 0.003;

/**
 * Key presses of these fingers mean the hand is typing. Not the thumb or the index: closing a pinch
 * moves them just like a key press.
 */
const TYPING_FINGERS: FingerName[] = ['middle', 'ring', 'pinky'];
/** Detector labels a hand rests and types on. */
const REST_LABELS = new Set(['laptop', 'keyboard']);

function lastTypingPress(t: TrackedHand): number {
  return Math.max(...TYPING_FINGERS.map((f) => t.dyn[f].lastPressAt));
}

export function tickGestures(now: number): void {
  const s = useStore.getState();
  const { w, h } = frameSize();
  const out = recognizer.update(
    live.hands.map((t) => ({ id: t.id, lm: t.lm, handSize: t.handSize, lastPressAt: lastTypingPress(t) })),
    now,
    w,
    h,
    {
      enabled: stageInputActive(s),
      explode: s.explodeAmount,
      minExplode: STAGE_MIN_EXPLODE,
      restBoxes: live.objects.filter((o) => REST_LABELS.has(o.label)).map((o) => o.box),
    },
    gestureTuning,
  );
  gestureLive.out = out;
  if (out.mode === 'drag') modelControl.turn(out.dYaw, out.dPitch, now);
  if (out.dragEnd === 'release') modelControl.release(now);
  else if (out.dragEnd === 'cancel') modelControl.stop();
  if (out.mode === 'spread' || out.dots.length > 0) modelControl.touch(now);
  if (out.events.includes('spread-start')) {
    spread.e0 = s.explodeAmount;
    spread.z0 = s.modelZoom;
    spread.e = spread.z = -1;
  }
  if (out.spreadDelta !== null) {
    // One motion: open up to 1, then zoom in; together: zoom back to 1, then close.
    const ez = spreadExplodeZoom(spread.e0, spread.z0, out.spreadDelta, STAGE_MIN_EXPLODE, MODEL_ZOOM_MAX);
    // (the ends, fully open or closed and zoom 1, are always written: setExplode / setZoom skip no change)
    if (Math.abs(ez.explode - spread.e) > SPREAD_MIN_DE || ez.explode >= 1 || ez.explode <= STAGE_MIN_EXPLODE) {
      spread.e = ez.explode;
      modelControl.setExplode(ez.explode, now);
    }
    if (Math.abs(ez.zoom - spread.z) > SPREAD_MIN_DZ * ez.zoom || ez.zoom === 1 || ez.zoom >= MODEL_ZOOM_MAX) {
      spread.z = ez.zoom;
      modelControl.setZoom(ez.zoom, now);
    }
  } else if (out.explode !== null) modelControl.setExplode(out.explode, now);
  if (out.events.length > 0) {
    gestureLive.last = out.events.join(', ');
    gestureLive.lastAt = now;
    for (const e of out.events) if (e === 'burst-open' || e === 'burst-close' || e === 'spread-start') devLog(`Gesture: ${e}`);
  }
}

export function resetGestures(): void {
  recognizer.reset();
  gestureLive.out = null;
}
