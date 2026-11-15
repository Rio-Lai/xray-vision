/**
 * Runs the gesture recogniser (gestures.ts) once per animation frame on the tracked hands and
 * turns its output into model control: drag -> modelControl.turn (inertia on release), two-hand
 * spread / burst -> modelControl.setExplode. Active only while a model is on stage; any free hand
 * can gesture, including one that is itself the subject of the current teardown, but not one that
 * is typing or resting on the laptop (#107: it passes key presses and laptop boxes to the recogniser).
 * `gestureLive` is read by the overlay (the pinch dot) and by the debug panel.
 */
import { useStore } from '../state/store';
import type { FingerName } from '../state/store';
import { frameSize } from '../camera/frame';
import { devLog } from '../hud/hudStore';
import { STAGE_MIN_EXPLODE, modelControl, stageInputActive } from '../stage/modelControl';
import { live } from './live';
import { GestureRecognizer } from './gestures';
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
  if (out.explode !== null) modelControl.setExplode(out.explode, now);
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
