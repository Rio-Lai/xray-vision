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

/** `?mock=1` in the URL: no MediaPipe, fake laptop + hand. */
export const MOCK_MODE: boolean = (() => {
  try {
    const v = new URLSearchParams(window.location.search).get('mock');
    return v === '1' || v === 'true';
  } catch {
    return false;
  }
})();

/** Read a numeric URL param, e.g. `?press=0.6`, for live tuning without a rebuild. */
export function urlNumber(name: string, fallback: number): number {
  try {
    const raw = new URLSearchParams(window.location.search).get(name);
    if (raw === null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
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
