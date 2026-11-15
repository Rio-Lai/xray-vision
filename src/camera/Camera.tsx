/**
 * Camera: getUserMedia feed (not mirrored, object-fit: cover), freeze snapshot, and the
 * captureCrop() API registered in the store. The device picker only exists inside the hidden
 * debug panel (key D), at its top-left.
 * While a model floats on stage the live video keeps playing behind it, slightly dimmed and
 * blurred (CSS filter on the <video>: detection and captureCrop read raw frames, unaffected).
 * `?blur=0` keeps only the dim (if the blur ever costs frames); `?blur=6` blurs more.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChangeEvent, CSSProperties } from 'react';
import { useStore } from '../state/store';
import type { Box, CameraApi } from '../state/store';
import { errorText, frame, MOCK_MODE, urlNumber } from './frame';
import { setStatus, useHud } from '../hud/hudStore';
import { modelOnStage } from '../overlay/stageState';

const LS_KEY = 'xray.cameraDeviceId';

function readRemembered(): string | null {
  try {
    return window.localStorage.getItem(LS_KEY);
  } catch {
    return null;
  }
}

function remember(id: string): void {
  try {
    window.localStorage.setItem(LS_KEY, id);
  } catch {
    /* private mode: ignore */
  }
}

/** Lower is better: external USB cameras first, built-in / virtual / phone cameras last. */
function rankLabel(label: string): number {
  const l = label.toLowerCase();
  if (l.includes('facetime') || l.includes('built-in') || l.includes('integrated')) return 3;
  if (l.includes('desk view') || l.includes('iphone') || l.includes('continuity') || l.includes('virtual') || l.includes('obs')) return 2;
  return 0;
}

function pickDefault(devices: MediaDeviceInfo[]): string | null {
  if (devices.length === 0) return null;
  const sorted = [...devices].sort((a, b) => rankLabel(a.label) - rankLabel(b.label));
  return sorted[0].deviceId || null;
}

function openStream(deviceId: string | null): Promise<MediaStream> {
  const video: MediaTrackConstraints = {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30 },
  };
  if (deviceId) video.deviceId = { exact: deviceId };
  return navigator.mediaDevices.getUserMedia({ video, audio: false });
}

function stopStream(s: MediaStream | null): void {
  if (!s) return;
  for (const t of s.getTracks()) t.stop();
}

function errName(e: unknown): string {
  return e && typeof e === 'object' && 'name' in e ? String((e as { name: unknown }).name) : '';
}

