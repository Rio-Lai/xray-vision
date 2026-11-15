/**
 * Live gesture tuning, read every frame by the gesture driver. Change it with the sliders in the
 * debug panel (D): saved in localStorage, and URL params override (for a quick test on the rig):
 *   ?gestures=0 (all hand gestures off), ?twofinger=0 (index and middle together move it),
 *   ?tfreach=1.35&tfgap=0.4&tfcurl=1.1&tfmargin=0.6&tfhold=120 (the two-finger pose: index and middle
 *   tips at least tfreach from the wrist and at most tfgap apart, ring and pinky tips at most tfcurl
 *   from the wrist and tfmargin nearer it than the index and middle, held tfhold ms; hand sizes: a
 *   larger tfgap / tfcurl or a smaller tfreach / tfmargin is less picky),
 *   ?sweep=0 (flat hand from the top down puts it away), ?snap=0 (a finger snap opens / closes it),
 *   ?globe=0 (two open hands turn it), ?twohand=0 (two-hand pinch apart / together zooms),
 *   ?twoopen=1 (that pinch opens it first, then zooms), ?pinchturn=1 (a one-hand pinch-drag turns it;
 *   off by default: a lone pinch does nothing), ?pinchmove=1 (a one-hand pinch-drag moves it),
 *   ?grab=1 (open hand over the model, then a fist, moves it),
 *   ?world=0 (pinch and hand shape from the image, not MediaPipe's 3D hand), ?burst=1 (fist / open hand
 *   flick opens and closes), ?pan=1 (two-hand pinch moved together moves it), ?pangain=1
 *   ?pinch=0.3&unpinch=0.45&hold=90&reach=1&rot=1.1&spread=1&burstms=400&globegain=1.3
 *   &typingms=1500&resthand=0.22 (which hands may gesture, #107; typingms=0 turns the typing rule off)
 * #121 and Rio's mappings (15 Nov, third pass: two fingers pan, two open hands turn, two-hand pinch
 * zooms, snap opens / closes, sweep puts away; a lone pinch, the grab, burst and two-hand pan off)
 * changed the defaults, so the saved sliders live under a new key: everyone starts from the new
 * defaults once (older keys are ignored).
 */
import { urlNumber } from '../camera/frame';
import { GESTURE_TUNING_DEFAULTS } from './gestures';
import type { GestureTuning } from './gestures';

// v6 (Rio, 15 Nov 10:39): a one-hand pinch-drag turns the model again; the two-palm globe and the sweep down are off (?globe=1, ?sweep=1).
const KEY = 'blowfish.gestureTuning.v6';

function urlBool(name: string): boolean | null {
  try {
    const v = new URLSearchParams(window.location.search).get(name);
    if (v === null) return null;
    return v === '1' || v === 'true' || v === 'on';
  } catch {
    return null;
  }
}

