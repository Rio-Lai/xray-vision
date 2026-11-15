/**
 * Phone mode (`?phone=1`, `npm run phone`): Blowfish on an iPhone 16 held sideways (852 x 393 points),
 * its screen mirrored as is to the XREAL glasses over USB-C (and from there to a projector). App.tsx
 * renders this instead of the laptop tree only with the flag; without it nothing here runs.
 *  - The laptop's layout, scaled: the page is laid out 1400 CSS px wide (`?vw=`) and the phone scales it
 *    to its screen (viewport.ts), about 1400 x 646 sideways. The HUD sizes below are in those CSS px,
 *    tightened for the short view so the model is the biggest thing on screen; the phone's own controls
 *    are sized in real points (--bf-pt) so they stay easy to tap.
 *  - "Tap to start": iOS wants a tap before audio may play. The tap unlocks audio, asks for the camera
 *    and microphone once (one Safari prompt), then mounts the stage (back camera, Camera.tsx) and
 *    starts the voice session (the same start as the V key). It also offers full screen where the
 *    browser can (fullscreen.ts), and on an iPhone says how to get it instead.
 *  - A quiet settings gear at the top right opens a small sheet: the debug panel (D), full screen, and
 *    a fallback for the hidden keys in case voice fails: Voice (V), Analyse (A), Explode (E), Put away (R).
 *  - No page scroll, pinch-zoom, rubber-banding, long-press callout or text selection; the stage's
 *    pointer handlers get touches unchanged (touch-action: none). Safe-area insets (the Dynamic Island,
 *    the home bar) and a hint while the phone is held upright (the page is never turned with CSS: the
 *    glasses mirror the real screen).
 *  - The screen stays awake (Wake Lock), and the Mac is asked every 20 s whether it is still there,
 *    so a sleeping or stopped Mac shows as one sentence (there is no console on a phone).
 * The noise gate is off (voiceGate.ts), the microphone is the default one (pushToTalk.ts), the object
 * detector is Lite0 (mediapipe.ts) and canvases draw at most 1.25 device px per screen point (frame.ts).
 */
import { useEffect, useState } from 'react';
import { VoiceProvider } from '../voice/VoiceProvider';
import { VoiceBar } from '../voice/VoiceBar';
import { Stage, runExplode } from '../stage/Stage';
import { useStore } from '../state/store';
import { resetAll } from '../lib/flow';
import { api } from '../lib/api';
import { PHONE_VIEWPORT, applyPhoneViewport } from './viewport';
import { enterFullscreen, fullscreenSupported, isStandalone, useFullscreenButton } from './fullscreen';
import { modelControl, STAGE_MIN_EXPLODE } from '../stage/modelControl';
import { setStatus, showToast, toggleDebug, useHud } from '../hud/hudStore';
import { phoneVoice } from './phoneVoice';

const VIEWPORT = PHONE_VIEWPORT;
// before the first render: the page width and --bf-pt (does nothing without ?phone=1)
applyPhoneViewport();

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
  const showFullscreen = useFullscreenButton();
  // iPhone: no full-screen API, so say how to get the same (the first line not once it runs from the icon)
  const iphoneHints = !fullscreenSupported();
  return (
    <div className="bf-phone-start" role="button" tabIndex={0} data-xr-ui onClick={onTap}>
      <span className="bf-phone-start__title">Blowfish</span>
      <span className="bf-phone-start__tap">{busy ? 'Starting…' : 'Tap to start'}</span>
      <span className="bf-phone-start__note">Allow the camera and microphone when Safari asks. Hold the phone sideways.</span>
      {showFullscreen && (
        <button
          type="button"
          className="bf-phone-start__fs"
          onClick={(e) => {
            e.stopPropagation();
            void enterFullscreen();
          }}
        >
          Full screen
        </button>
      )}
      {iphoneHints && (
        <span className="bf-phone-start__hints">
          {!isStandalone() && <span>Full screen: Share, then Add to Home Screen, and open Blowfish from the icon.</span>}
          <span>Keep it sideways: turn on Portrait Orientation Lock, then AssistiveTouch (Settings &gt; Accessibility &gt; Touch) &gt; Device &gt; Rotate Screen.</span>
        </span>
      )}
    </div>
  );
}

