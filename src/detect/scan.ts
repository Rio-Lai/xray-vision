/**
 * "See everything" (#122): while the overlay is on, Claude looks at the whole view now and then and
 * names up to ten things in it, so the labels are not limited to the detector's 24 COCO classes, and
 * the thing in the middle of the view always has a name.
 *
 *  - What is sent: a downscaled copy of the visible part of the current frame (longest side
 *    SCAN_MAX_PX, JPEG), with every face outline the face tracker has painted black (padded). Only
 *    while the overlay is on; never with `?scan=0`; nothing at all when the server has no Claude key
 *    (its first answer says so and scanning stops for the session).
 *  - When: nothing open or loading, the view steady for STEADY_MS, the view moved since the last scan
 *    (or the last scan older than RESCAN_AFTER_MS), no scan in flight, at least MIN_GAP_MS since the
 *    last one. The centre: steady for CENTRE_STEADY_MS with nothing named holding the middle of the
 *    view (and the view or the middle changed since the last scan, and the middle has stopped
 *    changing for STEADY_MS, so a thing being held up is not caught mid-air): scan at once
 *    (CENTRE_MIN_GAP_MS).
 *  - Whole-frame shift: every SAMPLE_EVERY new video frames a tiny greyscale copy (64 x 36) is compared
 *    with the previous one (coarse-to-fine search of integer shifts by mean absolute difference, then
 *    one Lucas-Kanade step for the sub-pixel part). It says whether the view is steady, carries the scan labels along with the
 *    picture between scans, and says when the view has changed enough to scan again.
 *  - What comes back: a thing that overlaps an object the detector tracks (IoU >= MATCH_IOU, or each
 *    centre inside the other) names that object (its `name`, as /api/identify does; an identify name
 *    is never overwritten). Anything else becomes a scene object `scan-N` (anchor 'box', label = name),
 *    published with the others and moved by the frame shift; dropped when it leaves the frame, when the
 *    view has shifted more than DROP_SHIFT since it was last confirmed, or when later scans of a view
 *    that holds it miss it (twice, or once and EXPIRE_MS after its confirmation). A new scan matches
 *    things by name and place, so ids and labels stay put. A named detector object that the detector
 *    loses becomes a scan object where it was last seen (the label stays), and back again.
 *  - "Analyse this" on a scanned thing opens it with its name, without another identify call
 *    (scanIdent, used by src/lib/flow.ts). The stored objects (a detected laptop, a hand, an eye) open
 *    exactly as before.
 *  - `?mock=1` (and the other mock scenes): a few fake things after half a second, no network.
 *  - Any failure (server down, time-out, bad reply) changes nothing on screen; the next try waits
 *    FAIL_BACKOFF_MS.
 */
import type { Box, SceneObject } from '../state/store';
import type { IdentifyResponse } from '../../shared/teardown';
import { kindOf, slugify } from '../../shared/demo';
import { errorText, frame, getCoverMap, MOCK_MODE, urlNumber, urlParam, viewToFrame } from '../camera/frame';
import { api, isServerDown, type ScanThing } from '../lib/api';
import { iou } from './objectTracker';
import { isPinnedId } from './centre';

/* ------------------------------- settings ------------------------------- */

const SCAN_PARAM = (urlParam('scan') ?? '').trim().toLowerCase();
/** `?scan=0` turns the whole-view scan off: no pictures sent, the labels as before (four, nearest the centre). */
export const SCAN_OFF = SCAN_PARAM === '0' || SCAN_PARAM === 'off' || SCAN_PARAM === 'false';

/** Longest side of the picture sent to Claude (px), and its JPEG quality. */
const SCAN_MAX_PX = 768;
const SCAN_JPEG_QUALITY = 0.7;
/** Face outlines are blacked out with this much padding (fraction of the face's size, each side). */
const FACE_PAD = 0.2;
/** The view must be steady this long before a scan. */
const STEADY_MS = 500;
/** At most one scan per this long... */
const MIN_GAP_MS = 3000;
/** ...except to name the middle of the view, after it has been steady this long. */
const CENTRE_STEADY_MS = 800;
const CENTRE_MIN_GAP_MS = 1500;
/** A view that has not moved is scanned again only after this long. */
const RESCAN_AFTER_MS = 20_000;
/** After a failed scan (server down, time-out, bad reply), wait this long before the next. */
const FAIL_BACKOFF_MS = 8000;
/** The client gives up after this; the server's own limit is 8 s. */
const CLIENT_TIMEOUT_MS = 9500;
/** Steady = the picture moves slower than this, in frame widths per second (`?scansteady=`). */
const STEADY_SPEED = Math.max(0.01, urlNumber('scansteady', 0.08));
/** Moved this far (frame fractions) since the last scan = a new view, worth scanning. */
const CHANGE_SHIFT = 0.1;
/** Mean grey-level change in the middle of the view that counts as something new there (0..255)... */
const CENTRE_CHANGE = 8;
/** ...and the most it may change from one sample to the next to count as held still (a thing being raised is not). */
const CENTRE_CALM = 5;
/** A scan label is dropped once the view has moved this far (frame fractions) since it was confirmed... */
const DROP_SHIFT = 1 / 3;
/** ...or the picture has travelled this far in all (drift of the shift estimate adds up)... */
const DROP_PATH = 1.2;
/** ...or a later scan of a view that held it missed it and it was confirmed longer ago than this. */
const EXPIRE_MS = 8000;
/** Overlap with a tracked detector object that makes them the same thing. */
const MATCH_IOU = 0.4;
/** Scan objects kept at most (the most interesting). */
const MAX_ITEMS = 20;
/** Labels with the scan on (objectLabels.ts), and the interest of a thing only the detector has. */
export const SCAN_MAX_LABELS = 10;
export const DEFAULT_INTEREST = 0.5;

