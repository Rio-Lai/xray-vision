/**
 * Detection engine, ticked once per animation frame by Stage. Runs all the time, whether the
 * overlay is on or off, so "this" (focusedObjectId) is always ready for a voice command.
 *  - hand landmarker on every new video frame
 *  - object detector on every 3rd new video frame, paused while store.frozen
 *  - focus = the thing of any kind nearest the frame centre (with a short hysteresis)
 *  - store writes throttled to ~15 Hz; per-frame data goes to `live`
 */
import { useStore } from '../state/store';
import type { SceneObject } from '../state/store';
import { errorText, frame, frameSize, MOCK_MODE, MOCK_SCENE } from '../camera/frame';
import { setStatus } from '../hud/hudStore';
import { loadVisionTasks, USEFUL_CLASSES } from './mediapipe';
import type { VisionTasks } from './mediapipe';
import { ObjectTracker } from './objectTracker';
import type { RawDetection } from './objectTracker';
import { HandTracker } from './handTracker';
import type { RawHand } from './handTracker';
import { mockHandLandmarks, mockLaptop, mockPhone } from './mock';
import { live } from './live';

/**
 * MediaPipe labels handedness assuming a mirrored (selfie) image. Our cap camera is NOT mirrored,
 * so the labels are swapped. Add ?hands=raw to the URL to disable the swap if left/right look wrong.
 */
const FLIP_HANDEDNESS = (() => {
  try {
    return new URLSearchParams(window.location.search).get('hands') !== 'raw';
  } catch {
    return true;
  }
})();

const PUBLISH_MS = 66;
const OBJECT_EVERY_N_FRAMES = 3;
const USEFUL = new Set(USEFUL_CLASSES);

interface LooseCategory {
  categoryName?: string;
  displayName?: string;
  score?: number;
}
interface LooseDetection {
  categories?: LooseCategory[];
  boundingBox?: { originX: number; originY: number; width: number; height: number };
}
interface LooseHandResult {
  landmarks?: { x: number; y: number; z?: number }[][];
  handedness?: LooseCategory[][];
  handednesses?: LooseCategory[][];
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function parseDetections(res: unknown, vw: number, vh: number): RawDetection[] {
  const dets = (res as { detections?: LooseDetection[] } | null)?.detections ?? [];
  const out: RawDetection[] = [];
  for (const d of dets) {
    const c = d.categories?.[0];
    const bb = d.boundingBox;
    if (!c || !bb) continue;
    const label = (c.categoryName || c.displayName || '').toLowerCase();
    if (!USEFUL.has(label)) continue;
    const x0 = clamp01(bb.originX / vw);
    const y0 = clamp01(bb.originY / vh);
    const x1 = clamp01((bb.originX + bb.width) / vw);
    const y1 = clamp01((bb.originY + bb.height) / vh);
    if (x1 - x0 < 0.01 || y1 - y0 < 0.01) continue;
    out.push({ label, score: c.score ?? 0, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } });
  }
  return out;
}

function parseHands(res: unknown): RawHand[] {
  const r = (res ?? {}) as LooseHandResult;
  const lms = r.landmarks ?? [];
  const hd = r.handedness ?? r.handednesses ?? [];
  const out: RawHand[] = [];
  lms.forEach((lm, i) => {
    if (!lm || lm.length < 21) return;
    const cat = hd[i]?.[0];
    const name = (cat?.categoryName || cat?.displayName || 'Right').toLowerCase();
    const labelLeft = name.startsWith('l');
    const isLeft = FLIP_HANDEDNESS ? !labelLeft : labelLeft;
    out.push({
      handedness: isLeft ? 'left' : 'right',
      score: cat?.score ?? 0.9,
      landmarks: lm.map((p) => ({ x: p.x, y: p.y, z: p.z ?? 0 })),
    });
  });
  return out;
}

