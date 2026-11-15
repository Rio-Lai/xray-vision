/**
 * The big-screen view (`?watch=1`; `npm run phone` opens http://localhost:8791/?watch=1 on the Mac for the
 * projector). A passive copy of what the phone shows in the glasses: the phone's camera picture (MJPEG,
 * GET /api/watch/stream) with the same overlay, HUD, captions and voice pill drawn on top from the phone's
 * state (./follow.ts), laid out for this screen. App.tsx renders this instead of the laptop tree only with
 * the flag.
 *  - No camera, no MediaPipe, no voice session, no gestures, no keys of the stage, no API call that spends
 *    credit, nothing saved: the animation loop only ticks the overlay; the state comes from the phone.
 *  - The same Overlay (box rig, arm, eye, solids, labels, hand markers), DetailStage (`?detail=1`) and Hud
 *    as the app; its own copy of the captions and the voice pill (src/voice/VoiceBar.tsx's hooks, no session).
 *  - One quiet line while the phone is not there ("Waiting for the phone...", "Phone connection lost,
 *    reconnecting..."). No controls: a click or F makes the page full screen (F again or Esc leaves it); a
 *    layer over everything takes every click, so nothing underneath can be pressed. The pointer hides when still.
 *  - `?mjpeg=0`: the picture is fetched one JPEG at a time (GET /api/watch/frame) instead of the MJPEG stream.
 */
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useStore } from '../state/store';
import { computeCoverMap, errorText, urlParam, viewportSize } from '../camera/frame';
import { BACKDROP_OFF, BACKDROP_ON, LIVE_BACKDROP_ON, LIVE_DIM_IN, LIVE_DIM_OUT } from '../camera/Camera';
import { live } from '../detect/live';
import { Overlay } from '../overlay/Overlay';
import type { OverlayHandle } from '../overlay/Overlay';
import { modelOnStage } from '../overlay/stageState';
import { DetailStage } from '../overlay/DetailStage';
import { DETAIL_ON } from '../lib/detail';
import { Hud } from '../hud/Hud';
import { setStatus, useHud } from '../hud/hudStore';
import { PILL_TEXT, useCaptions, useThinking } from '../voice/VoiceBar';
import type { PillState } from '../voice/VoiceBar';
import { VOICE_CSS } from '../voice/voiceStyles';
import { reconnectStream, startFollower, useWatch } from './follow';

const MJPEG = urlParam('mjpeg') !== '0';
/** `?mjpeg=0`: the next single frame this long after one loaded (or after a miss). */
const POLL_MS = 60;
const POLL_RETRY_MS = 500;
/** The pointer hides after this long without moving. */
const POINTER_IDLE_MS = 2000;

