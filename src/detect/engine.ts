/**
 * Detection engine, ticked once per animation frame by Stage. Runs all the time, whether the
 * overlay is on or off, so "this" (focusedObjectId) is always ready for a voice command.
 *  - hand landmarker on every new video frame
 *  - object detector on every 3rd new video frame, or every 2nd when its first second shows it is
 *    quick enough (#110, detectorTiming.ts; a Lite2 too slow here is swapped for Lite0), never on a
 *    face frame, paused while store.frozen
 *  - face landmarker on every 3rd new video frame too, on the frames between (#94), on a square crop
 *    of the middle of the frame (a face one to two metres away is then big enough to find); its eyes
 *    are scene objects (faceTracker.ts)
 *  - focus = the thing of any kind nearest the frame centre (with a short hysteresis); looking at a
 *    face makes its nearer eye "this".
 *  - plus one pinned object for "analyse this" on something undetected (centre.ts), republished while selected
 *  - plus, while the overlay is on, the things Claude's whole-view scan found that nothing here tracks
 *    (scan.ts, #122; `?scan=0` turns it off); its names go onto the detector's objects at publish
 *  - store writes throttled to ~15 Hz; per-frame data goes to `live`
 */
import { useStore } from '../state/store';
import type { SceneObject } from '../state/store';
import { errorText, frame, frameSize, MOCK_GESTURE, MOCK_MODE, MOCK_SCENE, urlNumber } from '../camera/frame';
import type { Box } from '../state/store';
import { setStatus } from '../hud/hudStore';
import { DETECTOR_CHOICE, loadVisionTasks, USEFUL_CLASSES } from './mediapipe';
import type { VisionTasks } from './mediapipe';
import { APPEAR_SCORE, KEEP_SCORE, ObjectTracker } from './objectTracker';
import { DetectorTiming, LITE2_MAX_MS } from './detectorTiming';
import type { RawDetection } from './objectTracker';
import { HandTracker, handTuning } from './handTracker';
import type { RawHand } from './handTracker';
import { mockBottle, mockFace, mockHandLandmarks, mockLaptop, mockPhone } from './mock';
import { FaceTracker, blendshapeMap, measureFace } from './faceTracker';
import type { FaceFocus, FaceMeasure } from './faceTracker';
import { pinnedObjects } from './centre';
import { scanTick, withScanNames } from './scan';
import { mockGestureHands } from './mockGesture';

/** ?mock=gesture: the scripted hands start this long after the page (the laptop is analysed first). */
const MOCK_GESTURE_START_MS = 2600;
import { live } from './live';


const PUBLISH_MS = 66;
/**
 * Which of every six new frames run the object detector (#110): every 3rd as before, or every 2nd
 * when it is quick enough. The face landmarker has frames 1 and 4 of the six, so 4 moves to 5.
 */
const OBJECT_SLOTS: Record<2 | 3, readonly boolean[]> = {
  3: [true, false, false, true, false, false],
  2: [true, false, true, false, false, true],
};
/** The face landmarker runs on every 3rd new frame as well, one frame after the object detector. */
const FACE_EVERY_N_FRAMES = 3;
const FACE_PHASE = 1;
/**
 * The face landmarker sees a centred square of this share of the frame height (`?facecrop=1`: the
 * whole frame). Its face detector works on a 128 px image: from the whole 16:9 frame a face 1.5 m
 * away is about 9 px there and is missed; from the middle square it is two to three times bigger.
 */
const FACE_CROP = Math.min(1, Math.max(0.3, urlNumber('facecrop', 0.6)));
/** Largest side of the crop canvas (px): the crop is drawn at the camera's own resolution up to this. */
const FACE_CROP_MAX_PX = 720;
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
interface LooseFaceResult {
  faceLandmarks?: { x: number; y: number; z?: number }[][];
  faceBlendshapes?: { categories?: LooseCategory[] }[];
  facialTransformationMatrixes?: { data?: ArrayLike<number> }[];
}
/** Where the face landmarker's image sits in the frame (frame-normalised), to map its landmarks back; frame size in px. */
interface FaceSource {
  x: number;
  y: number;
  w: number;
  h: number;
  fw: number;
  fh: number;
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
    // MediaPipe assumes a mirrored (selfie) image; our camera is not mirrored (see handTuning).
    const isLeft = handTuning.swapHandedness ? !labelLeft : labelLeft;
    out.push({
      handedness: isLeft ? 'left' : 'right',
      score: cat?.score ?? 0.9,
      landmarks: lm.map((p) => ({ x: p.x, y: p.y, z: p.z ?? 0 })),
    });
  });
  return out;
}