/** The shift sampler: a 64 x 36 grey copy every SAMPLE_EVERY new video frames. */
export const SHIFT_W = 64;
export const SHIFT_H = 36;
const SAMPLE_EVERY = 2;

const SCAN_PREFIX = 'scan-';
export const isScanId = (id: string | null | undefined): boolean => !!id && id.startsWith(SCAN_PREFIX);

/* --------------------------- whole-frame shift --------------------------- */

const CW = SHIFT_W / 2;
const CH = SHIFT_H / 2;
/** Coarse search range (px at 32 x 18): +-5 = about 15% of the frame per sample, ~2 frame widths a second. */
const COARSE_R = 5;
const FINE_R = 2;
/** A non-zero shift must beat "no shift" by this much (mean grey levels), or it is noise on a plain view. */
const MIN_GAIN = 0.35;

/** Mean |cur(x, y) - prev(x - sx, y - sy)| over the overlap of a w x h pair. */
function shiftCost(cur: Float32Array, prev: Float32Array, w: number, h: number, sx: number, sy: number): number {
  const x0 = Math.max(0, sx);
  const x1 = Math.min(w, w + sx);
  const y0 = Math.max(0, sy);
  const y1 = Math.min(h, h + sy);
  let s = 0;
  for (let y = y0; y < y1; y++) {
    const rc = y * w;
    const rp = (y - sy) * w - sx;
    for (let x = x0; x < x1; x++) s += Math.abs(cur[rc + x] - prev[rp + x]);
  }
  const n = (x1 - x0) * (y1 - y0);
  return n > 0 ? s / n : Infinity;
}

export interface ShiftResult {
  /** how far the picture's content moved since the previous sample, in sample pixels (+x right, +y down) */
  dx: number;
  dy: number;
  /** false: moved more than the search range (or no match): positions are lost */
  ok: boolean;
}

/** Estimates how far the whole picture moved between two 64 x 36 grey samples. Allocation-free. */
export class ShiftEstimator {
  private prev = new Float32Array(SHIFT_W * SHIFT_H);
  private cur = new Float32Array(SHIFT_W * SHIFT_H);
  private prevC = new Float32Array(CW * CH);
  private curC = new Float32Array(CW * CH);
  private has = false;
  private subX = 0;
  private subY = 0;

  reset(): void {
    this.has = false;
  }

  /** The latest sample (mean removed), for comparisons; valid after the first push. */
  latest(): Float32Array {
    return this.prev;
  }

  /** The sample before it; valid after the second push, until the next one. */
  previous(): Float32Array {
    return this.cur;
  }

  /** Feed one sample (SHIFT_W x SHIFT_H grey values, row by row). null for the first one after a reset. */
  push(grey: ArrayLike<number>): ShiftResult | null {
    const cur = this.cur;
    const n = SHIFT_W * SHIFT_H;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += grey[i];
    mean /= n;
    for (let i = 0; i < n; i++) cur[i] = grey[i] - mean;
    const c = this.curC;
    for (let y = 0; y < CH; y++) {
      for (let x = 0; x < CW; x++) {
        const i = 2 * y * SHIFT_W + 2 * x;
        c[y * CW + x] = 0.25 * (cur[i] + cur[i + 1] + cur[i + SHIFT_W] + cur[i + SHIFT_W + 1]);
      }
    }
    let out: ShiftResult | null = null;
    if (this.has) out = this.match();
    // The current sample becomes the previous one (swap, no copy).
    this.cur = this.prev;
    this.prev = cur;
    this.curC = this.prevC;
    this.prevC = c;
    this.has = true;
    return out;
  }

  private match(): ShiftResult {
    let best = Infinity;
    let bx = 0;
    let by = 0;
    for (let sy = -COARSE_R; sy <= COARSE_R; sy++) {
      for (let sx = -COARSE_R; sx <= COARSE_R; sx++) {
        const k = shiftCost(this.curC, this.prevC, CW, CH, sx, sy);
        if (k < best) {
          best = k;
          bx = sx;
          by = sy;
        }
      }
    }
    // A plain view (a wall): no shift beats "no shift" clearly; never call that lost.
    if (bx !== 0 || by !== 0) {
      const zero = shiftCost(this.curC, this.prevC, CW, CH, 0, 0);
      if (zero - best < MIN_GAIN) {
        bx = 0;
        by = 0;
      }
    }
    const lost = Math.abs(bx) === COARSE_R || Math.abs(by) === COARSE_R;
    // Fine: +-FINE_R around twice the coarse answer at full size.
    let fBest = Infinity;
    let ix = 2 * bx;
    let iy = 2 * by;
    for (let j = -FINE_R; j <= FINE_R; j++) {
      for (let i = -FINE_R; i <= FINE_R; i++) {
        const k = shiftCost(this.cur, this.prev, SHIFT_W, SHIFT_H, 2 * bx + i, 2 * by + j);
        if (k < fBest) {
          fBest = k;
          ix = 2 * bx + i;
          iy = 2 * by + j;
        }
      }
    }
    // A plain or noisy view: a shift that barely beats "no shift" is not trusted.
    if ((ix !== 0 || iy !== 0) && shiftCost(this.cur, this.prev, SHIFT_W, SHIFT_H, 0, 0) - fBest < MIN_GAIN) {
      ix = 0;
      iy = 0;
    }
    // Sub-pixel: one Lucas-Kanade step around the integer shift (a parabola through absolute
    // differences pulls small motions towards whole pixels, which adds up to visible drift).
    this.lucasKanade(ix, iy);
    return { dx: ix + this.subX, dy: iy + this.subY, ok: !lost };
  }

