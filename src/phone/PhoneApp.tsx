/**
 * Phone mode (`?phone=1`, `npm run phone`): Blowfish on an iPhone 16 held sideways (about 852 x 393
 * CSS px), its screen mirrored as is to the XREAL glasses over USB-C. App.tsx renders this instead of
 * the laptop tree only with the flag; without it nothing here runs.
 *  - "Tap to start": iOS wants a tap before audio may play. The tap unlocks audio, asks for the camera
 *    and microphone once (one Safari prompt), then mounts the stage (back camera, Camera.tsx) and
 *    starts the voice session (the same start as the V key).
 *  - A column of glass buttons on the right for the hidden keys: Voice (V), Analyse (A), Explode (E),
 *    Put away (R) and a tiny Debug (D), calling the same functions.
 *  - No page scroll, pinch-zoom, rubber-banding, long-press callout or text selection; the stage's
 *    pointer handlers get touches unchanged (touch-action: none). Safe-area insets, smaller HUD
 *    sizes for the small screen, and a hint while the phone is held upright.
 *  - The screen stays awake (Wake Lock), and the Mac is asked every 20 s whether it is still there,
 *    so a sleeping or stopped Mac shows as one sentence (there is no console on a phone).
 * The noise gate is off (voiceGate.ts), the microphone is the default one (pushToTalk.ts), the object
 * detector is Lite0 (mediapipe.ts) and canvases draw at most 1.25 device px per CSS px (frame.ts).
 */
import { useEffect, useState } from 'react';
import { VoiceProvider } from '../voice/VoiceProvider';
import { VoiceBar } from '../voice/VoiceBar';
import { Stage, runExplode } from '../stage/Stage';
import { useStore } from '../state/store';
import { resetAll } from '../lib/flow';
import { api } from '../lib/api';
import { modelControl, STAGE_MIN_EXPLODE } from '../stage/modelControl';
import { setStatus, showToast, toggleDebug, useHud } from '../hud/hudStore';
import { phoneVoice } from './phoneVoice';

const VIEWPORT = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';
const HEALTH_EVERY_MS = 20_000;
const SERVER_GONE =
  'Cannot reach the Mac: check that "npm run phone" is still running there and that the Mac is awake and online, then reload.';

/** Safari's own pinch-zoom and two-finger page moves (iOS ignores user-scalable=no). */
function blockPageZoom(): () => void {
  const stop = (e: Event) => e.preventDefault();
  const multiTouch = (e: TouchEvent) => {
    if (e.touches.length > 1) e.preventDefault();
  };
  document.addEventListener('gesturestart', stop, { passive: false });
  document.addEventListener('gesturechange', stop, { passive: false });
  document.addEventListener('touchmove', multiTouch, { passive: false });
  return () => {
    document.removeEventListener('gesturestart', stop);
    document.removeEventListener('gesturechange', stop);
    document.removeEventListener('touchmove', multiTouch);
  };
}

/** iOS starts audio only from a tap: play one silent sample inside it. */
function unlockAudio(): void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const src = ctx.createBufferSource();
    src.buffer = ctx.createBuffer(1, 1, 22050);
    src.connect(ctx.destination);
    src.start(0);
    void ctx.resume().catch(() => undefined);
    window.setTimeout(() => void ctx.close().catch(() => undefined), 1500);
  } catch {
    /* no audio: voice will say so */
  }
}

/** One Safari prompt for both, so the camera and the voice session do not ask one after the other. */
async function askCameraAndMic(): Promise<boolean> {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: true });
    s.getTracks().forEach((t) => t.stop());
    return true;
  } catch {
    return false;
  }
}

interface WakeLockSentinelLike {
  release: () => Promise<void>;
}
interface WakeLockLike {
  request: (type: 'screen') => Promise<WakeLockSentinelLike>;
}

/** Keep the screen on while the page is visible (the lock goes whenever the page is hidden). */
function useWakeLock(on: boolean): void {
  useEffect(() => {
    if (!on) return;
    const wl = (navigator as unknown as { wakeLock?: WakeLockLike }).wakeLock;
    if (!wl) return;
    let lock: WakeLockSentinelLike | null = null;
    let alive = true;
    const ask = () => {
      if (document.visibilityState !== 'visible') return;
      wl.request('screen').then(
        (l) => {
          if (alive) lock = l;
          else void l.release().catch(() => undefined);
        },
        () => undefined,
      );
    };
    ask();
    document.addEventListener('visibilitychange', ask);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', ask);
      void lock?.release().catch(() => undefined);
    };
  }, [on]);
}

