/**
 * Detection engine, ticked once per animation frame by Stage.
 *  - hand landmarker on every new video frame
 *  - object detector on every 3rd new video frame, paused while store.frozen
 *  - focus = object of the current lens under the frame centre
 *  - store writes throttled to ~15 Hz; per-frame data goes to `live`
 */
import { useStore } from '../state/store';
import type { SceneObject } from '../state/store';
import type { Lens } from '../../shared/teardown';
import { errorText, frame, frameSize, MOCK_MODE } from '../camera/frame';
import { setStatus } from '../hud/hudStore';
import { loadVisionTasks, USEFUL_CLASSES } from './mediapipe';
import type { VisionTasks } from './mediapipe';
import { ObjectTracker } from './objectTracker';
import type { RawDetection } from './objectTracker';
import { HandTracker } from './handTracker';
import type { RawHand } from './handTracker';
import { mockHandLandmarks, mockLaptop } from './mock';
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

/** Object of `lens` whose box contains the frame centre (smallest), else nearest centre within 20% of frame width. */
export function computeFocus(objects: SceneObject[], lens: Lens, fw: number, fh: number): string | null {
  let best: string | null = null;
  let bestArea = Infinity;
  for (const o of objects) {
    if (o.lens !== lens) continue;
    const b = o.box;
    if (0.5 >= b.x && 0.5 <= b.x + b.w && 0.5 >= b.y && 0.5 <= b.y + b.h) {
      const a = b.w * b.h;
      if (a < bestArea) {
        bestArea = a;
        best = o.id;
      }
    }
  }
  if (best) return best;
  let bestD = 0.2 * fw;
  for (const o of objects) {
    if (o.lens !== lens) continue;
    const dx = (o.box.x + o.box.w / 2 - 0.5) * fw;
    const dy = (o.box.y + o.box.h / 2 - 0.5) * fh;
    const d = Math.hypot(dx, dy);
    if (d < bestD) {
      bestD = d;
      best = o.id;
    }
  }
  return best;
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
    setStatus('models', 'warn', 'MOCK MODE (?mock=1): fake laptop + hand, MediaPipe skipped');
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
      engObjects = [mockLaptop()];
      if (st.lens === 'biology') {
        handTracker.update([{ handedness: 'right', score: 0.99, landmarks: mockHandLandmarks(now) }], now, fw, fh);
      } else {
        handTracker.prune(now + 1e6); // drop the mock hand
      }
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
      const focus = computeFocus(live.objects, st.lens, fw, fh);
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
