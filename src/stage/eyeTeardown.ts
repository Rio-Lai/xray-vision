/**
 * Kash's procedural eye (public/cache/eye.json, public/cache/meshes/eye/, #94) as a first-class
 * object: an eye in view (src/detect/faceTracker.ts) opens it at once, like the MacBook from a
 * "laptop" label, and src/overlay/EyeStage.tsx draws it in the middle of the view in its own frame.
 * His file is a valid Teardown as it is (the server drops his extra keys such as mesh_source), so
 * nothing is mapped here: it is told apart by its object_id.
 */
import type { Teardown } from '../../shared/teardown';
import type { AppState } from '../state/store';
import { DEMO_IDENTIFY, isEyeHint } from '../../shared/demo';
import { centreDistance, pinObject } from '../detect/centre';

/** object_id of Kash's eye (DEMO_IDENTIFY.eye). */
export const EYE_OBJECT_ID = DEMO_IDENTIFY.eye.object_id;

export function isEyeTeardown(td: Pick<Teardown, 'object_id'> | null | undefined): boolean {
  return !!td && td.object_id === EYE_OBJECT_ID;
}

/** "eye", "eyes", "the eye", "left eye", "eyeball": the agent means an eye. */
export function isEyeRequest(objectId: string): boolean {
  const id = objectId.trim().toLowerCase();
  return id === EYE_OBJECT_ID || isEyeHint(id.replace(/[-_]+/g, ' '));
}

/** Where the stored eye lifts out of when no eye is in view: a small box in the middle of the frame. */
const PINNED_EYE_BOX = { x: 0.46, y: 0.44, w: 0.08, h: 0.12 };

/**
 * The scene object the agent means by an eye `object_id` for explode: with the eye already on
 * stage, the eye it came out of; else the focused or selected eye ("left eye" / "right eye": that
 * side, the person's own, when it is in view), else the eye nearest the centre. With no eye in view
 * the stored eye is pinned in the middle of the view (as centre.ts does for a named thing) so it
 * still opens: in the pitch the tutor may be asked for the eye while the wearer looks away.
 * Returns undefined when `objectId` names a scene object or is not about an eye (resolve it as before).
 */
export function resolveEyeObjectId(
  objectId: string,
  s: Pick<AppState, 'objects' | 'selectedObjectId' | 'focusedObjectId' | 'teardown'>,
): string | undefined {
  const raw = objectId.trim();
  if (s.objects.some((o) => o.id === raw)) return undefined;
  if (!isEyeRequest(raw)) return undefined;
  const eyes = s.objects.filter((o) => o.anchor === 'face');
  const isEye = (id: string | null) => !!id && eyes.some((o) => o.id === id);
  if (isEyeTeardown(s.teardown) && isEye(s.selectedObjectId)) return s.selectedObjectId!;
  const side = /\bleft\b/i.test(raw) ? 'left' : /\bright\b/i.test(raw) ? 'right' : null;
  const sided = side ? eyes.filter((o) => o.id.startsWith(`eye-${side}`)) : [];
  const pool = sided.length > 0 ? sided : eyes;
  const inPool = (id: string | null) => !!id && pool.some((o) => o.id === id);
  if (inPool(s.focusedObjectId)) return s.focusedObjectId!;
  if (inPool(s.selectedObjectId)) return s.selectedObjectId!;
  if (pool.length > 0) return pool.reduce((a, b) => (centreDistance(b) < centreDistance(a) ? b : a)).id;
  return pinObject(PINNED_EYE_BOX, DEMO_IDENTIFY.eye, { label: 'eye', anchor: 'face' }).id;
}