function parseFaces(res: unknown, src: FaceSource): FaceMeasure[] {
  const r = (res ?? {}) as LooseFaceResult;
  const out: FaceMeasure[] = [];
  (r.faceLandmarks ?? []).forEach((lm, i) => {
    if (!lm || lm.length < 468) return;
    // crop-normalised -> frame-normalised
    const pts = lm.map((p) => ({ x: src.x + p.x * src.w, y: src.y + p.y * src.h }));
    const shapes = blendshapeMap(r.faceBlendshapes?.[i]?.categories);
    const data = r.facialTransformationMatrixes?.[i]?.data;
    const m = measureFace(pts, shapes, data ? Array.from(data) : undefined, src.fw, src.fh, 0.9);
    if (m) out.push(m);
  });
  return out;
}

/** Max distance (fraction of frame width) from the frame centre to an object's centre to count as "this". */
const FOCUS_MAX_DIST = 0.25;
/** A hand over the centre wins only if its own centre is this close (fraction of frame width). */
const HAND_FOCUS_DIST = 0.15;
/** A new candidate must win for this long before focus moves to it (no flicker between overlapping boxes). */
const FOCUS_SWITCH_MS = 200;

/** The current eye keeps focus over its neighbour unless the other is clearly nearer (ratio). */
const EYE_KEEP = 1.25;

const holdsCentre = (b: Box) => 0.5 >= b.x && 0.5 <= b.x + b.w && 0.5 >= b.y && 0.5 <= b.y + b.h;

/**
 * The thing of any kind at the frame centre: the smallest box that contains the centre, except
 * that a hand only counts when its own centre is within HAND_FOCUS_DIST (someone typing on the
 * laptop in view should not steal "this" from the laptop); else the nearest box centre within
 * FOCUS_MAX_DIST.
 * Eyes (#94): when the centre is inside a face's outline, the nearer eye of that face is "this",
 * unless a box smaller than the face holds the centre, or a hand is right in the middle (so the
 * wearer's own hands and things held up in front of a face keep winning). `current` (the focus now)
 * is kept between a face's two eyes unless the other is clearly nearer. Eyes never win otherwise.
 */
