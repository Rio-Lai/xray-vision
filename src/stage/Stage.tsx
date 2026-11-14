/**
 * Stage: camera + 3D overlay + HUD, the single requestAnimationFrame loop (detection, then
 * overlay render), hidden developer keys, and click-to-pick. Cleans up fully on unmount.
 *
 * Developer keys (never shown on screen; listed in the debug panel):
 *   O overlay on/off   A analyse "this" (on stage, parts just apart)   E explode "this"   R reset
 *   D debug panel   F freeze   S next step   M tracking mode   Left/Right or [ ] previous/next part
 * Hidden mouse fallback while a model is on stage: drag turns it (with a little inertia), the
 * wheel opens and closes it; a click without dragging picks a part.
 * `?overlay=1` starts with the overlay on.
 */
import { useEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useStore } from '../state/store';
import type { TrackingMode } from '../state/store';
import { explodeObject, pickPart, resetAll } from '../lib/flow';
import { Camera } from '../camera/Camera';
import { errorText, urlFlag } from '../camera/frame';
import { createDetectionEngine } from '../detect/engine';
import { live } from '../detect/live';
import { Overlay } from '../overlay/Overlay';
import type { OverlayHandle } from '../overlay/Overlay';
import { Hud } from '../hud/Hud';
import { devLog, setStatus, showToast, toggleDebug } from '../hud/hudStore';
import { STAGE_MIN_EXPLODE, modelControl, stageInputActive } from './modelControl';

const MODES: TrackingMode[] = ['freeze', 'follow', 'stage'];
/** Mouse fallback: radians per pixel dragged, and explode change per wheel pixel. */
const DRAG_RAD_PER_PX = 0.008;
const WHEEL_PER_PX = 0.0016;
/** A press that moves less than this is a click (pick a part), not a drag. */
const CLICK_SLOP_PX = 5;

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function cyclePart(dir: 1 | -1): void {
  const s = useStore.getState();
  const td = s.teardown;
  if (!td || td.parts.length === 0) {
    showToast('Nothing is exploded yet', 'warn');
    return;
  }
  const parts = td.parts
    .map((p, i) => ({ p, i }))
    .sort((a, b) => a.p.layer - b.p.layer || a.i - b.i)
    .map((x) => x.p);
  const cur = parts.findIndex((p) => p.id === s.highlightedPartId);
  const next = cur < 0 ? (dir > 0 ? 0 : parts.length - 1) : (cur + dir + parts.length) % parts.length;
  pickPart(parts[next].id);
}

function nextStep(): void {
  const s = useStore.getState();
  const td = s.teardown;
  if (!td || td.steps.length === 0) {
    showToast('No steps for this view', 'warn');
    return;
  }
  const steps = [...td.steps].sort((a, b) => a.n - b.n);
  const idx = steps.findIndex((st) => st.n === s.activeStep);
  const next = idx < 0 ? steps[0].n : idx + 1 < steps.length ? steps[idx + 1].n : null;
  s.showStep(next);
  if (next === null) showToast('Steps done', 'info', 1500);
}

function setOverlay(on: boolean): void {
  // Same as the set_overlay voice tool: turning it off also puts everything back.
  useStore.getState().setOverlayOn(on);
  if (!on) resetAll();
  devLog(`Overlay ${on ? 'on' : 'off'}`);
}

/** amount 1 = "explode this"; STAGE_MIN_EXPLODE = "analyse this" (the voice agent's explode amount 0.12). */
function runExplode(amount = 1): void {
  if (!useStore.getState().overlayOn) useStore.getState().setOverlayOn(true);
  devLog(amount < 1 ? 'Analyse requested' : 'Explode requested');
  explodeObject()
    .then((r) => {
      if (r.ok && amount < 1) useStore.getState().setExplode(amount);
      showToast(r.message, r.ok ? 'info' : 'warn');
    })
    .catch((e: unknown) => showToast(`Explode failed: ${errorText(e)}`, 'error'));
}