  /** Least-squares sub-pixel offset (each way at most 0.75 px) of cur against prev already shifted by (ix, iy), into subX / subY. */
  private lucasKanade(ix: number, iy: number): void {
    this.subX = 0;
    this.subY = 0;
    const W = SHIFT_W;
    const cur = this.cur;
    const prev = this.prev;
    let a11 = 0;
    let a12 = 0;
    let a22 = 0;
    let b1 = 0;
    let b2 = 0;
    for (let y = Math.max(1, 1 + iy); y < Math.min(SHIFT_H - 1, SHIFT_H - 1 + iy); y++) {
      for (let x = Math.max(1, 1 + ix); x < Math.min(W - 1, W - 1 + ix); x++) {
        const p = (y - iy) * W + (x - ix);
        const gx = 0.5 * (prev[p + 1] - prev[p - 1]);
        const gy = 0.5 * (prev[p + W] - prev[p - W]);
        const e = cur[y * W + x] - prev[p];
        a11 += gx * gx;
        a12 += gx * gy;
        a22 += gy * gy;
        b1 += gx * e;
        b2 += gy * e;
      }
    }
    const det = a11 * a22 - a12 * a12;
    if (!(det > 1e-6 * (a11 + a22) * (a11 + a22)) || a11 + a22 < 1) return;
    // cur(x) ~ prev(x - s - d) ~ prev(x - s) - g.d, so g.d = -e
    this.subX = Math.max(-0.75, Math.min(0.75, -(a22 * b1 - a12 * b2) / det));
    this.subY = Math.max(-0.75, Math.min(0.75, -(a11 * b2 - a12 * b1) / det));
  }
}

/** Mean |a - b| over the middle of the view, b offset by (ox, oy) sample px (where the content has moved). */
function centreDiff(a: Float32Array, b: Float32Array, ox: number, oy: number): number {
  let s = 0;
  let n = 0;
  for (let y = Math.round(SHIFT_H * 0.2); y < Math.round(SHIFT_H * 0.8); y++) {
    const py = y - oy;
    if (py < 0 || py >= SHIFT_H) continue;
    for (let x = Math.round(SHIFT_W * 0.25); x < Math.round(SHIFT_W * 0.75); x++) {
      const px = x - ox;
      if (px < 0 || px >= SHIFT_W) continue;
      s += Math.abs(a[y * SHIFT_W + x] - b[py * SHIFT_W + px]);
      n++;
    }
  }
  return n > 0 ? s / n : Infinity;
}

/* ----------------------------- scan objects ----------------------------- */

export interface ScanItem {
  id: string;
  name: string;
  /** frame-normalised, moved with the picture */
  box: Box;
  interest: number;
  /** Claude's "the thing at the centre" in the latest scan that found it */
  centre: boolean;
  objectId?: string;
  confirmedAt: number;
  /** the tracker's accumulated shift (ax, ay) and path when it was last confirmed */
  ax: number;
  ay: number;
  path: number;
  /** later scans of a view that held it that did not find it */
  misses: number;
}

interface TrackName {
  name: string;
  interest: number;
  centre: boolean;
  objectId?: string;
  confirmedAt: number;
  /** the tracked object's latest box (for when the detector loses it) */
  box: Box;
}

const centreOf = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const inside = (p: { x: number; y: number }, b: Box) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
const holdsMiddle = (b: Box) => inside({ x: 0.5, y: 0.5 }, b);

/** The same thing: overlapping enough, or each centre inside the other at a similar size. */
export function sameThing(a: Box, b: Box): boolean {
  if (iou(a, b) >= MATCH_IOU) return true;
  const ra = a.w * a.h;
  const rb = b.w * b.h;
  const ratio = Math.max(ra, rb) / Math.max(1e-6, Math.min(ra, rb));
  return ratio <= 4 && inside(centreOf(a), b) && inside(centreOf(b), a);
}

/** A tracked detector object that a scan may name: boxes only, not hands, eyes, pinned or scan objects. */
const nameable = (o: SceneObject) => o.anchor === 'box' && !isPinnedId(o.id) && !isScanId(o.id);

/** Centre distance in average box sides. */
function gap(a: Box, b: Box): number {
  const ca = centreOf(a);
  const cb = centreOf(b);
  return Math.hypot(ca.x - cb.x, ca.y - cb.y) / Math.max(1e-6, (a.w + a.h + b.w + b.h) / 4);
}

