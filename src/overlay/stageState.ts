/**
 * Is a model floating in the middle of the view right now? Shared by the overlay (which rig to
 * draw), the camera (dim and blur the live video behind it) and the HUD.
 */
import type { AppState } from '../state/store';

/** Stage mode with a box-anchored teardown loaded: its 3D model is on stage over the live video. */
export function modelOnStage(s: Pick<AppState, 'trackingMode' | 'teardown'>): boolean {
  return s.trackingMode === 'stage' && s.teardown !== null && s.teardown.anchor !== 'hand';
}