/** The same as the R key. */
function putAway(): void {
  modelControl.stop();
  resetAll();
  showToast('Reset', 'info', 1200);
}

/** An eight-tooth gear outline in a 24 x 24 box (drawn once, at load). */
const GEAR_PATH = (() => {
  const teeth = 8;
  const step = (2 * Math.PI) / teeth;
  const pts: string[] = [];
  for (let i = 0; i < teeth; i++) {
    const c = i * step;
    const corners: [number, number][] = [
      [8, c - step * 0.3],
      [10.6, c - step * 0.16],
      [10.6, c + step * 0.16],
      [8, c + step * 0.3],
    ];
    for (const [r, a] of corners) pts.push(`${(12 + r * Math.cos(a)).toFixed(2)} ${(12 + r * Math.sin(a)).toFixed(2)}`);
  }
  return `M${pts.join('L')}Z`;
})();

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true">
      <path d={GEAR_PATH} />
      <circle cx="12" cy="12" r="3.3" />
    </svg>
  );
}

/**
 * The settings gear (top right, inside the safe area) and its sheet: the debug panel, full screen where the
 * browser has it, and the hidden keys as buttons in case voice fails on stage. Every button closes the sheet;
 * so does a tap outside it.
 */
function PhoneControls() {
  const [open, setOpen] = useState(false);
  const voice = useStore((s) => s.voiceStatus);
  const debug = useHud((s) => s.debug);
  const showFullscreen = useFullscreenButton();
  const voiceText = voice === 'connected' ? 'Voice on' : voice === 'connecting' ? 'Voice…' : 'Voice off';
  const act = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  if (!open) {
    return (
      <button type="button" className="bf-phone-gear" data-xr-ui aria-label="Settings" onClick={() => setOpen(true)}>
        <GearIcon />
      </button>
    );
  }
  return (
    <>
      <div className="bf-ps-backdrop" data-xr-ui onClick={() => setOpen(false)} />
      <section className="bf-ps" data-xr-ui role="dialog" aria-label="Settings">
        <div className="bf-ps__head">
          <span className="bf-ps__title">Settings</span>
          <button type="button" className="bf-ps__btn bf-ps__close" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
        <div className="bf-ps__row">
          <button
            type="button"
            className={`bf-ps__btn${debug ? ' on' : ''}${showFullscreen ? '' : ' bf-ps__btn--wide'}`}
            onClick={act(toggleDebug)}
          >
            Debug panel {debug ? 'on' : 'off'}
          </button>
          {showFullscreen && (
            <button type="button" className="bf-ps__btn" onClick={act(() => void enterFullscreen())}>
              Full screen
            </button>
          )}
        </div>
        <p className="bf-ps__label">If voice fails</p>
        <div className="bf-ps__row">
          <button type="button" className={`bf-ps__btn${voice === 'connected' ? ' on' : ''}`} onClick={act(() => phoneVoice.toggle())}>
            {voiceText}
          </button>
          <button type="button" className="bf-ps__btn" onClick={act(() => runExplode(STAGE_MIN_EXPLODE))}>
            Analyse
          </button>
          <button type="button" className="bf-ps__btn" onClick={act(() => runExplode())}>
            Explode
          </button>
          <button type="button" className="bf-ps__btn" onClick={act(putAway)}>
            Put away
          </button>
        </div>
      </section>
    </>
  );
}

