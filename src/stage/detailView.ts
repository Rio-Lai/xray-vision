/**
 * The detail model's own view (`?detail=1`; nothing reads it without a detail model up): yaw, pitch,
 * zoom and pan of the small model drawn by src/overlay/DetailStage.tsx, so the same controls that move
 * the main model (hand gestures, mouse, trackpad, keys, the rotate_model and adjust_view voice tools)
 * move the detail model while one is open (Rio, 15 Nov: "for the sub part explainers, I want to be
 * able to do the same movement controls"). modelControl.ts routes direct input here while
 * detailInputActive; clientTools.ts does the same for voice. The main model's own view (store
 * modelYaw ... modelPanY) is left as it was, so it is unchanged when the detail closes.
 *
 * Units match the main model's: radians (yaw right = turn right, pitch + = tip the top towards you),
 * zoom 1 = the normal fit, pan in stage sizes (modelControl PAN_UNIT_VH of the view height each).
 * Targets are set here; DetailStage eases towards them every frame (easeDetailView). Everything goes
 * back to the start (facing the default view, the normal size, in the middle) whenever the detail
 * model changes: a new one opens, or it closes.
 */
import { useStore } from '../state/store';
import type { AppState } from '../state/store';
import type { DetailScene } from '../../shared/detail';

/** Limits: half to two and a half times the normal fit (more would reach the camera), pan most of a stage size each way (it stays in its area). */
export const DETAIL_ZOOM_MIN = 0.5;
export const DETAIL_ZOOM_MAX = 2.5;
export const DETAIL_PAN_MAX = 0.8;
/** Tipped at most this far either way (radians), as the main model (store.rotateModel). */
export const DETAIL_PITCH_MAX = 1.2;
/** The eased view follows its target at this rate (1/s). */
const EASE_RATE = 9;

export interface DetailViewState {
  yaw: number;
  pitch: number;
  zoom: number;
  panX: number;
  panY: number;
}

/** The target view (written by the inputs). */
const target: DetailViewState = { yaw: 0, pitch: 0, zoom: 1, panX: 0, panY: 0 };
/** The view drawn now (eased towards the target by easeDetailView). */
const shown: DetailViewState = { yaw: 0, pitch: 0, zoom: 1, panX: 0, panY: 0 };
/** performance.now() of the last input to the detail view (DetailStage stops its idle sway meanwhile). */
export const detailInput = { at: -1e9 };
let seen: DetailScene | null = null;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function resetState(v: DetailViewState): void {
  v.yaw = 0;
  v.pitch = 0;
  v.zoom = 1;
  v.panX = 0;
  v.panY = 0;
}

/** A new detail model, or none: back to the start, at once (no easing from the old one). */
function sync(): void {
  const d = useStore.getState().detail;
  if (d === seen) return;
  seen = d;
  resetState(target);
  resetState(shown);
  detailInput.at = -1e9;
}

/** A detail model is up: direct input and the view voice tools act on it instead of the main model. */
export function detailInputActive(s: Pick<AppState, 'detailStatus' | 'detail'>): boolean {
  return s.detailStatus === 'ready' && s.detail !== null;
}

/** The target view now (read only; for the gesture driver, the voice tools and the debug panel). */
export function detailViewTarget(): Readonly<DetailViewState> {
  sync();
  return target;
}

/** Turn by (dYaw, dPitch) radians. true = the pitch stopped at its limit short of the turn asked. */
export function turnDetail(dYaw: number, dPitch: number, now = performance.now()): boolean {
  sync();
  if (!Number.isFinite(dYaw) || !Number.isFinite(dPitch)) return false;
  target.yaw += dYaw;
  const want = target.pitch + dPitch;
  target.pitch = clamp(want, -DETAIL_PITCH_MAX, DETAIL_PITCH_MAX);
  detailInput.at = now;
  return Math.abs(target.pitch - want) > 1e-6;
}

/** Set the zoom (clamped). */
export function setDetailZoom(zoom: number, now = performance.now()): void {
  sync();
  if (!Number.isFinite(zoom)) return;
  target.zoom = clamp(zoom, DETAIL_ZOOM_MIN, DETAIL_ZOOM_MAX);
  detailInput.at = now;
}

/** Multiply the zoom (clamped). */
export function zoomDetail(factor: number, now = performance.now()): void {
  if (!Number.isFinite(factor) || factor <= 0) return;
  setDetailZoom(detailViewTarget().zoom * factor, now);
}

/** Move by (dx, dy) stage sizes (clamped). true = it moved. */
export function panDetail(dx: number, dy: number, now = performance.now()): boolean {
  sync();
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
  const x = clamp(target.panX + dx, -DETAIL_PAN_MAX, DETAIL_PAN_MAX);
  const y = clamp(target.panY + dy, -DETAIL_PAN_MAX, DETAIL_PAN_MAX);
  const moved = Math.abs(x - target.panX) + Math.abs(y - target.panY) > 1e-6;
  target.panX = x;
  target.panY = y;
  detailInput.at = now;
  return moved;
}

/** Back in the middle at the normal size, facing the default view (by the short way round). */
export function centreDetail(now = performance.now()): void {
  sync();
  const turn = Math.PI * 2;
  target.yaw -= Math.round(target.yaw / turn) * turn;
  shown.yaw -= Math.round(shown.yaw / turn) * turn;
  target.yaw = 0;
  target.pitch = 0;
  target.zoom = 1;
  target.panX = 0;
  target.panY = 0;
  detailInput.at = now;
}

/** The rotate_model voice tool on the detail model (as turnLimit.ts voiceTurn): left, up, down, anything else right. true = stopped at a limit. */
export function voiceTurnDetail(direction: string, rad: number): boolean {
  const dir = direction.toLowerCase();
  if (dir === 'left') return turnDetail(-rad, 0);
  if (dir === 'up') return turnDetail(0, -rad);
  if (dir === 'down') return turnDetail(0, rad);
  return turnDetail(rad, 0);
}

/** One frame (DetailStage): the drawn view eases towards the target. Returns it (reused, read only). */
export function easeDetailView(dtSec: number): Readonly<DetailViewState> {
  sync();
  const k = 1 - Math.exp(-Math.max(0, Math.min(0.1, dtSec)) * EASE_RATE);
  shown.yaw += (target.yaw - shown.yaw) * k;
  shown.pitch += (target.pitch - shown.pitch) * k;
  shown.zoom += (target.zoom - shown.zoom) * k;
  shown.panX += (target.panX - shown.panX) * k;
  shown.panY += (target.panY - shown.panY) * k;
  return shown;
}
