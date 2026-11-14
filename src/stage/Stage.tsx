/**
 * Stage: camera + 3D overlay + HUD, the single requestAnimationFrame loop (detection, then
 * overlay render), keyboard shortcuts, and click-to-pick. Cleans up fully on unmount.
 */
import { useEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useStore } from '../state/store';
import type { TrackingMode } from '../state/store';
import { explodeObject, pickPart, resetAll } from '../lib/flow';
import { Camera } from '../camera/Camera';
import { errorText } from '../camera/frame';
import { createDetectionEngine } from '../detect/engine';
import { live } from '../detect/live';
import { Overlay } from '../overlay/Overlay';
import type { OverlayHandle } from '../overlay/Overlay';
import { Hud } from '../hud/Hud';
import { setStatus, showToast, toggleDebug, toggleLegend } from '../hud/hudStore';

const MODES: TrackingMode[] = ['freeze', 'follow', 'mat'];

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
    showToast('Nothing exploded yet (press E)', 'warn');
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

function runExplode(): void {
  showToast('Exploding...', 'info', 1500);
  explodeObject()
    .then((r) => showToast(r.message, r.ok ? 'info' : 'warn'))
    .catch((e: unknown) => showToast(`Explode failed: ${errorText(e)}`, 'error'));
}

export function Stage() {
  const overlayRef = useRef<OverlayHandle>(null);

  // The single animation loop: detection first, then the overlay reads its results and renders.
  useEffect(() => {
    const engine = createDetectionEngine();
    let raf = 0;
    let alive = true;
    let frames = 0;
    let fpsStart = performance.now();
    const loop = (now: number) => {
      if (!alive) return;
      raf = requestAnimationFrame(loop);
      try {
        engine.tick(now);
      } catch (e) {
        setStatus('loop-detect', 'error', `Detection loop error: ${errorText(e)}`);
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
        case 'e':
          runExplode();
          break;
        case 'r':
          resetAll();
          showToast('Reset', 'info', 1200);
          break;
        case 'f':
          s.setFrozen(!s.frozen);
          break;
        case 'l': {
          const next = s.lens === 'engineering' ? 'biology' : 'engineering';
          resetAll();
          useStore.getState().setLens(next);
          showToast(`Lens: ${next}`, 'info', 1500);
          break;
        }
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
        case 'h':
          toggleLegend();
          break;
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

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const t = e.target;
    if (t instanceof Element && t.closest('button, select, input, textarea, a, [data-xr-ui]')) return;
    overlayRef.current?.pick(e.clientX, e.clientY);
  };

  return (
    <div
      onPointerDown={onPointerDown}
      style={{
        position: 'fixed',
        inset: 0,
        overflow: 'hidden',
        zIndex: 0,
        background: 'radial-gradient(ellipse at center, #0b1a26 0%, #03070b 75%)',
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