/** Is the Mac still answering? One sentence on screen while it is not. */
function useServerCheck(on: boolean): void {
  useEffect(() => {
    if (!on) return;
    let alive = true;
    const check = () => {
      api.health().then(
        () => alive && setStatus('phone-server', null),
        () => alive && setStatus('phone-server', 'error', SERVER_GONE),
      );
    };
    check();
    const id = window.setInterval(check, HEALTH_EVERY_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [on]);
}

function StartScreen({ onStart }: { onStart: () => void }) {
  const [busy, setBusy] = useState(false);
  const onTap = () => {
    if (busy) return;
    setBusy(true);
    unlockAudio();
    void askCameraAndMic().then((ok) => {
      if (!ok) {
        showToast('Camera or microphone blocked: in Safari tap aA > Website Settings, allow both, then reload.', 'error', 10_000);
      }
      onStart();
      // the voice session a moment after the camera, so the two never ask at the same time
      window.setTimeout(() => phoneVoice.start(), 700);
    });
  };
  return (
    <button type="button" className="bf-phone-start" data-xr-ui onClick={onTap}>
      <span className="bf-phone-start__title">Blowfish</span>
      <span className="bf-phone-start__tap">{busy ? 'Starting…' : 'Tap to start'}</span>
      <span className="bf-phone-start__note">Allow the camera and microphone when Safari asks. Hold the phone sideways.</span>
    </button>
  );
}

/** The same as the R key. */
function putAway(): void {
  modelControl.stop();
  resetAll();
  showToast('Reset', 'info', 1200);
}

function PhoneControls() {
  const voice = useStore((s) => s.voiceStatus);
  const debug = useHud((s) => s.debug);
  const voiceText = voice === 'connected' ? 'Voice on' : voice === 'connecting' ? 'Voice…' : 'Voice off';
  return (
    <div className="bf-phone-controls" data-xr-ui>
      <button type="button" className={`bf-phone-btn${voice === 'connected' ? ' on' : ''}`} onClick={() => phoneVoice.toggle()}>
        {voiceText}
      </button>
      <button type="button" className="bf-phone-btn" onClick={() => runExplode(STAGE_MIN_EXPLODE)}>
        Analyse
      </button>
      <button type="button" className="bf-phone-btn" onClick={() => runExplode()}>
        Explode
      </button>
      <button type="button" className="bf-phone-btn" onClick={putAway}>
        Put away
      </button>
      <button type="button" className={`bf-phone-btn bf-phone-btn--tiny${debug ? ' on' : ''}`} onClick={toggleDebug} aria-label="Debug panel">
        D
      </button>
    </div>
  );
}

export function PhoneApp() {
  const [started, setStarted] = useState(false);

  useEffect(() => {
    document.documentElement.classList.add('bf-phone');
    const meta = document.querySelector('meta[name="viewport"]');
    if (meta) meta.setAttribute('content', VIEWPORT);
    return blockPageZoom();
  }, []);
  useWakeLock(started);
  useServerCheck(started);

  return (
    <VoiceProvider>
      <style>{PHONE_CSS}</style>
      <div style={{ position: 'fixed', inset: 0 }}>{started && <Stage />}</div>
      <VoiceBar />
      {started ? <PhoneControls /> : <StartScreen onStart={() => setStarted(true)} />}
      <div className="bf-phone-rotate" aria-hidden="true">
        Turn the phone sideways
      </div>
    </VoiceProvider>
  );
}

/**
 * Phone-only styles. `html.bf-phone` outranks the kit's `:root` tokens (src/hud/kit/tokens.ts), so the
 * HUD and the voice bar get smaller sizes here without any change to their own stylesheets.
 */
const PHONE_CSS = `
html.bf-phone, html.bf-phone body { position: fixed; inset: 0; overscroll-behavior: none; touch-action: none;
  -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent;
  -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
html.bf-phone #root, html.bf-phone #root * { touch-action: none; -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; }

html.bf-phone {
  --bf-edge: 12px;
  --bf-font-size-label: 14px; --bf-font-size-body: 14px; --bf-font-size-title: 15px; --bf-font-size-card-name: 17px;
  --bf-font-size-kicker: 12px; --bf-font-size-caption: 14px; --bf-font-size-caption-reply: 15px;
  --bf-font-size-error: 14px; --bf-font-size-safety: 13px;
  --bf-size-pill-height: 32px; --bf-size-voice-pill-min: 104px; --bf-size-voice-zone-width: 520px;
  --bf-size-caption-max: 440px; --bf-size-error-max: 520px;
  --bf-size-card-width: 300px; --bf-size-step-width: 280px; --bf-size-card-max-vw: 32vw; --bf-size-step-max-vw: 30vw;
  --bf-size-card-min: 200px;
  --bf-size-voice-bottom: max(8px, env(safe-area-inset-bottom));
  --bf-size-status-offset: calc(64px + env(safe-area-inset-bottom));
  --bf-phone-left: max(12px, env(safe-area-inset-left));
  --bf-phone-right: max(10px, env(safe-area-inset-right));
  --bf-phone-top: max(8px, env(safe-area-inset-top));
  --bf-phone-bottom: max(10px, env(safe-area-inset-bottom));
  --bf-phone-column: 64px;
}
html.bf-phone .bf-card { padding: 12px 14px; border-radius: 16px; overflow: hidden;
  max-height: calc(100vh - 2 * var(--bf-phone-top) - 8px); max-height: calc(100dvh - 2 * var(--bf-phone-top) - 8px); }
html.bf-phone .bf-card__name { margin-bottom: 6px; }
html.bf-phone .bf-card__safety { margin-top: 8px; padding-top: 8px; gap: 8px; }
html.bf-phone .bf-progress { margin: 6px 0 8px; }
html.bf-phone .bf-part-card { left: var(--bf-phone-left); bottom: var(--bf-phone-bottom); }
/* the step card stays clear of the button column on the right */
html.bf-phone .bf-step-card { right: calc(var(--bf-phone-right) + var(--bf-phone-column)); bottom: var(--bf-phone-bottom); }
html.bf-phone .bf-title-pill { top: var(--bf-phone-top); padding: 4px 12px; }
html.bf-phone .bf-saved { top: var(--bf-phone-top); left: var(--bf-phone-left); }
html.bf-phone .bf-vpill { padding: 4px 12px; }
html.bf-phone .bf-debug { font-size: 9px !important; }

/* ---- Tap to start ---- */
.bf-phone-start { position: fixed; inset: 0; z-index: 200; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 10px; margin: 0; padding: 24px; border: 0; background: #000; color: #fff; cursor: pointer; text-align: center;
  font-family: system-ui, -apple-system, "SF Pro Text", sans-serif; -webkit-font-smoothing: antialiased; }
.bf-phone-start__title { font-size: 15px; letter-spacing: 0.08em; text-transform: uppercase; color: rgba(255, 255, 255, 0.62); }
.bf-phone-start__tap { padding: 14px 28px; border-radius: 999px; font-size: 22px; font-weight: 600;
  background: rgba(22, 25, 30, 0.8); border: 1px solid rgba(77, 163, 255, 0.7); box-shadow: 0 0 0 6px rgba(77, 163, 255, 0.16); }
.bf-phone-start__note { max-width: 420px; font-size: 13px; line-height: 1.4; color: rgba(255, 255, 255, 0.62); }

/* ---- the buttons for the hidden keys: a column on the right ---- */
.bf-phone-controls { position: fixed; z-index: 60; top: var(--bf-phone-top); right: var(--bf-phone-right); width: var(--bf-phone-column);
  display: flex; flex-direction: column; align-items: stretch; gap: 6px; pointer-events: none; }
.bf-phone-btn { pointer-events: auto; box-sizing: border-box; min-height: 40px; margin: 0; padding: 4px 4px; border-radius: 14px;
  font: 500 12px/1.1 system-ui, -apple-system, "SF Pro Text", sans-serif; color: rgba(255, 255, 255, 0.92); cursor: pointer;
  background: rgba(22, 25, 30, 0.58); border: 1px solid rgba(255, 255, 255, 0.22); box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
  -webkit-backdrop-filter: blur(18px) saturate(135%); backdrop-filter: blur(18px) saturate(135%); }
.bf-phone-btn:active { background: rgba(77, 163, 255, 0.35); }
.bf-phone-btn.on { border-color: #4da3ff; color: #fff; }
.bf-phone-btn--tiny { align-self: flex-end; width: 30px; min-height: 26px; padding: 0; border-radius: 9px; font-size: 11px; opacity: 0.6; }

/* ---- held upright: a hint instead of a squashed layout ---- */
.bf-phone-rotate { display: none; }
@media (orientation: portrait) {
  .bf-phone-rotate { position: fixed; z-index: 210; left: 50%; top: 50%; transform: translate(-50%, -50%); display: block;
    padding: 12px 20px; border-radius: 999px; pointer-events: none; white-space: nowrap;
    font: 600 17px/1.2 system-ui, -apple-system, "SF Pro Text", sans-serif; color: #fff;
    background: rgba(16, 19, 24, 0.86); border: 1px solid rgba(255, 255, 255, 0.22); }
}
`;