function load(): GestureTuning {
  let saved: Partial<GestureTuning> = {};
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) saved = JSON.parse(raw) as Partial<GestureTuning>;
  } catch {
    /* private mode or bad JSON: defaults */
  }
  const t: GestureTuning = { ...GESTURE_TUNING_DEFAULTS };
  for (const k of Object.keys(GESTURE_TUNING_DEFAULTS) as (keyof GestureTuning)[]) {
    const v = saved[k];
    if (typeof v === typeof GESTURE_TUNING_DEFAULTS[k] && (typeof v !== 'number' || Number.isFinite(v))) {
      (t as unknown as Record<string, unknown>)[k] = v;
    }
  }
  t.pinchOn = urlNumber('pinch', t.pinchOn);
  t.pinchOff = urlNumber('unpinch', t.pinchOff);
  t.holdMs = urlNumber('hold', t.holdMs);
  t.pinchReachMin = urlNumber('reach', t.pinchReachMin);
  t.rotGain = urlNumber('rot', t.rotGain);
  t.spreadGain = urlNumber('spread', t.spreadGain);
  t.burstMs = urlNumber('burstms', t.burstMs);
  t.globeGain = urlNumber('globegain', t.globeGain);
  t.typingMs = urlNumber('typingms', t.typingMs);
  t.restHandMax = urlNumber('resthand', t.restHandMax);
  t.panGain = urlNumber('pangain', t.panGain);
  t.twoFingerReach = urlNumber('tfreach', t.twoFingerReach);
  t.twoFingerGap = urlNumber('tfgap', t.twoFingerGap);
  t.twoFingerCurl = urlNumber('tfcurl', t.twoFingerCurl);
  t.twoFingerMargin = urlNumber('tfmargin', t.twoFingerMargin);
  t.twoFingerHoldMs = urlNumber('tfhold', t.twoFingerHoldMs);
  t.twoFinger = urlBool('twofinger') ?? t.twoFinger;
  t.burst = urlBool('burst') ?? t.burst;
  t.globe = urlBool('globe') ?? t.globe;
  t.twoHand = urlBool('twohand') ?? t.twoHand;
  t.pan = urlBool('pan') ?? t.pan;
  t.world = urlBool('world') ?? t.world;
  // ?pinchturn=1: a one-hand pinch-drag turns it (as before); ?pinchmove=1: moves it; ?pinchturn=0: a lone pinch does nothing
  const pinchTurn = urlBool('pinchturn');
  const pinchMove = urlBool('pinchmove');
  if (pinchTurn !== null) {
    t.pinchDrag = pinchTurn;
    if (pinchTurn) t.pinchTurns = true;
  }
  if (pinchMove) {
    t.pinchDrag = true;
    t.pinchTurns = false;
  }
  t.grab = urlBool('grab') ?? t.grab;
  t.sweep = urlBool('sweep') ?? t.sweep;
  t.snap = urlBool('snap') ?? t.snap;
  t.twoOpens = urlBool('twoopen') ?? t.twoOpens;
  t.enabled = urlBool('gestures') ?? t.enabled;
  return t;
}

export const gestureTuning: GestureTuning = load();

export function setGestureTuning(patch: Partial<GestureTuning>): void {
  Object.assign(gestureTuning, patch);
  try {
    window.localStorage.setItem(KEY, JSON.stringify(gestureTuning));
  } catch {
    /* ignore */
  }
}

/** The current tuning as URL params (shown in the debug panel, to copy into a bookmark). */
export function gestureTuningUrl(t: GestureTuning): string {
  return (
    `pinch=${t.pinchOn.toFixed(2)}&unpinch=${t.pinchOff.toFixed(2)}&hold=${Math.round(t.holdMs)}&reach=${t.pinchReachMin.toFixed(2)}` +
    `&rot=${t.rotGain.toFixed(2)}&spread=${t.spreadGain.toFixed(2)}&burstms=${Math.round(t.burstMs)}&globegain=${t.globeGain.toFixed(2)}` +
    `&burst=${t.burst ? 1 : 0}&globe=${t.globe ? 1 : 0}&twohand=${t.twoHand ? 1 : 0}&pan=${t.pan ? 1 : 0}` +
    `&twofinger=${t.twoFinger ? 1 : 0}&tfreach=${t.twoFingerReach.toFixed(2)}&tfgap=${t.twoFingerGap.toFixed(2)}&tfcurl=${t.twoFingerCurl.toFixed(2)}&tfmargin=${t.twoFingerMargin.toFixed(2)}&tfhold=${Math.round(t.twoFingerHoldMs)}` +
    `&grab=${t.grab ? 1 : 0}&sweep=${t.sweep ? 1 : 0}&snap=${t.snap ? 1 : 0}&twoopen=${t.twoOpens ? 1 : 0}&world=${t.world ? 1 : 0}` +
    `&${t.pinchDrag ? (t.pinchTurns ? 'pinchturn=1' : 'pinchmove=1') : 'pinchturn=0'}&pangain=${t.panGain.toFixed(2)}` +
    `&typingms=${Math.round(t.typingMs)}&resthand=${t.restHandMax.toFixed(2)}`
  );
}
