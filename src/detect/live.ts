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
  stats: { renderFps: 0, objMs: 0, handMs: 0, faceMs: 0, detector: '', notes: [] },
};
