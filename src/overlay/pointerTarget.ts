/**
 * The pointer's target (src/overlay/pointer.ts): which part the glowing pointer should be on, and
 * where that part's centre is in viewport px this frame. Written by whichever stage draws the
 * part, in the frame it builds its labels (the same anchor its label pill points at); read once a
 * frame by the pointer layer. Like src/detect/live.ts: plain module state, no store field and no
 * React re-render per frame.
 *
 * One slot per stage (the overlay's box rig or live hand, the arm, the eye, the solid sketch, the
 * detail model). A stage writes its own slot only (null when it has nothing highlighted), so a
 * stage that is not up never overwrites the one that is. A slot not written for STALE_MS counts as
 * empty (a stage that stopped drawing or unmounted leaves nothing behind); stages also clear their
 * slot when they go. While the detail model is up its slot decides, even when it is empty (no step
 * or no focus part lit: no pointer, rather than back to the main model's old highlight); then the
 * main stages.
 *
 * `?pointer=0` turns the pointer off (read once, like DETAIL_ON): nothing is mounted, and these
 * functions do nothing.
 */
import type { AppState } from '../state/store';
import { urlParam } from '../camera/frame';

/** `?pointer=0`: no pointer (on by default). */
export const POINTER_ON: boolean = urlParam('pointer') !== '0';

export interface PointerAnchor {
  /** the part's id (a new id means a new target: the pointer flies there and pulses once) */
  id: string;
  /** the part's centre in viewport px (may be outside the view) */
  x: number;
  y: number;
  /** false when (x, y) is outside the view: the pointer then waits at the nearest edge */
  visible: boolean;
}

/** Who writes a slot. Earlier in PRIORITY wins when more than one has a target. */
export type PointerSource = 'detail' | 'arm' | 'eye' | 'solid' | 'overlay';
const PRIORITY: readonly PointerSource[] = ['detail', 'arm', 'eye', 'solid', 'overlay'];

/** A slot not written for this long (ms) is ignored: its stage stopped drawing. */
export const STALE_MS = 400;

interface Slot {
  anchor: PointerAnchor | null;
  /** performance.now() of the last write, -1 = never */
  at: number;
  /** while a stage builds its frame: the ids it is looking for, and the best one offered so far */
  want: readonly string[];
  rank: number;
  id: string;
  x: number;
  y: number;
}

const slots = new Map<PointerSource, Slot>();
for (const s of PRIORITY) slots.set(s, { anchor: null, at: -1, want: [], rank: -1, id: '', x: 0, y: 0 });

const clock = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** An anchor for (x, y) in a vw x vh view, or null when the numbers are not usable. */
export function anchorAt(id: string, x: number, y: number, vw: number, vh: number): PointerAnchor | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { id, x, y, visible: x >= 0 && x <= vw && y >= 0 && y <= vh };
}

let idsFor: { hl: string | null; step: number | null; td: unknown } | null = null;
let idsCache: string[] = [];

/**
 * The main model's wanted parts, best first: the highlighted part (highlight_part; show_step lights
 * its step's first part too), then the active step's parts in order. Cached until those change.
 */
export function mainPointerIds(s: Pick<AppState, 'highlightedPartId' | 'activeStep' | 'teardown'>): readonly string[] {
  if (idsFor && idsFor.hl === s.highlightedPartId && idsFor.step === s.activeStep && idsFor.td === s.teardown) return idsCache;
  const ids: string[] = [];
  if (s.highlightedPartId) ids.push(s.highlightedPartId);
  if (s.activeStep !== null && s.teardown) {
    const step = s.teardown.steps.find((st) => st.n === s.activeStep);
    if (step) for (const id of step.part_ids) if (!ids.includes(id)) ids.push(id);
  }
  idsFor = { hl: s.highlightedPartId, step: s.activeStep, td: s.teardown };
  idsCache = ids;
  return ids;
}

/** Start a frame for `source`: it looks for these ids (best first). */
export function pointerBegin(source: PointerSource, want: readonly string[]): void {
  const slot = slots.get(source)!;
  slot.want = want;
  slot.rank = -1;
}

/** A part's centre this frame (viewport px); kept if it is the best wanted id offered so far. */
export function pointerOffer(source: PointerSource, id: string, x: number, y: number): void {
  const slot = slots.get(source)!;
  if (slot.want.length === 0) return;
  const r = slot.want.indexOf(id);
  if (r < 0 || (slot.rank >= 0 && r >= slot.rank)) return;
  slot.rank = r;
  slot.id = id;
  slot.x = x;
  slot.y = y;
}

/** End the frame for `source`: its slot is the best part offered, or null. */
export function pointerEnd(source: PointerSource, vw: number, vh: number): void {
  if (!POINTER_ON) return;
  const slot = slots.get(source)!;
  slot.anchor = slot.rank >= 0 ? anchorAt(slot.id, slot.x, slot.y, vw, vh) : null;
  slot.at = clock();
  slot.want = [];
  slot.rank = -1;
}

/**
 * The best anchor in a stage's label items: the first wanted id found among them; if none of the
 * wanted ids is there but some item is flagged highlighted, that one. Nothing wanted: null.
 */
export function pickAnchor(
  items: readonly { id: string; ax: number; ay: number; highlighted: boolean }[],
  want: readonly string[],
  vw: number,
  vh: number,
): PointerAnchor | null {
  if (want.length === 0) return null;
  let best = -1;
  let bestRank = Infinity;
  for (let i = 0; i < items.length; i++) {
    const r = want.indexOf(items[i].id);
    if (r >= 0 && r < bestRank) {
      bestRank = r;
      best = i;
    }
  }
  if (best < 0) best = items.findIndex((it) => it.highlighted);
  if (best < 0) return null;
  const it = items[best];
  return anchorAt(it.id, it.ax, it.ay, vw, vh);
}

/** One call per frame for a stage whose label items hold every part it draws (box rig, live hand, arm). */
export function publishPointer(
  source: PointerSource,
  items: readonly { id: string; ax: number; ay: number; highlighted: boolean }[],
  want: readonly string[],
  vw: number,
  vh: number,
): void {
  if (!POINTER_ON) return;
  const slot = slots.get(source)!;
  slot.anchor = pickAnchor(items, want, vw, vh);
  slot.at = clock();
}

/** The stage went away (unmounted, or stopped drawing): its slot is empty. */
export function clearPointer(source: PointerSource): void {
  const slot = slots.get(source)!;
  slot.anchor = null;
  slot.at = -1;
  slot.want = [];
  slot.rank = -1;
}

/**
 * The pointer's target now: a fresh detail slot (the detail model is up) as it is, even when empty;
 * else the first fresh, non-empty slot in priority order; else null.
 */
export function currentPointer(now: number = clock()): PointerAnchor | null {
  for (const s of PRIORITY) {
    const slot = slots.get(s)!;
    const fresh = slot.at >= 0 && now - slot.at <= STALE_MS;
    if (fresh && (slot.anchor || s === 'detail')) return slot.anchor;
  }
  return null;
}
