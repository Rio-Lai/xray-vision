/**
 * MediaPipe tasks-vision loading: wasm (local copy first, then jsDelivr), models (local
 * /models/* first, then the official storage.googleapis.com URLs), GPU delegate with CPU fallback.
 */
import { FilesetResolver, HandLandmarker, ObjectDetector } from '@mediapipe/tasks-vision';
import { errorText } from '../camera/frame';

/** Must match the installed @mediapipe/tasks-vision version (pin it in package.json). */
export const MEDIAPIPE_VERSION = '0.10.14';
const CDN_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;

const OD_LOCAL = '/models/efficientdet_lite0.tflite';
const OD_REMOTE =
  'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite';
const HL_LOCAL = '/models/hand_landmarker.task';
const HL_REMOTE =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

/** COCO classes worth tracking for the engineering lens. */
export const USEFUL_CLASSES = ['laptop', 'cell phone', 'keyboard', 'mouse', 'cup', 'bottle', 'book', 'remote', 'tv'];

export interface VisionTasks {
  objects: ObjectDetector | null;
  hands: HandLandmarker | null;
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

  const [odBuf, hlBuf] = await Promise.all([fetchLocalModel(OD_LOCAL), fetchLocalModel(HL_LOCAL)]);
  notes.push(`object model: ${odBuf ? 'local' : 'remote'}; hand model: ${hlBuf ? 'local' : 'remote'}`);

  const odPromise = withDelegates('object detector', notes, (delegate) =>
    ObjectDetector.createFromOptions(fileset, {
      baseOptions: odBuf ? { modelAssetBuffer: odBuf.slice(), delegate } : { modelAssetPath: OD_REMOTE, delegate },
      runningMode: 'VIDEO',
      scoreThreshold: 0.4,
      maxResults: 6,
      categoryAllowlist: USEFUL_CLASSES,
    }),
  );
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
  const objects = odRes.status === 'fulfilled' ? odRes.value : null;
  const hands = hlRes.status === 'fulfilled' ? hlRes.value : null;
  if (odRes.status === 'rejected') errors.push(`Object detector failed: ${errorText(odRes.reason)}`);
  if (hlRes.status === 'rejected') errors.push(`Hand landmarker failed: ${errorText(hlRes.reason)}`);
  if (!objects && !hands) throw new Error(errors.join(' | '));

  return {
    objects,
    hands,
    notes,
    errors,
    close: () => {
      try {
        objects?.close();
      } catch {
        /* ignore */
      }
      try {
        hands?.close();
      } catch {
        /* ignore */
      }
    },
  };
}
