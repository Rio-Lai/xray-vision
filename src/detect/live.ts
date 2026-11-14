/**
 * Per-frame detection results, read directly by the overlay's render loop and the debug panel.
 * The store only gets a ~15 Hz copy (objects, focusedObjectId, hands) for React and the voice tools.
 */
import type { SceneObject } from '../state/store';
import type { TrackedHand } from './handTracker';

export interface LiveStats {
  renderFps: number;
  objMs: number;
  handMs: number;
  notes: string[];
}

export interface LiveData {
  /** engineering objects + hands, latest tracked boxes */
  objects: SceneObject[];
  hands: TrackedHand[];
  stats: LiveStats;
}

export const live: LiveData = {
  objects: [],
  hands: [],
  stats: { renderFps: 0, objMs: 0, handMs: 0, notes: [] },
};
