/**
 * Per-frame detection results, read directly by the overlay's render loop and the debug panel.
 * The store only gets a ~15 Hz copy (objects, focusedObjectId, hands) for React and the voice tools.
 * Faces (#94) are not in the store at all: their eyes are scene objects, and get_pose reads `faces`.
 */
import type { SceneObject } from '../state/store';
import type { TrackedHand } from './handTracker';
import type { FaceView } from './faceTracker';

export interface LiveStats {
  renderFps: number;
  objMs: number;
  handMs: number;
  faceMs: number;
  /** Object detector line for the debug panel (#110): which model, its timing, the two thresholds. */
  detector: string;
  notes: string[];
  /** #131: a model is up on stage: these run about three times a second (engine.ts slowVisionNow) */
  slowVision: { objects: boolean; faces: boolean };
}

/** #131: one second of frames, for the debug panel. */
export interface PerfSecond {
  /** frames of the app's loop */
  frames: number;
  /** time per frame (ms) in the detection engine's tick (vision) and the overlay's (drawing): sum and longest */
  visionMs: number;
  visionMaxMs: number;
  drawMs: number;
  drawMaxMs: number;
  /** the arm's own renderer (its own loop): drawing time summed over its frames (ran.arm) */
  armMs: number;
  /** runs per vision model (hands, objects, faces) and frames drawn per canvas (overlay, eye, solid, arm) */
  ran: Record<string, number>;
}

const emptySecond = (): PerfSecond => ({ frames: 0, visionMs: 0, visionMaxMs: 0, drawMs: 0, drawMaxMs: 0, armMs: 0, ran: {} });

/** #131: `last` is the last whole second, `cur` the one being counted. */
export const perf = { last: emptySecond(), cur: emptySecond(), since: -1 };

/** Once per frame of the app's loop, before anything is counted (the engine's tick): closes a second when one has passed. */
export function perfFrame(now: number): void {
  if (perf.since < 0 || now < perf.since) perf.since = now;
  if (now - perf.since >= 1000) {
    perf.last = perf.cur;
    perf.cur = emptySecond();
    perf.since = now;
  }
  perf.cur.frames += 1;
}

/** One run of a vision model, or one frame drawn by a canvas. */
export function perfCount(name: string): void {
  perf.cur.ran[name] = (perf.cur.ran[name] ?? 0) + 1;
}

export function perfVision(ms: number): void {
  perf.cur.visionMs += ms;
  perf.cur.visionMaxMs = Math.max(perf.cur.visionMaxMs, ms);
}

export function perfDraw(ms: number): void {
  perf.cur.drawMs += ms;
  perf.cur.drawMaxMs = Math.max(perf.cur.drawMaxMs, ms);
}

export interface LiveData {
  /** every tracked thing (detector objects, hands, eyes), latest boxes */
  objects: SceneObject[];
  hands: TrackedHand[];
  /** tracked faces: outline and eyes (open, gaze); no face is a scene object */
  faces: FaceView[];
  stats: LiveStats;
}

export const live: LiveData = {
  objects: [],
  hands: [],
  faces: [],
  stats: { renderFps: 0, objMs: 0, handMs: 0, faceMs: 0, detector: '', notes: [], slowVision: { objects: false, faces: false } },
};
