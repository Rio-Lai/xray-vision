/**
 * Live gesture tuning, read every frame by the gesture driver. Change it with the sliders in the
 * debug panel (D): saved in localStorage, and URL params override (for a quick test on the rig):
 *   ?gestures=0 (all hand gestures off), ?burst=0 (fist / open hand), ?globe=0 (two open hands turn it),
 *   ?twohand=0 (two-hand pinch apart / together), ?pan=0 (two-hand pinch moved together)
 *   ?pinch=0.3&unpinch=0.45&hold=90&reach=1&rot=1.1&spread=1&burstms=400&globegain=1.3
 *   &typingms=1500&resthand=0.22 (which hands may gesture, #107; typingms=0 turns the typing rule off)
 * #121 changed the defaults, so the saved sliders live under a new key: everyone starts from the new
 * defaults once (the old key is ignored).
 */
import { urlNumber } from '../camera/frame';
import { GESTURE_TUNING_DEFAULTS } from './gestures';
import type { GestureTuning } from './gestures';

const KEY = 'blowfish.gestureTuning.v2';

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
  t.burst = urlBool('burst') ?? t.burst;
  t.globe = urlBool('globe') ?? t.globe;
  t.twoHand = urlBool('twohand') ?? t.twoHand;
  t.pan = urlBool('pan') ?? t.pan;
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
    `&typingms=${Math.round(t.typingMs)}&resthand=${t.restHandMax.toFixed(2)}`
  );
}