export function Stage() {
  const overlayRef = useRef<OverlayHandle>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  /** The press in progress: where it started, the last point, and whether it became a drag. */
  const pressRef = useRef<{ id: number; x0: number; y0: number; x: number; y: number; drag: boolean } | null>(null);

  // Developer convenience: ?overlay=1 starts with the overlay on.
  useEffect(() => {
    if (urlFlag('overlay')) useStore.getState().setOverlayOn(true);
  }, []);

  // The single animation loop: detection first, then the overlay reads its results and renders.
  useEffect(() => {
    const engine = createDetectionEngine();
    let raf = 0;
    let alive = true;
    let frames = 0;
    let fpsStart = performance.now();
    let last = 0;
    const loop = (now: number) => {
      if (!alive) return;
      raf = requestAnimationFrame(loop);
      const dt = last ? Math.min(0.1, Math.max(0, (now - last) / 1000)) : 1 / 60;
      last = now;
      try {
        engine.tick(now);
      } catch (e) {
        setStatus('loop-detect', 'error', `Detection loop error: ${errorText(e)}`);
      }
      try {
        modelControl.tick(now, dt);
      } catch (e) {
        setStatus('loop-control', 'error', `Model control error: ${errorText(e)}`);
      }
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
      engine.dispose();
      modelControl.stop();
    };
  }, []);

  // Keyboard shortcuts (backup controls).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return; // keep Cmd+R etc.
      if (isTypingTarget(e.target)) return;
      const s = useStore.getState();
      const key = e.key;
      if (key === 'ArrowLeft' || key === '[') {
        e.preventDefault();
        cyclePart(-1);
        return;
      }
      if (key === 'ArrowRight' || key === ']') {
        e.preventDefault();
        cyclePart(1);
        return;
      }
      if (e.repeat) return;
      switch (key.toLowerCase()) {
        case 'o':
          setOverlay(!s.overlayOn);
          break;
        case 'e':
          runExplode();
          break;
        case 'a':
          runExplode(STAGE_MIN_EXPLODE);
          break;
        case 'r':
          modelControl.stop();
          resetAll();
          showToast('Reset', 'info', 1200);
          break;
        case 'f':
          s.setFrozen(!s.frozen);
          devLog(`Frozen: ${!s.frozen}`);
          break;
        case 's':
          nextStep();
          break;
        case 'm': {
          const next = MODES[(MODES.indexOf(s.trackingMode) + 1) % MODES.length];
          s.setTrackingMode(next);
          if (next !== 'freeze' && s.frozen) s.setFrozen(false);
          if (next === 'freeze' && s.teardown && s.teardown.anchor !== 'hand' && s.explodeAmount > 0) s.setFrozen(true);
          showToast(`Tracking: ${next}`, 'info', 1500);
          break;
        }
        case 'd':
          toggleDebug();
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Mouse wheel opens / closes the model on stage (non-passive, so the page never scrolls or zooms).
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) return; // pinch-zoom / Cmd+wheel stay the browser's
      const t = e.target;
      if (t instanceof Element && t.closest('[data-xr-ui]')) return;
      const s = useStore.getState();
      if (!stageInputActive(s)) return;
      e.preventDefault();
      const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      modelControl.setExplode(s.explodeAmount - px * WHEEL_PER_PX, performance.now());
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const t = e.target;
    if (t instanceof Element && t.closest('button, select, input, textarea, a, [data-xr-ui]')) return;
    pressRef.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, drag: false };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture is optional */
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = pressRef.current;
    if (!p || p.id !== e.pointerId) return;
    if (!p.drag && Math.hypot(e.clientX - p.x0, e.clientY - p.y0) > CLICK_SLOP_PX && stageInputActive(useStore.getState())) {
      p.drag = true;
    }
    if (p.drag) {
      // Like spinning a globe: drag right turns the front to the right, drag down tips the top towards you.
      modelControl.turn((e.clientX - p.x) * DRAG_RAD_PER_PX, (e.clientY - p.y) * DRAG_RAD_PER_PX, performance.now());
    }
    p.x = e.clientX;
    p.y = e.clientY;
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = pressRef.current;
    if (!p || p.id !== e.pointerId) return;
    pressRef.current = null;
    if (p.drag) modelControl.release(performance.now());
    else overlayRef.current?.pick(e.clientX, e.clientY);
  };

  const onPointerCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = pressRef.current;
    if (!p || p.id !== e.pointerId) return;
    pressRef.current = null;
    if (p.drag) modelControl.release(performance.now());
  };

  return (
    <div
      ref={rootRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      style={{
        position: 'fixed',
        inset: 0,
        overflow: 'hidden',
        zIndex: 0,
        background: '#000', // black reads as transparent in the XREAL glasses
        userSelect: 'none',
      }}
    >
      <Camera />
      <Overlay ref={overlayRef} />
      <Hud />
    </div>
  );
}

export default Stage;