function describeCameraError(e: unknown): string {
  switch (errName(e)) {
    case 'NotAllowedError':
      return 'Camera permission denied: allow the camera for localhost in Chrome (lock icon > Site settings) and reload';
    case 'NotFoundError':
      return 'No camera found: plug in the USB webcam and reload';
    case 'NotReadableError':
      return 'Camera busy: close other apps using it (Zoom, FaceTime, OBS) and reload';
    case 'OverconstrainedError':
      return 'Camera cannot do the requested mode';
    default:
      return `Camera error: ${errorText(e)}`;
  }
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** base64 JPEG (no data: prefix) of the box, padded 8%, max side 768 px; frozen snapshot if frozen. */
export function captureCrop(box: Box): string | null {
  const frozen = useStore.getState().frozen;
  let src: CanvasImageSource | null = null;
  let sw = 0;
  let sh = 0;
  const fc = frame.frozenCanvas;
  const v = frame.video;
  if (frozen && frame.frozenValid && fc && fc.width > 0) {
    src = fc;
    sw = fc.width;
    sh = fc.height;
  } else if (v && v.readyState >= 2 && v.videoWidth > 0) {
    src = v;
    sw = v.videoWidth;
    sh = v.videoHeight;
  }
  if (!src || sw <= 0 || sh <= 0) return null;
  const padX = box.w * 0.08;
  const padY = box.h * 0.08;
  const x0 = clamp01(box.x - padX);
  const y0 = clamp01(box.y - padY);
  const x1 = clamp01(box.x + box.w + padX);
  const y1 = clamp01(box.y + box.h + padY);
  const cx = Math.round(x0 * sw);
  const cy = Math.round(y0 * sh);
  const cw = Math.max(1, Math.round((x1 - x0) * sw));
  const ch = Math.max(1, Math.round((y1 - y0) * sh));
  const scale = Math.min(1, 768 / Math.max(cw, ch));
  const ow = Math.max(1, Math.round(cw * scale));
  const oh = Math.max(1, Math.round(ch * scale));
  const out = document.createElement('canvas');
  out.width = ow;
  out.height = oh;
  const ctx = out.getContext('2d');
  if (!ctx) return null;
  try {
    ctx.drawImage(src, cx, cy, cw, ch, 0, 0, ow, oh);
    const url = out.toDataURL('image/jpeg', 0.85);
    const i = url.indexOf(',');
    return i >= 0 ? url.slice(i + 1) : null;
  } catch {
    return null;
  }
}

/** Frozen frame behind an exploded object: dimmed and softly blurred so the parts read clearly. */
const BACKDROP_ON = 'brightness(0.6) saturate(0.85) blur(5px)';
const BACKDROP_OFF = 'brightness(1) saturate(1) blur(0px)';
/** Live video behind the floating model (stage mode): a light dim and blur, tuned for 30 fps. */
const LIVE_BLUR_PX = Math.min(12, Math.max(0, urlNumber('blur', 4)));
const LIVE_BACKDROP_ON = `brightness(0.62) saturate(0.85) blur(${LIVE_BLUR_PX}px)`;
/** #109: the live dim comes up over the model's ~1 s lift-out (src/overlay/liftOut.ts) and goes with its 0.6 s put-away. */
const LIVE_DIM_IN = 'filter 1000ms cubic-bezier(0.22, 0.8, 0.3, 1)';
const LIVE_DIM_OUT = 'filter 600ms ease-in-out';

const fill: CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  objectFit: 'cover',
};