/**
 * The scan's things in the frame, between scans: moved with the whole-frame shift, matched across
 * scans by name and place, and names lent to the detector's own objects. Pure logic (no DOM), so the
 * lifecycle can be checked in Node.
 */
export class ScanTracker {
  items: ScanItem[] = [];
  readonly trackNames = new Map<string, TrackName>();
  /** accumulated whole-frame shift since the start (frame fractions), and the path travelled */
  ax = 0;
  ay = 0;
  path = 0;
  private seq = 0;

  clear(): void {
    this.items = [];
    this.trackNames.clear();
  }

  /** The picture moved by (dx, dy) frame fractions: every scan label moves with it. */
  shift(dx: number, dy: number): void {
    this.ax += dx;
    this.ay += dy;
    this.path += Math.hypot(dx, dy);
    for (const it of this.items) {
      it.box.x += dx;
      it.box.y += dy;
    }
  }

  /** Positions lost (a turn too fast to follow, or an unfreeze): drop every scan object but `keep`. */
  lose(keep: string | null): void {
    this.items = this.items.filter((i) => i.id === keep);
  }

  private newItem(name: string, box: Box, interest: number, centre: boolean, objectId: string | undefined, confirmedAt: number): ScanItem {
    const it: ScanItem = { id: `${SCAN_PREFIX}${++this.seq}`, name, box, interest, centre, objectId, confirmedAt, ax: this.ax, ay: this.ay, path: this.path, misses: 0 };
    this.items.push(it);
    return it;
  }

  /**
   * One scan's answer. `region`: the part of the frame the picture showed (frame fractions);
   * `capAx`, `capAy`: the accumulated shift when it was taken (the boxes are moved on by what the
   * picture has moved since); `tracked`: the detector's objects now.
   */
  apply(things: ScanThing[], region: Box, capAx: number, capAy: number, tracked: SceneObject[], now: number): void {
    const dx = this.ax - capAx;
    const dy = this.ay - capAy;
    const found = new Set<ScanItem>();
    const usedTracks = new Set<string>();
    const candidates = tracked.filter(nameable);
    for (const t of things) {
      const box: Box = {
        x: region.x + t.box.x * region.w + dx,
        y: region.y + t.box.y * region.h + dy,
        w: t.box.w * region.w,
        h: t.box.h * region.h,
      };
      const centre = t.centre === true;
      // 1. Something the detector tracks: it takes the name (and keeps the first one it got).
      let track: SceneObject | null = null;
      let trackScore = 0;
      for (const o of candidates) {
        if (usedTracks.has(o.id) || !sameThing(box, o.box)) continue;
        const s = iou(box, o.box) + 0.01;
        if (s > trackScore) {
          trackScore = s;
          track = o;
        }
      }
      if (track) {
        usedTracks.add(track.id);
        const prev = this.trackNames.get(track.id);
        this.trackNames.set(track.id, {
          name: prev?.name ?? t.name,
          interest: t.interest,
          centre,
          objectId: prev ? prev.objectId : t.object_id,
          confirmedAt: now,
          box: { ...track.box },
        });
        continue;
      }
      // 2. A thing from an earlier scan: same name nearby, or (renamed) the same place. It keeps its id and name.
      const lower = t.name.toLowerCase();
      let item: ScanItem | null = null;
      let itemScore = 0;
      for (const it of this.items) {
        if (found.has(it)) continue;
        const o = iou(box, it.box);
        const s = it.name.toLowerCase() === lower ? (o > 0.05 || gap(box, it.box) < 1.2 ? 1 + o : 0) : o >= 0.5 ? o : 0;
        if (s > itemScore) {
          itemScore = s;
          item = it;
        }
      }
      if (item) {
        found.add(item);
        item.box = box;
        item.interest = t.interest;
        item.centre = centre;
        item.objectId ??= t.object_id;
        item.confirmedAt = now;
        item.ax = this.ax;
        item.ay = this.ay;
        item.path = this.path;
        item.misses = 0;
        continue;
      }
      // 3. New.
      found.add(this.newItem(t.name, box, t.interest, centre, t.object_id, now));
    }
    // "The centre" is only what this scan said.
    for (const [id, tn] of this.trackNames) if (!usedTracks.has(id)) tn.centre = false;
    for (const it of this.items) {
      if (found.has(it)) continue;
      it.centre = false;
      // Where it was when the picture was taken: in the picture, and not found = a miss.
      const c = centreOf(it.box);
      if (inside({ x: c.x - dx, y: c.y - dy }, region)) it.misses += 1;
    }
  }

