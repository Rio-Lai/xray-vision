/**
 * "The middle of the view" for "analyse this" (#80).
 *
 *  - centreRegion(): the central 50% of the view's width and 60% of its height, in frame
 *    coordinates (the video is drawn with object-fit: cover, so this maps through the cover map).
 *  - inCentre(o): a scene object whose box centre lies in that region counts as "this" even when
 *    focus has not settled on it.
 *  - The pinned object: with nothing detected in the middle, flow.ts sends a crop of the region to
 *    /api/identify and adds the named thing as one synthetic scene object, a box where the crop
 *    was. The detection engine republishes it every frame (store objects are replaced each
 *    publish, so it would vanish otherwise) for as long as it is selected: a reset, or analysing
 *    anything else, removes it. It has no detector label: its label is Claude's name.
 */
import { useStore } from '../state/store';
import type { Box, SceneObject } from '../state/store';
import type { IdentifyResponse } from '../../shared/teardown';
import { kindOf } from '../../shared/demo';
import { getCoverMap, viewToFrame } from '../camera/frame';

/** Share of the view's width and height that counts as "the middle". */
const CENTRE_W = 0.5;
const CENTRE_H = 0.6;

/** Pinned objects are "centre-1", "centre-2", ...; nothing the detectors report uses this prefix. */
const PINNED_PREFIX = 'centre-';
/** A pinned object that is never selected (should not happen: the flow selects it at once) goes after this. */
const UNSELECTED_MAX_MS = 2000;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** The middle of the view in normalised frame coordinates (0..1, top-left origin). */
export function centreRegion(): Box {
  const m = getCoverMap();
  const a = viewToFrame(m, (m.vw * (1 - CENTRE_W)) / 2, (m.vh * (1 - CENTRE_H)) / 2);
  const b = viewToFrame(m, (m.vw * (1 + CENTRE_W)) / 2, (m.vh * (1 + CENTRE_H)) / 2);
  const x = clamp01(a.x);
  const y = clamp01(a.y);
  return { x, y, w: clamp01(b.x) - x, h: clamp01(b.y) - y };
}

/** True when the object's box centre lies in the middle of the view. */
export function inCentre(o: Pick<SceneObject, 'box'>, region: Box = centreRegion()): boolean {
  const cx = o.box.x + o.box.w / 2;
  const cy = o.box.y + o.box.h / 2;
  return cx >= region.x && cx <= region.x + region.w && cy >= region.y && cy <= region.y + region.h;
}

/** Distance of the object's box centre from the frame centre (frame-normalised units). */
export function centreDistance(o: Pick<SceneObject, 'box'>): number {
  return Math.hypot(o.box.x + o.box.w / 2 - 0.5, o.box.y + o.box.h / 2 - 0.5);
}

let pinned: { object: SceneObject; ident: IdentifyResponse; wasSelected: boolean; at: number } | null = null;
let pinSeq = 0;

export const isPinnedId = (id: string | null | undefined): boolean => !!id && id.startsWith(PINNED_PREFIX);

/**
 * Add the thing Claude named in the middle of the view as a scene object (a box where the crop
 * was) and publish it to the store at once, so get_scene and the flow see it before the next frame.
 * Replaces any earlier pinned object.
 */
export function pinObject(box: Box, ident: IdentifyResponse): SceneObject {
  pinSeq += 1;
  const object: SceneObject = {
    id: `${PINNED_PREFIX}${pinSeq}`,
    label: ident.name,
    name: ident.name,
    confidence: ident.confidence,
    box: { ...box },
    lens: kindOf(ident.name),
    anchor: 'box',
  };
  const old = pinned?.object.id;
  pinned = { object, ident, wasSelected: false, at: performance.now() };
  const s = useStore.getState();
  s.setObjects([...s.objects.filter((o) => o.id !== old), object]);
  return object;
}

/** Remove the pinned object (only if it is `id`, when given). The next engine publish drops it from the store. */
export function unpinObject(id?: string): void {
  if (pinned && (id === undefined || pinned.object.id === id)) pinned = null;
}

/** Claude's answer for a pinned object, so the flow does not ask again. */
export function pinnedIdent(id: string): IdentifyResponse | null {
  return pinned && pinned.object.id === id ? pinned.ident : null;
}

/**
 * For the engine, every frame: the pinned object while it is (or is about to be) selected.
 * Once it has been selected, losing the selection (reset, or another object analysed) removes it.
 */
export function pinnedObjects(selectedId: string | null, now: number): SceneObject[] {
  if (!pinned) return [];
  if (selectedId === pinned.object.id) pinned.wasSelected = true;
  else if (pinned.wasSelected || now - pinned.at > UNSELECTED_MAX_MS) {
    pinned = null;
    return [];
  }
  return [pinned.object];
}
