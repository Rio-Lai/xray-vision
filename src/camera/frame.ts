/**
 * Frame runtime + coordinate mapping.
 *
 * The camera module writes the live <video> element, the freeze snapshot canvas and the
 * intrinsic frame size here; detection and the overlay read them directly every frame
 * (no React state, no store writes).
 *
 * All overlays MUST map frame coords -> viewport pixels through getCoverMap()/frameToView(),
 * because the video is drawn with object-fit: cover (cropped, not stretched).
 */
import type { Box } from '../state/store';

function urlParam(name: string): string | null {
  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch {
    return null;
  }
}

const MOCK_RAW = urlParam('mock');

/**
 * `?mock=1` in the URL: no camera models, a fake laptop and a fake typing hand.
 * `?mock=gesture`: the fake laptop is analysed by itself and scripted hands turn it and pull it apart.
 * `?mock=eye`: a fake face in the middle of the view as well (#94).
 */
export const MOCK_MODE: boolean =
  MOCK_RAW === '1' ||
  MOCK_RAW === 'true' ||
  MOCK_RAW === 'laptop' ||
  MOCK_RAW === 'hand' ||
  MOCK_RAW === 'gesture' ||
  MOCK_RAW === 'eye';

/** `?mock=gesture`: scripted gesture hands instead of the typing hand (see detect/mockGesture.ts). */
export const MOCK_GESTURE: boolean = MOCK_RAW === 'gesture';

/** Which mock object sits in the centre of view (is "this"): `?mock=hand` the hand, `?mock=eye` a face's eye, else the laptop. */
export const MOCK_SCENE: 'laptop' | 'hand' | 'eye' = MOCK_RAW === 'hand' ? 'hand' : MOCK_RAW === 'eye' ? 'eye' : 'laptop';

/** true for `?name=1` or `?name=true`. */
export function urlFlag(name: string): boolean {
  const v = urlParam(name);
  return v === '1' || v === 'true';
}

/**
 * `?fit=even` (#98): each part model is scaled by one factor so it fits inside its slot, centred,
 * never stretched. Default (no param): the model is stretched to fill its slot's width and height.
 */
export const FIT_EVEN: boolean = urlParam('fit') === 'even';

/** Read a numeric URL param, e.g. `?press=0.6`, for live tuning without a rebuild. */
export function urlNumber(name: string, fallback: number): number {
  const raw = urlParam(name);
  if (raw === null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export interface FrameRuntime {
  video: HTMLVideoElement | null;
  /** Snapshot shown while store.frozen is true. */
  frozenCanvas: HTMLCanvasElement | null;
  /** true when frozenCanvas holds a real frame. */
  frozenValid: boolean;
  /** Intrinsic frame size in pixels; 0 until the video has metadata. */
  width: number;
  height: number;
}

export const frame: FrameRuntime = {
  video: null,
  frozenCanvas: null,
  frozenValid: false,
  width: 0,
  height: 0,
};

/** Frame size, falling back to 1280x720 (mock mode / camera not started yet). */
export function frameSize(): { w: number; h: number } {
  if (frame.width > 0 && frame.height > 0) return { w: frame.width, h: frame.height };
  return { w: 1280, h: 720 };
}

export function viewportSize(): { w: number; h: number } {
  return { w: Math.max(1, window.innerWidth), h: Math.max(1, window.innerHeight) };
}

export interface CoverMap {
  /** viewport px per frame px */
  scale: number;
  /** viewport px of the frame's top-left corner (negative when cropped) */
  ox: number;
  oy: number;
  fw: number;
  fh: number;
  vw: number;
  vh: number;
}

export function computeCoverMap(fw: number, fh: number, vw: number, vh: number): CoverMap {
  const scale = Math.max(vw / fw, vh / fh);
  return { scale, ox: (vw - fw * scale) / 2, oy: (vh - fh * scale) / 2, fw, fh, vw, vh };
}

/** Cover mapping for the current frame size and viewport. */
export function getCoverMap(): CoverMap {
  const f = frameSize();
  const v = viewportSize();
  return computeCoverMap(f.w, f.h, v.w, v.h);
}

/** Normalised frame coords (0..1) -> viewport CSS pixels. */
export function frameToView(m: CoverMap, nx: number, ny: number): { x: number; y: number } {
  return { x: m.ox + nx * m.fw * m.scale, y: m.oy + ny * m.fh * m.scale };
}

/** Viewport CSS pixels -> normalised frame coords (may be outside 0..1 where cropped). */
export function viewToFrame(m: CoverMap, px: number, py: number): { x: number; y: number } {
  return { x: (px - m.ox) / (m.fw * m.scale), y: (py - m.oy) / (m.fh * m.scale) };
}

/** Normalised frame box -> viewport pixel box (x, y = top-left). */
export function boxToView(m: CoverMap, b: Box): Box {
  const p = frameToView(m, b.x, b.y);
  return { x: p.x, y: p.y, w: b.w * m.fw * m.scale, h: b.h * m.fh * m.scale };
}

export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