  /** Per frame: hand names to and from the detector's objects, drop what is gone, and the scene objects to publish. */
  objects(tracked: SceneObject[], selectedId: string | null, now: number): SceneObject[] {
    // A named detector object the detector lost: a scan object where it was last seen, so the label stays.
    for (const [id, tn] of this.trackNames) {
      const o = tracked.find((q) => q.id === id);
      if (o) {
        tn.box = { ...o.box };
        continue;
      }
      this.trackNames.delete(id);
      if (id !== selectedId) this.newItem(tn.name, { ...tn.box }, tn.interest, tn.centre, tn.objectId, tn.confirmedAt);
    }
    // A scan object the detector has now found: the detector's object takes its name (unless it has a scan name of its own).
    if (this.items.length > 0) {
      for (const o of tracked) {
        if (!nameable(o) || this.trackNames.has(o.id)) continue;
        const it = this.items.find((i) => i.id !== selectedId && sameThing(i.box, o.box));
        if (!it) continue;
        this.trackNames.set(o.id, { name: it.name, interest: it.interest, centre: it.centre, objectId: it.objectId, confirmedAt: it.confirmedAt, box: { ...o.box } });
        this.items = this.items.filter((i) => i !== it);
      }
    }
    this.items = this.items.filter((it) => {
      if (it.id === selectedId) return true; // the open (or loading) object stays while it is selected
      if (!inside(centreOf(it.box), { x: 0, y: 0, w: 1, h: 1 })) return false;
      if (Math.hypot(this.ax - it.ax, this.ay - it.ay) > DROP_SHIFT) return false;
      if (this.path - it.path > DROP_PATH) return false;
      if (it.misses >= 2 || (it.misses >= 1 && now - it.confirmedAt > EXPIRE_MS)) return false;
      return true;
    });
    if (this.items.length > MAX_ITEMS) {
      const keep = new Set([...this.items].sort((a, b) => (b.id === selectedId ? 1 : 0) - (a.id === selectedId ? 1 : 0) || b.interest - a.interest).slice(0, MAX_ITEMS));
      this.items = this.items.filter((i) => keep.has(i));
    }
    return this.items.map((it) => ({
      id: it.id,
      label: it.name,
      name: it.name,
      confidence: it.interest,
      box: { ...it.box },
      lens: kindOf(it.name, 'box'),
      anchor: 'box',
    }));
  }

  interestOf(id: string): number | undefined {
    return this.items.find((i) => i.id === id)?.interest ?? this.trackNames.get(id)?.interest;
  }

  /** What "analyse this" uses for a scanned thing: its name, so identify is not asked again. */
  identFor(o: Pick<SceneObject, 'id' | 'name'>, detectorGuessIsStored: boolean): IdentifyResponse | null {
    const it = this.items.find((i) => i.id === o.id);
    if (it) return ident(it.name, it.objectId);
    // A detected laptop, hand or eye opens its stored model as before, whatever the scan called it.
    if (detectorGuessIsStored) return null;
    const tn = this.trackNames.get(o.id);
    return tn && o.name === tn.name ? ident(tn.name, tn.objectId) : null;
  }

  /** Names for the detector's objects in a store publish; an object that already has a name keeps it. */
  withNames(objects: SceneObject[]): SceneObject[] {
    if (this.trackNames.size === 0) return objects;
    return objects.map((o) => {
      if (o.name) return o;
      const tn = this.trackNames.get(o.id);
      return tn ? { ...o, name: tn.name } : o;
    });
  }
}

const ident = (name: string, objectId?: string): IdentifyResponse => ({
  object_id: objectId ?? slugify(name),
  name,
  confidence: 0.8,
  summary: '',
});

/* ------------------------------ the browser side ------------------------------ */

const tracker = new ScanTracker();
const estimator = new ShiftEstimator();
const grey = new Float32Array(SHIFT_W * SHIFT_H);
/** The middle of the view at the last scan, for "has something new appeared there". */
const scanGrey = new Float32Array(SHIFT_W * SHIFT_H);

const state = {
  /** bumped when the overlay goes off: an answer for an older generation is dropped */
  gen: 0,
  on: false,
  onSince: 0,
  noKey: false,
  busy: false,
  inFlight: false,
  why: 'view' as 'view' | 'centre',
  hasScanned: false,
  scanAt: -Infinity,
  scanAx: 0,
  scanAy: 0,
  scanGreyValid: false,
  lostSinceScan: false,
  /** the last scan failed: try this view again once FAIL_BACKOFF_MS has passed */
  retry: false,
  /** ?mock=1: when the fake answer is due */
  mockDue: -1,
  doneAt: -1,
  seconds: 0,
  count: 0,
  error: null as string | null,
  failUntil: 0,
  steadySince: -1,
  /** since when the middle of the view has stopped changing (a thing held up has stopped moving) */
  calmSince: -1,
  speed: 0,
  /** bumped whenever positions are lost: an answer to a picture taken before that is dropped */
  lostEpoch: 0,
  lastVideoTime: -1,
  frames: 0,
  lastSampleAt: -1,
  sampleMs: 0,
  wasFrozen: false,
  tracked: [] as SceneObject[],
};

let sampleCtx: CanvasRenderingContext2D | null = null;
let scanCanvas: HTMLCanvasElement | null = null;

/** The video drawn at twice the sample size, then averaged 2 x 2 into `out` (less aliasing than one tiny draw). */
function sampleGrey(v: HTMLVideoElement, out: Float32Array): boolean {
  const W2 = SHIFT_W * 2;
  const H2 = SHIFT_H * 2;
  if (!sampleCtx) {
    const c = document.createElement('canvas');
    c.width = W2;
    c.height = H2;
    sampleCtx = c.getContext('2d');
    if (!sampleCtx) return false;
  }
  sampleCtx.drawImage(v, 0, 0, W2, H2);
  const d = sampleCtx.getImageData(0, 0, W2, H2).data;
  for (let y = 0; y < SHIFT_H; y++) {
    for (let x = 0; x < SHIFT_W; x++) {
      let s = 0;
      for (let k = 0; k < 4; k++) {
        const i = ((2 * y + (k >> 1)) * W2 + 2 * x + (k & 1)) * 4;
        s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      }
      out[y * SHIFT_W + x] = s * 0.25;
    }
  }
  return true;
}

