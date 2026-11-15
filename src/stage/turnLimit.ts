/**
 * Flat models never rest edge-on (#107). On stage a box-rig model (the MacBook, live objects, a hand
 * with models) turns like a turntable: modelYaw spins it about its own up axis and modelPitch tips
 * the view, which looks 30 degrees down onto its plane (overlay/boxRig.ts, STAGE_ELEVATION). Spun
 * a quarter turn, a laptop is seen end on and its keyboard becomes a thin strip; tipped up from the
 * default view, its plates go edge-on. So, for flat models only (the eye and the arm are solid
 * shapes and read at any angle):
 *  - yaw stays within FLAT_YAW_LIMIT of the face it shows: the front (whole turns) or, after "turn
 *    it around", the back (a half turn on). A drag slows into the limit over FLAT_YAW_SOFT and
 *    inertia dies there; a model already past it (an old voice turn) is never jumped, it just
 *    cannot go further out;
 *  - pitch never tips the top further away than FLAT_PITCH_MIN (its top face then stays within
 *    65 degrees of straight on).
 * The store is unchanged: the inputs call turnModel instead of store.rotateModel (modelControl.ts
 * for hands, mouse and inertia; voiceTurn for the rotate_model voice tool), limited about the yaw
 * actually shown (store.modelYaw plus the overlay's idle drift, stageYawOffset), and the idle drift
 * keeps to the same limit (Overlay.tsx, with faceNear).
 */
import { useStore } from '../state/store';
import type { AppState } from '../state/store';
import { isArmTeardown } from './armTeardown';
import { isEyeTeardown } from './eyeTeardown';

const DEG = Math.PI / 180;
/** Furthest a flat model turns from straight on (its front, or its back after "turn it around"). */
export const FLAT_YAW_LIMIT = 65 * DEG;
/** A drag slows down over this last stretch before the limit (a soft stop, not a wall). */
export const FLAT_YAW_SOFT = 20 * DEG;
/**
 * Lowest pitch for a flat model: the view looks 30 degrees down onto it (top face 60 degrees from
 * straight on), so it may tip up only 5 degrees more (65). Tipping down (seen from above) is free.
 */
export const FLAT_PITCH_MIN = -5 * DEG;
/** store.rotateModel clamps pitch to +-1.2 rad: a turn past it also stopped short. */
const STORE_PITCH_MAX = 1.2;
/** A turn this big or bigger (voice "turn it around": 180) goes to the other face, not to the limit. */
const FLIP_MIN = 135 * DEG;
/** The face a model shows changes only once it is this far from it (no flicker at a quarter turn). */
const FACE_SWITCH = 112 * DEG;

/**
 * What the overlay adds to store.modelYaw for a box-rig model on stage (its idle drift), so turns are
 * limited about the yaw actually shown. Written by Overlay.tsx every frame; 0 when none is on stage.
 */
export const stageYawOffset = { value: 0 };

/** The face a yaw shows: the nearest whole half turn (0 = front, pi = back, 2 pi = front, ...). */
export function faceOf(yaw: number): number {
  return Math.round(yaw / Math.PI) * Math.PI;
}

/** The face shown now, given the face shown before: kept until the yaw is well past a quarter turn. */
export function faceNear(yaw: number, prevFace: number): number {
  return Math.abs(yaw - prevFace) <= FACE_SWITCH ? prevFace : faceOf(yaw);
}

/**
 * Pure: a flat model's yaw after a turn of dYaw from `yaw`. soft = a drag step (slows into the
 * limit). A turn of FLIP_MIN or more first moves by whole half turns (to the back, or round to the
 * front again); the rest is limited about that face. limited = it stopped short of the turn asked.
 */
export function limitYaw(yaw: number, dYaw: number, soft = false): { yaw: number; limited: boolean } {
  const half = Math.abs(dYaw) >= FLIP_MIN ? Math.round(dYaw / Math.PI) : 0;
  const face = faceOf(yaw) + half * Math.PI;
  const off0 = yaw + half * Math.PI - face;
  const want = dYaw - half * Math.PI;
  let d = want;
  if (soft && Math.abs(off0 + d) > Math.abs(off0)) {
    // Turning further out: the nearer the limit, the less a step moves it.
    d *= Math.min(1, Math.max(0, (FLAT_YAW_LIMIT - Math.abs(off0)) / FLAT_YAW_SOFT));
  }
  const lim = Math.max(FLAT_YAW_LIMIT, Math.abs(off0));
  const off = Math.min(lim, Math.max(-lim, off0 + d));
  return { yaw: face + off, limited: Math.abs(off - (off0 + want)) > 1e-6 };
}

/** Pure: a flat model's pitch after tipping by dPitch (never tipped up past FLAT_PITCH_MIN). */
export function limitPitch(pitch: number, dPitch: number): { pitch: number; limited: boolean } {
  const want = pitch + dPitch;
  const p = Math.min(STORE_PITCH_MAX, Math.max(Math.min(FLAT_PITCH_MIN, pitch), want));
  return { pitch: p, limited: Math.abs(p - want) > 1e-6 };
}

/** A flat model is floating on stage: a box-rig model in stage mode (not the eye, not the arm). */
export function flatOnStage(s: Pick<AppState, 'trackingMode' | 'teardown'>): boolean {
  return s.trackingMode === 'stage' && s.teardown !== null && !isArmTeardown(s.teardown) && !isEyeTeardown(s.teardown);
}

/**
 * Turn the model by (dYaw, dPitch) radians through store.rotateModel; a flat model on stage is
 * limited (soft: a drag step). Anything else turns exactly as asked. Returns true if a flat model
 * stopped short of the turn asked.
 */
export function turnModel(dYaw: number, dPitch: number, soft = false): boolean {
  const s = useStore.getState();
  if (!flatOnStage(s)) {
    s.rotateModel(dYaw, dPitch);
    return false;
  }
  const shown = s.modelYaw + stageYawOffset.value;
  const y = limitYaw(shown, dYaw, soft);
  const p = limitPitch(s.modelPitch, dPitch);
  const dy = y.yaw - shown;
  const dp = p.pitch - s.modelPitch;
  if (dy !== 0 || dp !== 0) s.rotateModel(dy, dp);
  return y.limited || p.limited;
}

/**
 * The rotate_model voice tool: turn left / right / up / down (anything else: right, as "around"
 * and "flip" do) by `rad`. Returns true if it stopped short: say "That is as far as it turns."
 */
export function voiceTurn(direction: string, rad: number): boolean {
  const dir = direction.toLowerCase();
  if (dir === 'left') return turnModel(-rad, 0);
  if (dir === 'up') return turnModel(0, -rad);
  if (dir === 'down') return turnModel(0, rad);
  return turnModel(rad, 0);
}