export function Camera() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [requestedId, setRequestedId] = useState<string | null>(() => readRemembered());
  const frozen = useStore((s) => s.frozen);
  const held = useHud((s) => s.holdFrozen);
  const showSnapshot = frozen || held;
  const debug = useHud((s) => s.debug);
  const backdrop = useStore((s) => s.frozen && s.explodeAmount > 0 && s.teardown !== null && s.teardown.anchor !== 'hand');
  const liveBackdrop = useStore((s) => !s.frozen && modelOnStage(s));

  // Publish element refs to the frame runtime.
  useEffect(() => {
    frame.video = videoRef.current;
    frame.frozenCanvas = canvasRef.current;
    return () => {
      frame.video = null;
      frame.frozenCanvas = null;
      frame.frozenValid = false;
    };
  }, []);

  // Register captureCrop for the rest of the app.
  useEffect(() => {
    const api: CameraApi = { captureCrop };
    useStore.getState().registerCamera(api);
    return () => {
      if (useStore.getState().camera === api) useStore.getState().registerCamera(null);
    };
  }, []);

  // Open / switch the stream whenever the requested device changes.
  useEffect(() => {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      setStatus('camera', 'error', 'Camera API unavailable: open the app on http://localhost (not a LAN IP) in Chrome');
      return;
    }
    let cancelled = false;
    let stream: MediaStream | null = null;
    setStatus('camera', 'info', 'Starting camera...');
    void (async () => {
      try {
        try {
          stream = await openStream(requestedId);
        } catch (e) {
          const n = errName(e);
          if (requestedId && (n === 'OverconstrainedError' || n === 'NotFoundError' || n === 'NotReadableError')) {
            stream = await openStream(null);
          } else {
            throw e;
          }
        }
        if (cancelled) {
          stopStream(stream);
          stream = null;
          return;
        }
        const all = await navigator.mediaDevices.enumerateDevices();
        if (cancelled) {
          stopStream(stream);
          stream = null;
          return;
        }
        const vids = all.filter((d) => d.kind === 'videoinput');
        setDevices(vids);
        const track = stream.getVideoTracks()[0];
        const currentId = track ? track.getSettings().deviceId ?? null : null;
        if (!requestedId) {
          // Nothing remembered: prefer the first external camera (not FaceTime).
          const preferred = pickDefault(vids);
          if (preferred && currentId && preferred !== currentId) {
            stopStream(stream);
            stream = null;
            setRequestedId(preferred); // re-runs this effect with the external camera
            return;
          }
        }
        const v = videoRef.current;
        if (v) {
          v.srcObject = stream;
          v.play().catch(() => {
            /* autoplay with muted should not fail; ignore */
          });
        }
        setActiveId(currentId);
        const label = track?.label ?? 'camera';
        const settings = track?.getSettings();
        setStatus('camera', null);
        if (settings && settings.width && settings.width < 1000) {
          setStatus('camera', 'warn', `${label}: only ${settings.width}x${settings.height ?? '?'}`);
        }
      } catch (e) {
        if (!cancelled) setStatus('camera', MOCK_MODE ? 'warn' : 'error', describeCameraError(e));
      }
    })();
    return () => {
      cancelled = true;
      const v = videoRef.current;
      if (v && stream && v.srcObject === stream) v.srcObject = null;
      stopStream(stream);
      stream = null;
    };
  }, [requestedId]);

  // Keep the device list fresh when cameras are plugged in / out.
  useEffect(() => {
    const md = navigator.mediaDevices;
    if (!md || typeof md.addEventListener !== 'function') return;
    const onChange = () => {
      md.enumerateDevices()
        .then((all) => setDevices(all.filter((d) => d.kind === 'videoinput')))
        .catch(() => undefined);
    };
    md.addEventListener('devicechange', onChange);
    return () => md.removeEventListener('devicechange', onChange);
  }, []);

  // Freeze: snapshot the current frame before the browser paints the frozen state.
  useLayoutEffect(() => {
    const c = canvasRef.current;
    const v = videoRef.current;
    if (!c) return;
    if (frozen && v && v.readyState >= 2 && v.videoWidth > 0) {
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      const ctx = c.getContext('2d');
      if (ctx) {
        ctx.drawImage(v, 0, 0, c.width, c.height);
        frame.frozenValid = true;
      } else {
        frame.frozenValid = false;
      }
    } else {
      frame.frozenValid = false;
    }
  }, [frozen]);

  const onMeta = () => {
    const v = videoRef.current;
    if (v && v.videoWidth > 0) {
      frame.width = v.videoWidth;
      frame.height = v.videoHeight;
    }
  };

  const onPick = (e: ChangeEvent<HTMLSelectElement>) => {
    const id = e.target.value;
    if (!id) return;
    remember(id);
    setRequestedId(id);
  };

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        onLoadedMetadata={onMeta}
        style={{
          ...fill,
          visibility: showSnapshot ? 'hidden' : 'visible',
          // No zoom against the blur's soft edge: the live hand overlay must stay aligned with the video.
          filter: liveBackdrop ? LIVE_BACKDROP_ON : BACKDROP_OFF,
          transition: liveBackdrop ? LIVE_DIM_IN : LIVE_DIM_OUT,
        }}
      />
      <canvas
        ref={canvasRef}
        style={{
          ...fill,
          display: showSnapshot ? 'block' : 'none',
          filter: backdrop ? BACKDROP_ON : BACKDROP_OFF,
          // A 1.2% zoom hides the dark fringe the blur makes at the screen edges.
          transform: backdrop ? 'scale(1.012)' : 'scale(1)',
          transition: 'filter 500ms ease, transform 500ms ease',
        }}
      />
      {debug && devices.length > 0 && (
        <select
          data-xr-ui
          value={activeId ?? ''}
          onChange={onPick}
          title="Camera"
          style={{
            position: 'absolute',
            top: 16,
            left: 18,
            zIndex: 20,
            maxWidth: 260,
            font: '13px ui-monospace, SFMono-Regular, Menlo, monospace',
            color: '#e8e8e8',
            background: 'rgba(0,0,0,0.72)',
            border: '1px solid rgba(255,255,255,0.25)',
            borderRadius: 6,
            padding: '3px 6px',
            pointerEvents: 'auto',
          }}
        >
          {activeId === null && <option value="">camera...</option>}
          {devices.map((d, i) => (
            <option key={d.deviceId || `cam-${i}`} value={d.deviceId}>
              {d.label || `Camera ${i + 1}`}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

export default Camera;