/** The part of the frame the wearer sees (object-fit: cover crops it), frame fractions. */
function visibleRegion(): Box {
  const m = getCoverMap();
  const a = viewToFrame(m, 0, 0);
  const b = viewToFrame(m, m.vw, m.vh);
  const c = (n: number) => Math.min(1, Math.max(0, n));
  const x = c(a.x);
  const y = c(a.y);
  return { x, y, w: Math.max(0.01, c(b.x) - x), h: Math.max(0.01, c(b.y) - y) };
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result);
      resolve(s.slice(s.indexOf(',') + 1));
    };
    r.onerror = () => reject(r.error ?? new Error('could not read the picture'));
    r.readAsDataURL(blob);
  });
}

/** The visible part of the current frame, longest side SCAN_MAX_PX, faces painted black; the JPEG encodes off the main thread. */
function captureView(v: HTMLVideoElement, faces: Box[]): { image: Promise<string>; width: number; height: number; region: Box } | null {
  const fw = v.videoWidth;
  const fh = v.videoHeight;
  if (fw <= 0 || fh <= 0) return null;
  const region = visibleRegion();
  const sx = region.x * fw;
  const sy = region.y * fh;
  const sw = region.w * fw;
  const sh = region.h * fh;
  const scale = Math.min(1, SCAN_MAX_PX / Math.max(sw, sh));
  const ow = Math.max(16, Math.round(sw * scale));
  const oh = Math.max(16, Math.round(sh * scale));
  if (!scanCanvas) scanCanvas = document.createElement('canvas');
  if (scanCanvas.width !== ow || scanCanvas.height !== oh) {
    scanCanvas.width = ow;
    scanCanvas.height = oh;
  }
  const ctx = scanCanvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(v, sx, sy, sw, sh, 0, 0, ow, oh);
  ctx.fillStyle = '#000';
  for (const f of faces) {
    const px = f.w * FACE_PAD;
    const py = f.h * FACE_PAD;
    const x0 = ((f.x - px - region.x) / region.w) * ow;
    const y0 = ((f.y - py - region.y) / region.h) * oh;
    ctx.fillRect(Math.floor(x0), Math.floor(y0), Math.ceil(((f.w + 2 * px) / region.w) * ow) + 1, Math.ceil(((f.h + 2 * py) / region.h) * oh) + 1);
  }
  const canvas = scanCanvas;
  const image = new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('could not encode the picture'))), 'image/jpeg', SCAN_JPEG_QUALITY),
  ).then(blobToBase64);
  return { image, width: ow, height: oh, region };
}

/** Something with a name holds the middle of the view (not a hand: a thing held up in a hand still needs naming). */
function middleNamed(all: SceneObject[], focusedId: string | null): boolean {
  return all.some((o) => o.anchor !== 'hand' && (holdsMiddle(o.box) || (o.anchor === 'face' && o.id === focusedId)));
}

function reset(): void {
  state.gen += 1;
  state.inFlight = false;
  state.retry = false;
  state.hasScanned = false;
  state.scanGreyValid = false;
  state.steadySince = -1;
  state.calmSince = -1;
  state.speed = 0;
  state.lastSampleAt = -1;
  estimator.reset();
  tracker.clear();
}

/** Positions lost (a fast turn, an unfreeze): drop every scan object but the selected one, and any answer on its way. */
function lost(selectedId: string | null): void {
  tracker.lose(selectedId);
  state.lostEpoch += 1;
  state.lostSinceScan = true;
  state.steadySince = -1;
  state.calmSince = -1;
}

function sample(now: number, selectedId: string | null): void {
  const v = frame.video;
  if (!v || v.readyState < 2 || v.videoWidth <= 0) return;
  if (v.currentTime === state.lastVideoTime) return;
  state.lastVideoTime = v.currentTime;
  if (++state.frames % SAMPLE_EVERY !== 0) return;
  const t0 = performance.now();
  if (!sampleGrey(v, grey)) return;
  const r = estimator.push(grey);
  state.sampleMs += (performance.now() - t0 - state.sampleMs) * 0.1;
  const dt = state.lastSampleAt < 0 ? 0 : Math.max(1e-3, (now - state.lastSampleAt) / 1000);
  state.lastSampleAt = now;
  if (!r || dt === 0) return;
  if (!r.ok) {
    lost(selectedId);
    state.speed = STEADY_SPEED * 3;
    return;
  }
  tracker.shift(r.dx / SHIFT_W, r.dy / SHIFT_H);
  const calm = centreDiff(estimator.latest(), estimator.previous(), Math.round(r.dx), Math.round(r.dy)) < CENTRE_CALM;
  if (!calm) state.calmSince = -1;
  else if (state.calmSince < 0) state.calmSince = now;
  const speed = Math.hypot(r.dx, r.dy) / SHIFT_W / dt;
  state.speed += (speed - state.speed) * (1 - Math.exp(-dt / 0.15));
  if (state.speed < STEADY_SPEED) {
    if (state.steadySince < 0) state.steadySince = now;
  } else state.steadySince = -1;
}