/** Max distance (fraction of frame width) from the frame centre to an object's centre to count as "this". */
const FOCUS_MAX_DIST = 0.25;
/** A hand over the centre wins only if its own centre is this close (fraction of frame width). */
const HAND_FOCUS_DIST = 0.15;
/** A new candidate must win for this long before focus moves to it (no flicker between overlapping boxes). */
const FOCUS_SWITCH_MS = 200;

/**
 * The thing of any kind at the frame centre: the smallest box that contains the centre, except
 * that a hand only counts when its own centre is within HAND_FOCUS_DIST (someone typing on the
 * laptop in view should not steal "this" from the laptop); else the nearest box centre within
 * FOCUS_MAX_DIST.
 */
export function focusCandidate(objects: SceneObject[], fw: number, fh: number): string | null {
  const centreDist = (o: SceneObject) =>
    Math.hypot((o.box.x + o.box.w / 2 - 0.5) * fw, (o.box.y + o.box.h / 2 - 0.5) * fh);
  let best: string | null = null;
  let bestArea = Infinity;
  let farHand: string | null = null;
  for (const o of objects) {
    const b = o.box;
    if (0.5 >= b.x && 0.5 <= b.x + b.w && 0.5 >= b.y && 0.5 <= b.y + b.h) {
      if (o.anchor === 'hand' && centreDist(o) > HAND_FOCUS_DIST * fw) {
        farHand = farHand ?? o.id;
        continue;
      }
      const a = b.w * b.h;
      if (a < bestArea) {
        bestArea = a;
        best = o.id;
      }
    }
  }
  if (best) return best;
  if (farHand) return farHand;
  let bestD = FOCUS_MAX_DIST * fw;
  for (const o of objects) {
    const d = centreDist(o);
    if (d < bestD) {
      bestD = d;
      best = o.id;
    }
  }
  return best;
}

/** focusCandidate with hysteresis: switches only after FOCUS_SWITCH_MS, or at once if the focused thing is gone. */
export class FocusTracker {
  private current: string | null = null;
  private pending: string | null = null;
  private pendingSince = 0;

  update(objects: SceneObject[], now: number, fw: number, fh: number): string | null {
    const cand = focusCandidate(objects, fw, fh);
    const alive = this.current !== null && objects.some((o) => o.id === this.current);
    if (!alive || cand === this.current) {
      this.current = alive ? this.current : cand;
      this.pending = null;
      return this.current;
    }
    if (cand !== this.pending) {
      this.pending = cand;
      this.pendingSince = now;
    } else if (now - this.pendingSince >= FOCUS_SWITCH_MS) {
      this.current = cand;
      this.pending = null;
    }
    return this.current;
  }
}

/** Keep names that /api/identify patched onto store objects. */
function withNames(next: SceneObject[], prev: SceneObject[]): SceneObject[] {
  if (prev.length === 0) return next;
  return next.map((o) => {
    if (o.name) return o;
    const p = prev.find((q) => q.id === o.id);
    return p && p.name ? { ...o, name: p.name } : o;
  });
}

export interface DetectionEngine {
  tick: (now: number) => void;
  dispose: () => void;
}