export function focusCandidate(
  objects: SceneObject[],
  fw: number,
  fh: number,
  faces: FaceFocus[] = [],
  current: string | null = null,
): string | null {
  const centreDist = (o: Pick<SceneObject, 'box'>) =>
    Math.hypot((o.box.x + o.box.w / 2 - 0.5) * fw, (o.box.y + o.box.h / 2 - 0.5) * fh);
  let best: string | null = null;
  let bestArea = Infinity;
  let bestIsHand = false;
  let farHand: string | null = null;
  for (const o of objects) {
    if (o.anchor === 'face') continue; // eyes: through their face, below
    const b = o.box;
    if (holdsCentre(b)) {
      if (o.anchor === 'hand' && centreDist(o) > HAND_FOCUS_DIST * fw) {
        farHand = farHand ?? o.id;
        continue;
      }
      const a = b.w * b.h;
      if (a < bestArea) {
        bestArea = a;
        best = o.id;
        bestIsHand = o.anchor === 'hand';
      }
    }
  }
  const face = faces
    .filter((f) => holdsCentre(f.outline))
    .reduce<FaceFocus | null>((a, f) => (!a || centreDist({ box: f.outline }) < centreDist({ box: a.outline }) ? f : a), null);
  if (face && !(best && (bestIsHand || bestArea < face.outline.w * face.outline.h))) {
    const eyes = objects.filter((o) => face.eyeIds.includes(o.id));
    if (eyes.length > 0) {
      let pick = eyes.reduce((a, o) => (centreDist(o) < centreDist(a) ? o : a));
      const cur = eyes.find((o) => o.id === current);
      if (cur && centreDist(cur) <= centreDist(pick) * EYE_KEEP + 0.005 * fw) pick = cur;
      return pick.id;
    }
  }
  if (best) return best;
  if (farHand) return farHand;
  let bestD = FOCUS_MAX_DIST * fw;
  for (const o of objects) {
    // An eye is "this" only while the wearer looks at its face (above): a face near the middle of
    // the view does not take focus from the empty space or the undetected thing being looked at.
    if (o.anchor === 'face') continue;
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

  update(objects: SceneObject[], now: number, fw: number, fh: number, faces: FaceFocus[] = []): string | null {
    const cand = focusCandidate(objects, fw, fh, faces, this.current);
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
  const objTiming = new DetectorTiming();
  let timedDetector: unknown = null;
  let lite0Asked = false;
  const handTracker = new HandTracker();
  const faceTracker = new FaceTracker();
  const focusTracker = new FocusTracker();
  let faceCanvas: HTMLCanvasElement | null = null;
  let lastFaceTs = 0;
  let facePausedUntil = 0;
  let lastVideoTime = -1;
  let newFrames = 0;
  let lastObjTs = 0;
  let lastHandTs = 0;
  let lastPublish = 0;
  let objPausedUntil = 0;
  let handPausedUntil = 0;
  let wasFrozen = false;
  let publishedEmpty = false;
  let mockStart = -1;

  if (MOCK_MODE) {
    setStatus(
      'models',
      'warn',
      `Mock mode (${MOCK_SCENE} in the centre): fake laptop, phone and hand${MOCK_SCENE === 'eye' ? ', and a face' : ''}; MediaPipe skipped`,
    );
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
        // The face model is not waited for: the rest works without it (#94).
        setStatus('faces', 'info', 'Loading the face model...');
        void t.facesReady.then((ok) => {
          if (disposed) return;
          if (ok) setStatus('faces', null);
          else setStatus('faces', 'error', `${t.errors.find((x) => x.startsWith('Face')) ?? 'Face landmarker failed'}: no eyes (everything else works)`);
          const faceCpu = t.notes.find((n) => n.startsWith('face landmarker') && n.includes('using CPU'));
          if (faceCpu) setStatus('delegate-face', 'warn', faceCpu);
        });
      })
      .catch((e: unknown) => {
        if (!disposed) setStatus('models', 'error', `Vision models failed: ${errorText(e)}`);
      });
  }

  /** The middle of the frame as a square canvas for the face landmarker (or the video itself for ?facecrop=1). */
  function faceInput(v: HTMLVideoElement): { image: HTMLVideoElement | HTMLCanvasElement; src: FaceSource } | null {
    const fw = v.videoWidth;
    const fh = v.videoHeight;
    if (FACE_CROP >= 1) return { image: v, src: { x: 0, y: 0, w: 1, h: 1, fw, fh } };
    const size = Math.round(Math.min(fw, fh) * FACE_CROP);
    if (size < 16) return null;
    const px = Math.min(size, FACE_CROP_MAX_PX);
    if (!faceCanvas) faceCanvas = document.createElement('canvas');
    if (faceCanvas.width !== px || faceCanvas.height !== px) {
      faceCanvas.width = px;
      faceCanvas.height = px;
    }
    const ctx = faceCanvas.getContext('2d');
    if (!ctx) return null;
    const sx = Math.round((fw - size) / 2);
    const sy = Math.round((fh - size) / 2);
    ctx.drawImage(v, sx, sy, size, size, 0, 0, px, px);
    return { image: faceCanvas, src: { x: sx / fw, y: sy / fh, w: size / fw, h: size / fh, fw, fh } };
  }

  /** Lite2 (not forced) too slow or failing here: swap in Lite0, once (#110). */
  function fallBackToLite0(t: VisionTasks, why: string): void {
    if (lite0Asked || t.detector !== 'lite2' || DETECTOR_CHOICE !== 'auto') return;
    lite0Asked = true;
    t.detectorNote = `${why}; loading Lite0`;
    void t.switchDetector('lite0').then((ok) => {
      t.detectorNote = ok ? why : `${why}, but Lite0 failed to load: kept Lite2`;
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

    if (t.objects && !frozen && OBJECT_SLOTS[objTiming.every][newFrames % 6] && now >= objPausedUntil) {
      try {
        if (t.objects !== timedDetector) {
          timedDetector = t.objects; // a new detector (Lite2 swapped in, or Lite0 for it): measure again
          objTiming.reset();
        }
        lastObjTs = Math.max(now, lastObjTs + 1);
        const t0 = performance.now();
        const res = t.objects.detectForVideo(v, lastObjTs);
        live.stats.objMs = performance.now() - t0;
        if (objTiming.record(live.stats.objMs, now) && objTiming.medianMs > LITE2_MAX_MS) {
          fallBackToLite0(t, `Lite2 too slow here: median ${objTiming.medianMs.toFixed(1)} ms > ${LITE2_MAX_MS} ms`);
        }
        const note = t.detectorNote ? ` (${t.detectorNote})` : '';
        live.stats.detector = `detector ${t.detector ?? '-'}${note} | ${objTiming.describe()} | appear ${APPEAR_SCORE} keep ${KEEP_SCORE} (?detector=lite0|lite2 ?appear= ?keep=)`;
        objTracker.update(parseDetections(res, v.videoWidth, v.videoHeight), now);
        setStatus('objects', null);
      } catch (e) {
        objPausedUntil = now + 1000;
        setStatus('objects', 'error', `Object detection error: ${errorText(e)}`);
        fallBackToLite0(t, `Lite2 failed to run (${errorText(e)})`);
      }
    }

    if (t.faces && newFrames % FACE_EVERY_N_FRAMES === FACE_PHASE && now >= facePausedUntil) {
      try {
        const input = faceInput(v);
        if (input) {
          lastFaceTs = Math.max(now, lastFaceTs + 1);
          const t0 = performance.now();
          const res = t.faces.detectForVideo(input.image, lastFaceTs);
          live.stats.faceMs = performance.now() - t0;
          faceTracker.update(parseFaces(res, input.src), now);
          setStatus('faces', null);
        }
      } catch (e) {
        facePausedUntil = now + 1000;
        setStatus('faces', 'error', `Face tracking error: ${errorText(e)}`);
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
    if (MOCK_MODE && MOCK_GESTURE) {
      if (mockStart < 0) mockStart = now;
      engObjects = [mockLaptop(true), mockPhone()];
      const t = now - mockStart - MOCK_GESTURE_START_MS;
      handTracker.update(t < 0 ? [] : mockGestureHands(t, fw, fh), now, fw, fh);
    } else if (MOCK_MODE) {
      const handInCentre = MOCK_SCENE === 'hand';
      const eyeScene = MOCK_SCENE === 'eye';
      const bottleScene = MOCK_SCENE === 'bottle';
      // #124: the bottle (not stored) on the right, or in the middle with ?mock=bottle
      engObjects = [mockLaptop(!handInCentre && !eyeScene && !bottleScene), mockPhone(), mockBottle(bottleScene)];
      const lm = mockHandLandmarks(now, handInCentre ? 0 : 0.3);
      handTracker.update([{ handedness: 'right', score: 0.99, landmarks: lm }], now, fw, fh);
      // ?mock=eye: a face in the middle of the view (its eyes are "this").
      faceTracker.update(eyeScene ? [mockFace(now)] : [], now);
    } else {
      runVision(now, frozen, fw, fh);
      if (!frozen) objTracker.prune(now);
      handTracker.prune(now);
      faceTracker.prune(now);
      engObjects = objTracker.objects();
    }

    live.hands = handTracker.hands;
    live.faces = faceTracker.views();
    // Plus the thing Claude named in the middle of the view, while it is selected (centre.ts, #80).
    live.objects = engObjects.concat(handTracker.sceneObjects(), faceTracker.sceneObjects(), pinnedObjects(st.selectedObjectId, now));
    // Plus what the whole-view scan found (scan.ts, #122): nothing with ?scan=0, without a key or with the overlay off.
    const scanned = scanTick(now, {
      tracked: engObjects,
      others: live.objects,
      faces: live.faces.map((f) => f.outline),
      overlayOn: st.overlayOn,
      busy: st.teardown !== null || st.teardownStatus === 'loading',
      frozen,
      selectedId: st.selectedObjectId,
      focusedId: st.focusedObjectId,
    });
    if (scanned.length > 0) live.objects = live.objects.concat(scanned);

    if (now - lastPublish >= PUBLISH_MS) {
      lastPublish = now;
      const focus = focusTracker.update(live.objects, now, fw, fh, faceTracker.focusFaces());
      if (focus !== st.focusedObjectId) st.setFocusedObject(focus);
      const empty = live.objects.length === 0;
      if (!empty || !publishedEmpty) st.setObjects(withScanNames(withNames(live.objects, st.objects)));
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
      faceTracker.clear();
      faceCanvas = null;
      live.objects = [];
      live.hands = [];
      live.faces = [];
    },
  };
}