export function PhoneApp() {
  const [started, setStarted] = useState(false);

  useEffect(() => {
    document.documentElement.classList.add('bf-phone');
    const meta = document.querySelector('meta[name="viewport"]');
    if (meta && meta.getAttribute('content') !== VIEWPORT) meta.setAttribute('content', VIEWPORT);
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

/** n real screen points, in CSS px (--bf-pt, viewport.ts): the phone's own controls stay this size on the glass. */
const pt = (n: number): string => `calc(${n} * var(--bf-pt))`;
/**
 * One side of the safe area: env(), but at least the iPhone's own sideways inset (`floor` points) wherever the
 * phone reports any, in case iOS gives env() in screen points rather than in the scaled page's CSS px.
 */
const safe = (side: 'left' | 'right' | 'top' | 'bottom', floor: number): string =>
  `max(env(safe-area-inset-${side}, 0px), min(calc(env(safe-area-inset-${side}, 0px) * 1000), ${pt(floor)}))`;
const FONT = 'system-ui, -apple-system, "SF Pro Text", sans-serif';

/**
 * Phone-only styles. `html.bf-phone` outranks the kit's `:root` tokens (src/hud/kit/tokens.ts), so the
 * HUD and the voice bar get other sizes here without any change to their own stylesheets.
 * The HUD numbers are CSS px of the scaled page (about 1400 x 646 sideways, 0.61 points each): the
 * laptop's layout with smaller cards, short captions and a small title, so the model is the biggest
 * thing on screen (its stage margins: src/overlay/boxRig.ts, PHONE_MODE). The phone's own controls (start
 * screen, gear, settings sheet, rotate hint) are in real points (pt()). Safe area (sideways: the Dynamic
 * Island on the left or the right, the home bar at the bottom): --bf-phone-left / right / top / bottom.
 */
const PHONE_CSS = `
html.bf-phone, html.bf-phone body { position: fixed; inset: 0; overscroll-behavior: none; touch-action: none;
  -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent;
  -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
html.bf-phone #root, html.bf-phone #root * { touch-action: none; -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; }
/* the debug panel's tuning column scrolls with one finger */
html.bf-phone #root .bf-tuning-col, html.bf-phone #root .bf-tuning-col * { touch-action: pan-y; }

html.bf-phone {
  --bf-pt: 1px;
  --bf-safe-left: ${safe('left', 59)};
  --bf-safe-right: ${safe('right', 59)};
  --bf-safe-top: ${safe('top', 59)};
  --bf-safe-bottom: ${safe('bottom', 21)};
  --bf-phone-left: max(16px, var(--bf-safe-left));
  --bf-phone-right: max(16px, var(--bf-safe-right));
  --bf-phone-top: max(10px, var(--bf-safe-top));
  --bf-phone-bottom: max(10px, var(--bf-safe-bottom));
  /* the gear's square (44 points), which the detail card keeps clear of (DetailStage.tsx) */
  --bf-phone-gear: ${pt(44)};
  --bf-edge: 16px;
  --bf-font-size-label: 15px; --bf-font-size-body: 15px; --bf-font-size-title: 17px; --bf-font-size-card-name: 18px;
  --bf-font-size-kicker: 13px; --bf-font-size-caption: 16px; --bf-font-size-caption-reply: 18px;
  --bf-font-size-error: 15px; --bf-font-size-safety: 14px;
  --bf-size-pill-height: 32px; --bf-size-icon: 16px; --bf-size-voice-pill-min: 120px; --bf-size-voice-zone-width: 600px;
  --bf-size-caption-max: 560px; --bf-size-error-max: 600px;
  --bf-size-card-width: 300px; --bf-size-step-width: 280px; --bf-size-card-max-vw: 24vw; --bf-size-step-max-vw: 22vw;
  --bf-size-card-min: 220px;
  --bf-size-voice-bottom: var(--bf-phone-bottom);
}

/* ---- the HUD at the scaled size ---- */
html.bf-phone .bf-title-pill { top: var(--bf-phone-top); padding: 4px 14px; }
html.bf-phone .bf-title-pill__chip { padding: 2px 8px; }
/* the one status pill: under the title, so the bottom keeps only the voice pill and the captions */
html.bf-phone .bf-status-pill { top: calc(var(--bf-phone-top) + 38px); bottom: auto; padding: 5px 14px;
  max-width: min(calc(100vw - 2 * var(--bf-phone-right) - 2 * var(--bf-phone-gear)), var(--bf-size-error-max)); }
html.bf-phone .bf-label-pill { padding: 5px 11px; }
html.bf-phone .bf-saved { top: var(--bf-phone-top); left: var(--bf-phone-left); max-width: 36vw; }
html.bf-phone .bf-card { padding: 12px 16px; border-radius: 16px; overflow: hidden; max-height: 46%; }
html.bf-phone .bf-card__kicker { margin-bottom: 4px; }
html.bf-phone .bf-card__name { margin-bottom: 4px; }
html.bf-phone .bf-card__body, html.bf-phone .bf-card__safety span { display: -webkit-box; -webkit-box-orient: vertical;
  -webkit-line-clamp: 3; overflow: hidden; }
html.bf-phone .bf-card__safety { margin-top: 8px; padding-top: 8px; gap: 8px; }
html.bf-phone .bf-progress { margin: 4px 0 6px; }
html.bf-phone .bf-part-card { left: var(--bf-phone-left); bottom: var(--bf-phone-bottom); }
html.bf-phone .bf-step-card { right: var(--bf-phone-right); bottom: var(--bf-phone-bottom); }
/* voice pill and captions: your words on one line, the answer on at most two, between the cards */
html.bf-phone .bf-vpill { padding: 4px 14px; }
html.bf-phone .bf-vcaps { padding: 6px 14px; }
html.bf-phone .bf-vcap { -webkit-line-clamp: 2; }
html.bf-phone .bf-vcap.user { -webkit-line-clamp: 1; }
html.bf-phone body:has(.bf-part-card, .bf-step-card) .bf-vcaps {
  max-width: min(var(--bf-size-caption-max), 100%, calc(100vw - 2 * (max(var(--bf-phone-left), var(--bf-phone-right))
    + max(min(var(--bf-size-card-width), var(--bf-size-card-max-vw)), min(var(--bf-size-step-width), var(--bf-size-step-max-vw))) + 16px))); }
/* a detail model up (?detail=1): it has the right 45 percent and its card the top right (DetailStage.tsx), so
   the title and the status pill go over the main model, the middle of the left 55 percent */
html.bf-phone body:has(.bf-detail-card) .bf-title-pill,
html.bf-phone body:has(.bf-detail-card) .bf-status-pill { left: 27.5%; }
html.bf-phone body:has(.bf-detail-card) .bf-status-pill { max-width: calc(55vw - 2 * var(--bf-phone-left)); }
/* debug panel (D): inside the safe area, the tuning column under the gear */
html.bf-phone .bf-debug { left: var(--bf-phone-left); top: calc(var(--bf-phone-top) + 40px);
  max-width: calc(100vw - var(--bf-phone-left) - var(--bf-phone-right)); max-height: calc(100% - 200px); font-size: 11px !important; }
html.bf-phone .bf-tuning-col { top: calc(var(--bf-safe-top) + var(--bf-phone-gear) + 8px); right: var(--bf-phone-right); width: 300px;
  max-height: calc(100% - var(--bf-safe-top) - var(--bf-phone-gear) - 8px - var(--bf-phone-bottom)); }

/* ---- Tap to start ---- */
.bf-phone-start { position: fixed; inset: 0; z-index: 200; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: ${pt(10)}; box-sizing: border-box; margin: 0; padding: ${pt(16)} max(${pt(16)}, var(--bf-safe-left), var(--bf-safe-right));
  border: 0; outline: none; background: #000; color: #fff; cursor: pointer; text-align: center;
  font-family: ${FONT}; -webkit-font-smoothing: antialiased; }
.bf-phone-start__title { font-size: ${pt(15)}; letter-spacing: 0.08em; text-transform: uppercase; color: rgba(255, 255, 255, 0.62); }
.bf-phone-start__tap { padding: ${pt(14)} ${pt(28)}; border-radius: 999px; font-size: ${pt(22)}; font-weight: 600;
  background: rgba(22, 25, 30, 0.8); border: 1px solid rgba(77, 163, 255, 0.7); box-shadow: 0 0 0 ${pt(6)} rgba(77, 163, 255, 0.16); }
.bf-phone-start__note { max-width: ${pt(440)}; font-size: ${pt(13)}; line-height: 1.4; color: rgba(255, 255, 255, 0.62); }
.bf-phone-start__fs { box-sizing: border-box; min-height: ${pt(44)}; margin: ${pt(4)} 0 0; padding: 0 ${pt(22)}; border-radius: 999px;
  font: 500 ${pt(15)}/1 ${FONT}; color: #fff; cursor: pointer; background: rgba(22, 25, 30, 0.8);
  border: 1px solid rgba(255, 255, 255, 0.3); -webkit-appearance: none; appearance: none; }
.bf-phone-start__fs:active { background: rgba(77, 163, 255, 0.35); }
.bf-phone-start__hints { display: flex; flex-direction: column; gap: ${pt(4)}; max-width: ${pt(520)}; margin-top: ${pt(6)};
  font-size: ${pt(12)}; line-height: 1.35; color: rgba(255, 255, 255, 0.5); }

/* ---- the settings gear (top right, inside the safe area) and its sheet ---- */
.bf-phone-gear { position: fixed; z-index: 70; top: var(--bf-safe-top); right: var(--bf-phone-right); box-sizing: border-box;
  width: var(--bf-phone-gear); height: var(--bf-phone-gear); display: grid; place-items: center; margin: 0; padding: 0;
  border: 0; border-radius: 999px; background: transparent; color: #fff; opacity: 0.42; cursor: pointer;
  -webkit-appearance: none; appearance: none; }
.bf-phone-gear svg { display: block; width: ${pt(28)}; height: ${pt(28)}; filter: drop-shadow(0 0 1.5px rgba(0, 0, 0, 0.8)); }
.bf-phone-gear:active { opacity: 0.9; }
.bf-ps-backdrop { position: fixed; inset: 0; z-index: 75; background: rgba(0, 0, 0, 0.2); cursor: pointer; }
.bf-ps { position: fixed; z-index: 80; top: max(var(--bf-safe-top), ${pt(6)}); right: var(--bf-phone-right); box-sizing: border-box;
  width: min(${pt(330)}, calc(100vw - var(--bf-phone-left) - var(--bf-phone-right)));
  max-height: calc(100% - max(var(--bf-safe-top), ${pt(6)}) - var(--bf-phone-bottom)); overflow-y: auto;
  display: flex; flex-direction: column; gap: ${pt(8)}; margin: 0; padding: ${pt(10)} ${pt(12)} ${pt(12)}; border-radius: ${pt(18)};
  font: 400 ${pt(15)}/1.2 ${FONT}; color: #fff; -webkit-font-smoothing: antialiased;
  background: rgba(16, 19, 24, 0.88); border: 1px solid rgba(255, 255, 255, 0.22); box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
  -webkit-backdrop-filter: blur(24px) saturate(140%); backdrop-filter: blur(24px) saturate(140%); }
.bf-ps__head { display: flex; align-items: center; justify-content: space-between; gap: ${pt(8)}; }
.bf-ps__title { padding-left: ${pt(4)}; font-size: ${pt(16)}; font-weight: 600; }
.bf-ps__label { margin: ${pt(2)} 0 0; padding-left: ${pt(4)}; font-size: ${pt(12)}; color: rgba(255, 255, 255, 0.6); }
.bf-ps__row { display: grid; grid-template-columns: 1fr 1fr; gap: ${pt(8)}; }
.bf-ps__btn { box-sizing: border-box; min-height: ${pt(44)}; margin: 0; padding: ${pt(6)} ${pt(12)}; border-radius: ${pt(12)};
  font: 500 ${pt(15)}/1.15 ${FONT}; color: rgba(255, 255, 255, 0.94); text-align: center; cursor: pointer;
  background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.2); -webkit-appearance: none; appearance: none; }
.bf-ps__btn:active { background: rgba(77, 163, 255, 0.35); }
.bf-ps__btn.on { border-color: #4da3ff; background: rgba(77, 163, 255, 0.18); }
.bf-ps__btn--wide { grid-column: 1 / -1; }
.bf-ps__close { min-width: ${pt(84)}; }

/* ---- held upright: a hint instead of a squashed layout (never a turned page: the glasses mirror the real screen) ---- */
.bf-phone-rotate { display: none; }
@media (orientation: portrait) {
  .bf-phone-rotate { position: fixed; z-index: 210; left: 50%; top: 50%; transform: translate(-50%, -50%); display: block;
    padding: ${pt(12)} ${pt(20)}; border-radius: 999px; pointer-events: none; white-space: nowrap;
    font: 600 ${pt(17)}/1.2 ${FONT}; color: #fff;
    background: rgba(16, 19, 24, 0.86); border: 1px solid rgba(255, 255, 255, 0.22); }
}
`;