function startScan(now: number, why: 'view' | 'centre', faces: Box[]): void {
  const v = frame.video;
  if (!v) return;
  const cap = captureView(v, faces);
  if (!cap) return;
  const gen = state.gen;
  const epoch = state.lostEpoch;
  const capAx = tracker.ax;
  const capAy = tracker.ay;
  state.inFlight = true;
  state.why = why;
  state.hasScanned = true;
  state.scanAt = now;
  state.scanAx = capAx;
  state.scanAy = capAy;
  state.lostSinceScan = false;
  scanGrey.set(estimator.latest());
  state.scanGreyValid = true;
  state.retry = false;
  const failed = (message: string) => {
    state.error = message;
    state.retry = true;
    state.failUntil = performance.now() + FAIL_BACKOFF_MS;
  };
  cap.image
    .then((image) => api.scan({ image, width: cap.width, height: cap.height }, { timeoutMs: CLIENT_TIMEOUT_MS }))
    .then((res) => {
      if (gen !== state.gen) return;
      state.doneAt = performance.now();
      state.seconds = res.seconds;
      if (res.mock) {
        // No Claude key on the server: scanning stops for this session; the labels are as before.
        state.noKey = true;
        tracker.clear();
        return;
      }
      if (res.fallback || !Array.isArray(res.things)) return failed(res.error ?? 'the scan failed');
      // The view was lost while Claude looked (a fast turn): its boxes cannot be placed any more.
      if (epoch !== state.lostEpoch) return;
      tracker.apply(res.things, cap.region, capAx, capAy, state.tracked, performance.now());
      state.count = res.things.length;
      state.error = null;
    })
    .catch((err: unknown) => {
      if (gen !== state.gen) return;
      failed(isServerDown(err) ? 'server not running' : errorText(err));
    })
    .finally(() => {
      if (gen === state.gen) state.inFlight = false;
    });
}

function maybeScan(now: number, all: SceneObject[], focusedId: string | null, faces: Box[]): void {
  if (state.inFlight || state.busy || now < state.failUntil || state.steadySince < 0) return;
  const steadyFor = now - state.steadySince;
  const since = now - state.scanAt;
  const moved = !state.hasScanned || state.lostSinceScan || state.retry || Math.hypot(tracker.ax - state.scanAx, tracker.ay - state.scanAy) > CHANGE_SHIFT;
  if (steadyFor >= STEADY_MS && since >= MIN_GAP_MS && (moved || since >= RESCAN_AFTER_MS)) {
    startScan(now, 'view', faces);
    return;
  }
  if (steadyFor < CENTRE_STEADY_MS || since < CENTRE_MIN_GAP_MS || middleNamed(all, focusedId)) return;
  if (state.calmSince < 0 || now - state.calmSince < STEADY_MS) return;
  const ox = Math.round((tracker.ax - state.scanAx) * SHIFT_W);
  const oy = Math.round((tracker.ay - state.scanAy) * SHIFT_H);
  const changed = moved || !state.scanGreyValid || centreDiff(estimator.latest(), scanGrey, ox, oy) > CENTRE_CHANGE;
  if (changed) startScan(now, 'centre', faces);
}

/** Fake things for `?mock=1` and the other mock scenes: clear of the mock laptop (either place) and hand; one names the phone. */
const MOCK_THINGS: ScanThing[] = [
  { name: 'Casio scientific calculator', box: { x: 0.74, y: 0.62, w: 0.12, h: 0.2 }, interest: 0.92 },
  { name: 'Noise-cancelling headphones', box: { x: 0.86, y: 0.36, w: 0.12, h: 0.18 }, interest: 0.85 },
  { name: 'Desk lamp', box: { x: 0.78, y: 0.06, w: 0.13, h: 0.26 }, interest: 0.75 },
  { name: 'Potted succulent', box: { x: 0.04, y: 0.05, w: 0.1, h: 0.17 }, interest: 0.7 },
  { name: 'Smartphone', box: { x: 0.12, y: 0.7, w: 0.08, h: 0.16 }, interest: 0.68 },
  { name: 'Wireless mouse', box: { x: 0.6, y: 0.82, w: 0.07, h: 0.1 }, interest: 0.62 },
  { name: 'Analogue wall clock', box: { x: 0.6, y: 0.04, w: 0.09, h: 0.15 }, interest: 0.55 },
  { name: 'Water bottle', box: { x: 0.92, y: 0.7, w: 0.05, h: 0.2 }, interest: 0.45 },
  { name: 'Coffee mug', box: { x: 0.22, y: 0.07, w: 0.07, h: 0.13 }, interest: 0.4 },
  { name: 'Paperback book', box: { x: 0.4, y: 0.04, w: 0.12, h: 0.12 }, interest: 0.35 },
];
const MOCK_SCAN_MS = 1200;

function mockTick(now: number): void {
  if (state.inFlight) {
    if (now < state.mockDue) return;
    state.inFlight = false;
    state.doneAt = now;
    state.seconds = MOCK_SCAN_MS / 1000;
    state.count = MOCK_THINGS.length;
    tracker.apply(MOCK_THINGS, { x: 0, y: 0, w: 1, h: 1 }, tracker.ax, tracker.ay, state.tracked, now);
    return;
  }
  if (state.busy) return;
  const due = state.hasScanned ? now - state.scanAt >= RESCAN_AFTER_MS : now - state.onSince >= STEADY_MS;
  if (!due) return;
  state.inFlight = true;
  state.why = 'view';
  state.hasScanned = true;
  state.scanAt = now;
  state.mockDue = now + MOCK_SCAN_MS;
}