export function createDetectionEngine(): DetectionEngine {
  let disposed = false;
  let tasks: VisionTasks | null = null;
  const objTracker = new ObjectTracker();
  const handTracker = new HandTracker();
  const focusTracker = new FocusTracker();
  let lastVideoTime = -1;
  let newFrames = 0;
  let lastObjTs = 0;
  let lastHandTs = 0;
  let lastPublish = 0;
  let objPausedUntil = 0;
  let handPausedUntil = 0;
  let wasFrozen = false;
  let publishedEmpty = false;

  if (MOCK_MODE) {
    setStatus('models', 'warn', `Mock mode (${MOCK_SCENE} in the centre): fake laptop, phone and hand; MediaPipe skipped`);
  } else {
    setStatus('models', 'info', 'Loading vision models...');
    loadVisionTasks()
      .then((t) => {
        if (disposed) {
          t.close();
          return;
        }
        tasks = t;
        live.stats.notes = t.notes;
        setStatus('models', null);
        if (t.errors.length) setStatus('models', 'error', t.errors.join(' | '));
        const cpu = t.notes.find((n) => n.includes('using CPU'));
        if (cpu) setStatus('delegate', 'warn', cpu);
      })
      .catch((e: unknown) => {
        if (!disposed) setStatus('models', 'error', `Vision models failed: ${errorText(e)}`);
      });
  }

  function runVision(now: number, frozen: boolean, fw: number, fh: number): void {
    const t = tasks;
    const v = frame.video;
    if (!t || !v || v.readyState < 2 || v.videoWidth <= 0) return;
    frame.width = v.videoWidth;
    frame.height = v.videoHeight;
    if (v.currentTime === lastVideoTime) return; // no new camera frame yet
    lastVideoTime = v.currentTime;
    newFrames += 1;

    if (t.hands && now >= handPausedUntil) {
      try {
        lastHandTs = Math.max(now, lastHandTs + 1);
        const t0 = performance.now();
        const res = t.hands.detectForVideo(v, lastHandTs);
        live.stats.handMs = performance.now() - t0;
        handTracker.update(parseHands(res), now, fw, fh);
        setStatus('hands', null);
      } catch (e) {
        handPausedUntil = now + 1000;
        setStatus('hands', 'error', `Hand tracking error: ${errorText(e)}`);
      }
    }

    if (t.objects && !frozen && newFrames % OBJECT_EVERY_N_FRAMES === 0 && now >= objPausedUntil) {
      try {
        lastObjTs = Math.max(now, lastObjTs + 1);
        const t0 = performance.now();
        const res = t.objects.detectForVideo(v, lastObjTs);
        live.stats.objMs = performance.now() - t0;
        objTracker.update(parseDetections(res, v.videoWidth, v.videoHeight), now);
        setStatus('objects', null);
      } catch (e) {
        objPausedUntil = now + 1000;
        setStatus('objects', 'error', `Object detection error: ${errorText(e)}`);
      }
    }
  }

  function tick(now: number): void {
    if (disposed) return;
    const st = useStore.getState();
    const { w: fw, h: fh } = frameSize();
    const frozen = st.frozen;
    if (wasFrozen && !frozen) objTracker.touchAll(now);
    wasFrozen = frozen;

    let engObjects: SceneObject[];
    if (MOCK_MODE) {
      const handInCentre = MOCK_SCENE === 'hand';
      engObjects = [mockLaptop(!handInCentre), mockPhone()];
      const lm = mockHandLandmarks(now, handInCentre ? 0 : 0.3);
      handTracker.update([{ handedness: 'right', score: 0.99, landmarks: lm }], now, fw, fh);
    } else {
      runVision(now, frozen, fw, fh);
      if (!frozen) objTracker.prune(now);
      handTracker.prune(now);
      engObjects = objTracker.objects();
    }

    live.hands = handTracker.hands;
    live.objects = engObjects.concat(handTracker.sceneObjects());

    if (now - lastPublish >= PUBLISH_MS) {
      lastPublish = now;
      const focus = focusTracker.update(live.objects, now, fw, fh);
      if (focus !== st.focusedObjectId) st.setFocusedObject(focus);
      const empty = live.objects.length === 0;
      if (!empty || !publishedEmpty) st.setObjects(withNames(live.objects, st.objects));
      publishedEmpty = empty;
      if (handTracker.hands.length > 0 || st.hands.length > 0) st.setHands(handTracker.states());
    }
  }

  return {
    tick,
    dispose: () => {
      disposed = true;
      tasks?.close();
      tasks = null;
      objTracker.clear();
      handTracker.clear();
      live.objects = [];
      live.hands = [];
    },
  };
}