function useViewport(): { w: number; h: number } {
  const [v, setV] = useState(viewportSize);
  useEffect(() => {
    const on = () => setV(viewportSize());
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return v;
}

/**
 * The phone's picture, placed by the cover map of the PHONE's frame size (the one the overlay maps with),
 * dimmed and blurred as the phone's Camera.tsx does behind a model (the frames come unfiltered).
 */
function WatchPicture() {
  const fw = useWatch((s) => s.fw);
  const fh = useWatch((s) => s.fh);
  const streamKey = useWatch((s) => s.streamKey);
  const view = useViewport();
  const frozen = useStore((s) => s.frozen);
  const held = useHud((s) => s.holdFrozen);
  const backdrop = useStore((s) => s.frozen && s.explodeAmount > 0 && s.teardown !== null && s.teardown.anchor !== 'hand');
  const liveBackdrop = useStore((s) => !s.frozen && modelOnStage(s));
  const [poll, setPoll] = useState(0);
  const retryRef = useRef(0);

  useEffect(() => () => window.clearTimeout(retryRef.current), []);

  const m = computeCoverMap(Math.max(1, fw), Math.max(1, fh), view.w, view.h);
  const still = frozen || held;
  const style: CSSProperties = {
    position: 'absolute',
    left: m.ox,
    top: m.oy,
    width: m.fw * m.scale,
    height: m.fh * m.scale,
    objectFit: 'fill',
    filter: still ? (backdrop ? BACKDROP_ON : BACKDROP_OFF) : liveBackdrop ? LIVE_BACKDROP_ON : BACKDROP_OFF,
    transform: still && backdrop ? 'scale(1.012)' : 'scale(1)',
    transition: still ? 'filter 500ms ease, transform 500ms ease' : liveBackdrop ? LIVE_DIM_IN : LIVE_DIM_OUT,
  };
  const later = (ms: number, fn: () => void) => {
    window.clearTimeout(retryRef.current);
    retryRef.current = window.setTimeout(fn, ms);
  };
  if (MJPEG) {
    return (
      <img
        key={streamKey}
        src={`/api/watch/stream?k=${streamKey}`}
        alt=""
        draggable={false}
        style={style}
        // the stream ended or never started (server restarting): try again in a moment
        onError={() => later(1000, reconnectStream)}
      />
    );
  }
  return (
    <img
      src={`/api/watch/frame?n=${poll}`}
      alt=""
      draggable={false}
      style={style}
      onLoad={() => later(POLL_MS, () => setPoll((n) => n + 1))}
      onError={() => later(POLL_RETRY_MS, () => setPoll((n) => n + 1))}
    />
  );
}

/** The voice pill and captions as the phone shows them (no session here: the state is the phone's). */
function WatchVoice() {
  const voiceStatus = useStore((s) => s.voiceStatus);
  const speaking = useStore((s) => s.agentSpeaking);
  const micHold = useWatch((s) => s.micHold);
  const captions = useCaptions();
  const connected = voiceStatus === 'connected';
  const thinking = useThinking(connected, speaking);
  const state: PillState = connected
    ? speaking
      ? 'speaking'
      : thinking
        ? 'thinking'
        : micHold
          ? 'hold'
          : 'listening'
    : voiceStatus === 'connecting'
      ? 'connecting'
      : 'off';
  return (
    <div className="bf-voice">
      <style>{VOICE_CSS}</style>
      {captions.length > 0 && (
        <div className="bf-vcaps" aria-live="polite">
          {captions.map((c) => (
            <div key={c.id} className={`bf-vcap ${c.role}${c.fading ? ' fading' : ''}`}>
              {c.text}
            </div>
          ))}
        </div>
      )}
      <div className={`bf-vpill bf-vglass ${state}`}>
        <span className="bf-vicon" aria-hidden="true">
          {state === 'speaking' ? (
            <>
              <span className="bf-vbar" />
              <span className="bf-vbar" />
              <span className="bf-vbar" />
              <span className="bf-vbar" />
              <span className="bf-vbar" />
            </>
          ) : state === 'thinking' ? (
            <>
              <span className="bf-vthink" />
              <span className="bf-vthink" />
              <span className="bf-vthink" />
            </>
          ) : (
            <span className="bf-vdot" />
          )}
        </span>
        {PILL_TEXT[state]}
      </div>
    </div>
  );
}

const STATUS_STYLE: CSSProperties = {
  position: 'fixed',
  top: 14,
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 90,
  padding: '5px 14px',
  borderRadius: 999,
  font: '500 14px/1.3 system-ui, -apple-system, "SF Pro Text", sans-serif',
  color: 'rgba(255, 255, 255, 0.78)',
  background: 'rgba(16, 19, 24, 0.66)',
  border: '1px solid rgba(255, 255, 255, 0.16)',
  pointerEvents: 'none',
  whiteSpace: 'nowrap',
};

function WatchStatus() {
  const link = useWatch((s) => s.link);
  if (link === 'live') return null;
  return <div style={STATUS_STYLE}>{link === 'waiting' ? 'Waiting for the phone...' : 'Phone connection lost, reconnecting...'}</div>;
}

function enterFullscreen(): void {
  const el = document.documentElement;
  if (document.fullscreenElement || typeof el.requestFullscreen !== 'function') return;
  el.requestFullscreen().catch(() => undefined);
}

function toggleFullscreen(): void {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
  else enterFullscreen();
}

/** Over everything: takes every click (full screen) so nothing underneath can be pressed; hides a still pointer. */
function ClickLayer() {
  const [pointer, setPointer] = useState(true);
  const timer = useRef(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        toggleFullscreen();
      }
    };
    window.addEventListener('keydown', onKey);
    timer.current = window.setTimeout(() => setPointer(false), POINTER_IDLE_MS);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.clearTimeout(timer.current);
    };
  }, []);
  const onMove = () => {
    setPointer(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setPointer(false), POINTER_IDLE_MS);
  };
  return (
    <div
      onClick={enterFullscreen}
      onPointerMove={onMove}
      onContextMenu={(e) => e.preventDefault()}
      onWheel={(e) => e.stopPropagation()}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, cursor: pointer ? 'pointer' : 'none' }}
    />
  );
}

/** The stage: the phone's picture, the overlay, the detail model, the HUD and the voice zone; one animation loop. */
function WatchStage() {
  const overlayRef = useRef<OverlayHandle>(null);

  useEffect(() => {
    const stop = startFollower();
    let raf = 0;
    let alive = true;
    let frames = 0;
    let fpsStart = performance.now();
    const loop = (now: number) => {
      if (!alive) return;
      raf = requestAnimationFrame(loop);
      // No detection, no gestures, no model control: the store and `live` come from the phone (follow.ts).
      try {
        overlayRef.current?.tick(now);
      } catch (e) {
        setStatus('loop-overlay', 'error', `Overlay error: ${errorText(e)}`);
      }
      frames += 1;
      if (now - fpsStart >= 500) {
        live.stats.renderFps = (frames * 1000) / (now - fpsStart);
        frames = 0;
        fpsStart = now;
      }
    };
    raf = requestAnimationFrame(loop);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      stop();
    };
  }, []);

  return (
    <div style={{ position: 'fixed', inset: 0, overflow: 'hidden', zIndex: 0, background: '#000', userSelect: 'none' }}>
      <WatchPicture />
      <Overlay ref={overlayRef} />
      {DETAIL_ON && <DetailStage />}
      <Hud />
      <WatchVoice />
    </div>
  );
}

export function WatchApp() {
  useEffect(() => {
    document.title = 'Blowfish: big screen';
    document.documentElement.style.background = '#000';
  }, []);
  return (
    <>
      <WatchStage />
      <WatchStatus />
      <ClickLayer />
    </>
  );
}

export default WatchApp;
