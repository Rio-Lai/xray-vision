/**
 * Live gesture tuning, read every frame by the gesture driver. Change it with the sliders in the
 * debug panel (D): saved in localStorage, and URL params override (for a quick test on the rig):
 *   ?pinch=0.25&unpinch=0.4&hold=70&rot=1.1&spread=0.9&burst=1&twohand=0&gestures=0
 */
import { urlNumber } from '../camera/frame';
import { GESTURE_TUNING_DEFAULTS } from './gestures';
import type { GestureTuning } from './gestures';

const KEY = 'blowfish.gestureTuning';

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
  t.rotGain = urlNumber('rot', t.rotGain);
  t.spreadGain = urlNumber('spread', t.spreadGain);
  t.burst = urlBool('burst') ?? t.burst;
  t.twoHand = urlBool('twohand') ?? t.twoHand;
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
    `pinch=${t.pinchOn.toFixed(2)}&unpinch=${t.pinchOff.toFixed(2)}&hold=${Math.round(t.holdMs)}` +
    `&rot=${t.rotGain.toFixed(2)}&spread=${t.spreadGain.toFixed(2)}&burst=${t.burst ? 1 : 0}&twohand=${t.twoHand ? 1 : 0}`
  );
}
