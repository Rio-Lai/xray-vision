/**
 * MediaPipe tasks-vision loading: wasm (local copy first, then jsDelivr), models (local
 * /models/* first, then the official storage.googleapis.com URLs), GPU delegate with CPU fallback.
 * The face landmarker (#94: eyes, blinks, gaze) loads beside the other two but is not waited for:
 * the object detector and hand tracker start as soon as they are ready, and a face model that fails
 * to load leaves them working (VisionTasks.faces stays null, the debug panel says why).
 * Object detector (#110): EfficientDet-Lite2 from the local file; Lite0 if Lite2 fails to load
 * (and, decided by the engine, if Lite2 is too slow here). Without a local Lite2, Lite0 starts at
 * once and Lite2 is downloaded in the background and swapped in, so an offline laptop still has Lite0.
 * `?detector=lite0` / `?detector=lite2` forces one (a failed Lite2 still falls back to Lite0).
 */
import { FaceLandmarker, FilesetResolver, HandLandmarker, ObjectDetector } from '@mediapipe/tasks-vision';
import { errorText, urlParam } from '../camera/frame';
import { KEEP_SCORE } from './objectTracker';

/** Must match the installed @mediapipe/tasks-vision version (pin it in package.json). */
export const MEDIAPIPE_VERSION = '0.10.14';
const CDN_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;

const OD_MODELS = {
  lite0: {
    local: '/models/efficientdet_lite0.tflite',
    remote: 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite',
  },
  lite2: {
    local: '/models/efficientdet_lite2.tflite',
    remote: 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite2/float16/1/efficientdet_lite2.tflite',
  },
} as const;
export type DetectorKind = keyof typeof OD_MODELS;
const DETECTOR_RAW = urlParam('detector');
/** `?detector=lite0` / `?detector=lite2`, else 'auto' (Lite2, Lite0 if it fails or is too slow). */
export const DETECTOR_CHOICE: DetectorKind | 'auto' = DETECTOR_RAW === 'lite0' || DETECTOR_RAW === 'lite2' ? DETECTOR_RAW : 'auto';
/** The background Lite2 download (no local file) is given up after this long. */
const LITE2_DOWNLOAD_MS = 60_000;
const HL_LOCAL = '/models/hand_landmarker.task';
const HL_REMOTE =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const FL_LOCAL = '/models/face_landmarker.task';
const FL_REMOTE =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

/**
 * COCO classes worth labelling: everyday things that could be on a desk or handed over by a judge
 * (#80). Not `person` (the room would be covered in labels), not furniture that fills the view
 * (dining table, couch, bed), and not chairs, plants or umbrellas: in a room full of them a background
 * box at the centre of the view would take "this" away from the thing the wearer is holding up. Friendly names for each: src/hud/names.ts.
 */
export const USEFUL_CLASSES = [
  'laptop',
  'cell phone',
  'keyboard',
  'mouse',
  'remote',
  'tv',
  'book',
  'clock',
  'scissors',
  'cup',
  'bottle',
  'bowl',
  'fork',
  'knife',
  'spoon',
  'banana',
  'apple',
  'orange',
  'backpack',
  'handbag',
  'vase',
  'teddy bear',
  'toothbrush',
  'sports ball',
];

export interface VisionTasks {
  /** The object detector in use; switchDetector replaces it (#110). */
  objects: ObjectDetector | null;
  /** Which model `objects` is; null if none loaded. */
  detector: DetectorKind | null;
  /** Why the detector is the one it is, for the debug panel ('' for Lite2 from the local file). */
  detectorNote: string;
  /** Loads `kind` and swaps it in for `objects` (the old one is closed); false if it failed (the old one stays). */
  switchDetector: (kind: DetectorKind) => Promise<boolean>;
  hands: HandLandmarker | null;
  /** Face landmarker: null until it has loaded (it is not waited for), and for good if it failed. */
  faces: FaceLandmarker | null;
  /** Settles once the face landmarker has loaded (true) or failed (false); its error is then in `errors`. */
  facesReady: Promise<boolean>;
  /** Human-readable notes (where things loaded from, CPU fallbacks). */
  notes: string[];
  /** Errors for a task that failed while the other loaded. */
  errors: string[];
  close: () => void;
}

type Fileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;
type Delegate = 'GPU' | 'CPU';

/** true if the dev server really serves the file (Vite answers missing files with index.html). */
async function isServed(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    const ct = r.headers.get('content-type') ?? '';
    return r.ok && !ct.includes('text/html');
  } catch {
    return false;
  }
}

async function fetchLocalModel(path: string): Promise<Uint8Array | null> {
  try {
    const r = await fetch(path);
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') ?? '';
    if (ct.includes('text/html')) return null;
    const buf = new Uint8Array(await r.arrayBuffer());
    return buf.byteLength > 100_000 ? buf : null;
  } catch {
    return null;
  }
}

/** A model the dev server does not have, fetched here with a time limit. */
async function downloadModel(url: string, ms: number): Promise<Uint8Array> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.byteLength <= 100_000) throw new Error('file too small');
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

async function withDelegates<T>(name: string, notes: string[], make: (d: Delegate) => Promise<T>): Promise<T> {
  try {
    const t = await make('GPU');
    return t;
  } catch (gpuErr) {
    notes.push(`${name}: GPU delegate failed (${errorText(gpuErr)}), using CPU`);
    return make('CPU');
  }
}

export async function loadVisionTasks(): Promise<VisionTasks> {
  const notes: string[] = [];
  const errors: string[] = [];

  const localWasm = await isServed('/models/wasm/vision_wasm_internal.js');
  const wasmBase = localWasm ? new URL('/models/wasm', window.location.origin).href : CDN_WASM;
  notes.push(`wasm: ${localWasm ? 'local /models/wasm' : `CDN ${MEDIAPIPE_VERSION}`}`);

  let fileset: Fileset;
  try {
    fileset = await FilesetResolver.forVisionTasks(wasmBase);
  } catch (e) {
    throw new Error(
      `MediaPipe wasm failed to load from ${localWasm ? '/models/wasm' : 'jsDelivr'} (${errorText(e)}). Run: node scripts/fetch-models.mjs`,
    );
  }

  // The face landmarker starts now but nothing waits for it (see the header).
  const flPromise = (async () => {
    const flBuf = await fetchLocalModel(FL_LOCAL);
    notes.push(`face model: ${flBuf ? 'local' : 'remote'}`);
    return withDelegates('face landmarker', notes, (delegate) =>
      FaceLandmarker.createFromOptions(fileset, {
        baseOptions: flBuf ? { modelAssetBuffer: flBuf.slice(), delegate } : { modelAssetPath: FL_REMOTE, delegate },
        runningMode: 'VIDEO',
        numFaces: 2,
        minFaceDetectionConfidence: 0.5,
        minFacePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
      }),
    );
  })();
  flPromise.catch(() => undefined); // handled below; this only keeps an early failure from being reported as unhandled

  let closed = false;
  const tasks: VisionTasks = {
    objects: null,
    detector: null,
    detectorNote: DETECTOR_CHOICE === 'auto' ? '' : `forced by ?detector=${DETECTOR_CHOICE}`,
    switchDetector: (kind) =>
      useDetector(kind).then(
        () => true,
        (e: unknown) => {
          notes.push(`object model ${kind} failed: ${errorText(e)}`);
          return false;
        },
      ),
    hands: null,
    faces: null,
    facesReady: Promise.resolve(false),
    notes,
    errors,
    close: () => {
      closed = true;
      for (const t of [tasks.objects, tasks.hands, tasks.faces]) {
        try {
          t?.close();
        } catch {
          /* ignore */
        }
      }
      tasks.faces = null;
    },
  };

  /** Loads one detector model (local file; else Lite2 downloaded here, Lite0 by URL) and makes it `objects`. Throws on failure. */
  async function useDetector(kind: DetectorKind, localBuf?: Uint8Array | null): Promise<void> {
    let buf = localBuf ?? (await fetchLocalModel(OD_MODELS[kind].local));
    const from = buf ? 'local' : 'remote';
    if (!buf && kind === 'lite2') buf = await downloadModel(OD_MODELS.lite2.remote, LITE2_DOWNLOAD_MS);
    const make = (delegate: Delegate) =>
      ObjectDetector.createFromOptions(fileset, {
        baseOptions: buf ? { modelAssetBuffer: buf.slice(), delegate } : { modelAssetPath: OD_MODELS[kind].remote, delegate },
        runningMode: 'VIDEO',
        // Down to the keep threshold; the tracker asks APPEAR_SCORE of a new thing (#110).
        scoreThreshold: KEEP_SCORE,
        // More classes means more boxes in a busy room; the view still shows at most four labels.
        maxResults: 10,
        categoryAllowlist: USEFUL_CLASSES,
      });
    // Lite2 on the CPU is far too slow to be worth it: without the GPU, Lite0 (GPU, then CPU).
    const od = kind === 'lite2' ? await make('GPU') : await withDelegates('object detector', notes, make);
    if (closed) {
      od.close();
      return;
    }
    const old = tasks.objects;
    tasks.objects = od;
    tasks.detector = kind;
    notes.push(`object model: ${kind} ${from}`);
    try {
      old?.close();
    } catch {
      /* ignore */
    }
  }

  let lite2Later = false;
  const odPromise = (async () => {
    if (DETECTOR_CHOICE !== 'lite0') {
      const l2 = await fetchLocalModel(OD_MODELS.lite2.local);
      if (l2) {
        try {
          await useDetector('lite2', l2);
          return;
        } catch (e) {
          tasks.detectorNote = `Lite2 failed to load (${errorText(e)})`;
        }
      } else lite2Later = true;
    }
    await useDetector('lite0');
  })();
  odPromise.catch(() => undefined); // handled by allSettled below (the hand model is fetched first)

  const hlBuf = await fetchLocalModel(HL_LOCAL);
  notes.push(`hand model: ${hlBuf ? 'local' : 'remote'}`);

  const hlPromise = withDelegates('hand landmarker', notes, (delegate) =>
    HandLandmarker.createFromOptions(fileset, {
      baseOptions: hlBuf ? { modelAssetBuffer: hlBuf.slice(), delegate } : { modelAssetPath: HL_REMOTE, delegate },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    }),
  );

  const [odRes, hlRes] = await Promise.allSettled([odPromise, hlPromise]);
  tasks.hands = hlRes.status === 'fulfilled' ? hlRes.value : null;
  if (odRes.status === 'rejected') errors.push(`Object detector failed: ${errorText(odRes.reason)}`);
  if (hlRes.status === 'rejected') errors.push(`Hand landmarker failed: ${errorText(hlRes.reason)}`);
  if (!tasks.objects && !tasks.hands) {
    // Nothing else works: the face model alone is not worth keeping.
    flPromise.then((fl) => fl.close()).catch(() => undefined);
    throw new Error(errors.join(' | '));
  }
  if (lite2Later && tasks.objects) {
    // Lite0 runs now; Lite2 (not in public/models) comes down in the background and takes over.
    tasks.detectorNote = 'Lite2 not in public/models: downloading it (npm run fetch-models keeps it local)';
    void tasks.switchDetector('lite2').then((ok) => {
      tasks.detectorNote = ok
        ? 'Lite2 downloaded (npm run fetch-models keeps it local)'
        : 'Lite2 not in public/models and the download failed: run npm run fetch-models';
    });
  }
  tasks.facesReady = flPromise.then(
    (fl) => {
      if (closed) {
        try {
          fl.close();
        } catch {
          /* ignore */
        }
        return false;
      }
      tasks.faces = fl;
      return true;
    },
    (e: unknown) => {
      errors.push(`Face landmarker failed: ${errorText(e)}`);
      return false;
    },
  );
  return tasks;
}
