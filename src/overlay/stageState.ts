/**
 * Is a model floating in the middle of the view right now? Shared by the overlay (which rig to
 * draw), the camera (dim and blur the live video behind it) and the HUD.
 */
import type { AppState } from '../state/store';
import type { Teardown } from '../../shared/teardown';
import { isArmTeardown } from '../stage/armTeardown';

/** true when at least one part has a real 3D model (Kash's GLBs). */
export function hasPartMeshes(td: Teardown): boolean {
  return td.parts.some((p) => typeof p.mesh_url === 'string' && p.mesh_url.length > 0);
}

/**
 * Whether this teardown goes on stage as a 3D model: every box-anchored object does (its parts
 * have placeholders until the models load); Kash's arm does (the hand's model on stage, drawn by
 * ArmStage.tsx); another hand teardown only once its parts have models. Without them a hand
 * keeps the landmark-drawn overlay on the real hand only.
 */
export function stagesAsModel(td: Teardown): boolean {
  return td.anchor !== 'hand' || isArmTeardown(td) || hasPartMeshes(td);
}

/** Stage mode with a teardown whose 3D model is on stage over the live video. */
export function modelOnStage(s: Pick<AppState, 'trackingMode' | 'teardown'>): boolean {
  return s.trackingMode === 'stage' && s.teardown !== null && stagesAsModel(s.teardown);
}