export interface ScanContext {
  /** the detector's objects (or the mock ones) this frame */
  tracked: SceneObject[];
  /** everything else in view (hands, eyes, the pinned object), for "is the middle named" */
  others: SceneObject[];
  /** face outlines now (frame fractions): blacked out in the picture */
  faces: Box[];
  overlayOn: boolean;
  /** a model is open or loading: no scans */
  busy: boolean;
  frozen: boolean;
  selectedId: string | null;
  focusedId: string | null;
}

/**
 * The engine's hook, every frame: samples the shift, starts a scan when one is due, and returns the
 * scan objects to publish with the others. Off (nothing, ever) with `?scan=0` or without a key.
 */
export function scanTick(now: number, ctx: ScanContext): SceneObject[] {
  if (SCAN_OFF || state.noKey) return [];
  if (!ctx.overlayOn) {
    if (state.on) {
      state.on = false;
      reset();
    }
    return [];
  }
  if (!state.on) {
    state.on = true;
    state.onSince = now;
  }
  state.busy = ctx.busy;
  state.tracked = ctx.tracked;
  if (MOCK_MODE) {
    mockTick(now);
    return tracker.objects(ctx.tracked, ctx.selectedId, now);
  }
  if (ctx.frozen) {
    state.wasFrozen = true;
    return tracker.objects(ctx.tracked, ctx.selectedId, now);
  }
  if (state.wasFrozen) {
    // The view may have moved while the frame was frozen: positions are lost.
    state.wasFrozen = false;
    estimator.reset();
    state.lastSampleAt = -1;
    lost(ctx.selectedId);
  }
  sample(now, ctx.selectedId);
  const scanned = tracker.objects(ctx.tracked, ctx.selectedId, now);
  maybeScan(now, ctx.tracked.concat(ctx.others, scanned), ctx.focusedId, ctx.faces);
  return scanned;
}

/** For the store publish (engine.ts): scan names on the detector's objects that have no name yet. */
export const withScanNames = (objects: SceneObject[]): SceneObject[] => (SCAN_OFF ? objects : tracker.withNames(objects));

/** For "analyse this" (flow.ts): a scanned thing's name, so identify is not asked again; null for anything else. */
export const scanIdent = (o: Pick<SceneObject, 'id' | 'name'>, detectorGuessIsStored: boolean): IdentifyResponse | null =>
  SCAN_OFF ? null : tracker.identFor(o, detectorGuessIsStored);

/** For the labels (objectLabels.ts): true while the scan can add labels (then up to ten, ranked by interest). */
export const scanLabelsOn = (): boolean => !SCAN_OFF && !state.noKey;

/** The scan's name for a detector object (the store gets it at its next publish), for the labels. */
export const scanNameOf = (id: string): string | undefined => (SCAN_OFF ? undefined : tracker.trackNames.get(id)?.name);

/** How interesting a thing in view is (0..1), from the latest scan that found it; undefined for anything else. */
export const interestOf = (id: string): number | undefined => tracker.interestOf(id);

/** One line for the debug panel (D). */
export function scanDebugLine(now: number): string {
  const head = 'scan (#122, ?scan=0 off)';
  if (SCAN_OFF) return `${head}: off (?scan=0)`;
  if (state.noKey) return `${head}: off (the server has no Claude key)`;
  if (!state.on) return `${head}: waiting for the overlay`;
  const parts: string[] = [];
  if (state.inFlight) parts.push(`scanning (${state.why}) ${((now - state.scanAt) / 1000).toFixed(1)} s`);
  else if (state.busy) parts.push('paused: a model is open');
  else if (now < state.failUntil) parts.push(`waiting after a failure (${((state.failUntil - now) / 1000).toFixed(0)} s)`);
  else if (state.steadySince < 0) parts.push('waiting for a steady view');
  else parts.push(`steady ${((now - state.steadySince) / 1000).toFixed(1)} s`);
  const named = tracker.trackNames.size;
  parts.push(`${tracker.items.length} things${named ? ` + ${named} detector names` : ''}`);
  if (state.doneAt >= 0) parts.push(`last: ${state.count} found, ${((now - state.doneAt) / 1000).toFixed(0)} s ago, Claude ${state.seconds.toFixed(1)} s`);
  if (!MOCK_MODE) {
    parts.push(`moved ${Math.hypot(tracker.ax - state.scanAx, tracker.ay - state.scanAy).toFixed(2)} since scan`);
    parts.push(`speed ${state.speed.toFixed(2)}/s (steady < ${STEADY_SPEED})`);
    parts.push(`sampler ${state.sampleMs.toFixed(2)} ms`);
  }
  const centre = tracker.items.find((i) => i.centre)?.name ?? [...tracker.trackNames.values()].find((t) => t.centre)?.name;
  if (centre) parts.push(`centre: ${centre}`);
  if (state.error) parts.push(`last error: ${state.error}`);
  return `${head}: ${parts.join(' | ')}`;
}
