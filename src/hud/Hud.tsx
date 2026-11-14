/**
 * HUD: object labels (only while the overlay is on), part and step cards, the exploded object's
 * title, on-screen errors, toast, and the hidden debug panel (D) with the developer keys.
 * Overlay off (the default) = nothing from here on screen, apart from real errors.
 * Pointer events are off for the whole HUD so clicks reach the Stage picker.
 */
import { useEffect, useState } from 'react';
import { useStore } from '../state/store';
import { boxToView, getCoverMap, MOCK_MODE } from '../camera/frame';
import { live } from '../detect/live';
import { FINGERS } from '../detect/handTracker';
import { useHud } from './hudStore';
import { HUD_CSS } from './styles';

function useViewportVersion(): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    const on = () => setV((n) => n + 1);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return v;
}

function useTicker(ms: number, enabled = true): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setN((k) => k + 1), ms);
    return () => clearInterval(id);
  }, [ms, enabled]);
  return n;
}

/** One label per detected thing of any kind, only while the overlay is on and nothing is exploded. */
function ObjectLabels() {
  const overlayOn = useStore((s) => s.overlayOn);
  const objects = useStore((s) => s.objects);
  const focused = useStore((s) => s.focusedObjectId);
  const exploded = useStore((s) => s.teardown !== null);
  useViewportVersion();
  if (!overlayOn || exploded) return null;
  const map = getCoverMap();
  return (
    <>
      {objects.map((o) => {
        const b = boxToView(map, o.box);
        const isFocused = o.id === focused;
        const label = o.label === 'hand' ? `hand ${o.id === 'hand-left' ? 'L' : 'R'}` : o.name ?? o.label;
        return (
          <div
            key={o.id}
            className={`xr-obj${isFocused ? ' focused' : ''}`}
            style={{
              transform: `translate(${b.x.toFixed(1)}px, ${b.y.toFixed(1)}px)`,
              width: Math.max(4, b.w),
              height: Math.max(4, b.h),
            }}
          >
            <i className="tl" />
            <i className="tr" />
            <i className="bl" />
            <i className="br" />
            <div className="xr-obj-tag">{label.toUpperCase()}</div>
          </div>
        );
      })}
    </>
  );
}

/** On screen: explode progress and real errors only. Info and warnings live in the debug panel. */
function StatusStack() {
  const tdStatus = useStore((s) => s.teardownStatus);
  const tdError = useStore((s) => s.teardownError);
  const status = useHud((s) => s.status);
  const lines = Object.entries(status).filter(([, l]) => l.level === 'error');
  return (
    <div className="xr-status">
      {tdStatus === 'loading' && (
        <div className="xr-card xr-line info">
          <span className="xr-dots">Scanning</span>
        </div>
      )}
      {tdStatus === 'error' && <div className="xr-card xr-line error">{tdError || 'Could not load the parts'}</div>}
      {lines.map(([key, l]) => (
        <div key={key} className={`xr-card xr-line ${l.level}`}>
          {l.text}
        </div>
      ))}
    </div>
  );
}

/** Name of the exploded object, plus "AI-estimated" when the parts list was generated live. */
function ExplodedTitle() {
  const tdName = useStore((s) => s.teardown?.name ?? null);
  const isLive = useStore((s) => s.teardown?.source === 'live');
  if (!tdName) return null;
  return (
    <div className="xr-tc">
      <div className="xr-card xr-pill" style={{ textTransform: 'none', letterSpacing: '0.06em' }}>
        {tdName}
      </div>
      {isLive && <div className="xr-card xr-pill xr-chip-ai">AI-estimated</div>}
    </div>
  );
}

function PartCard() {
  const part = useStore((s) => (s.highlightedPartId && s.teardown ? s.teardown.parts.find((p) => p.id === s.highlightedPartId) ?? null : null));
  if (!part) return null;
  return (
    <div className="xr-card xr-part">
      <div className="xr-kicker">Part · layer {part.layer}</div>
      <div className="xr-title">{part.name}</div>
      <div className="xr-body">{part.summary}</div>
      {part.safety && (
        <div className="xr-safety">
          <b>SAFETY</b>
          {part.safety}
        </div>
      )}
    </div>
  );
}

function StepCard() {
  const activeStep = useStore((s) => s.activeStep);
  const steps = useStore((s) => s.teardown?.steps ?? null);
  if (activeStep === null || !steps) return null;
  const step = steps.find((st) => st.n === activeStep);
  if (!step) return null;
  return (
    <div className="xr-card xr-step">
      <div className="xr-kicker">
        Step {step.n} of {steps.length}
      </div>
      <div className="xr-body" style={{ fontSize: 19, color: '#e9fbff' }}>
        {step.text}
      </div>
    </div>
  );
}

/** Developer keys. Listed only here, inside the hidden debug panel. */
const KEYS: [string, string][] = [
  ['O', 'overlay on / off'],
  ['E', 'explode this'],
  ['R', 'reset'],
  ['D', 'this panel'],
  ['F', 'freeze frame'],
  ['S', 'next step'],
  ['M', 'tracking mode'],
  ['< >', 'previous / next part'],
  ['click', 'pick a part'],
];

function DebugPanel() {
  const visible = useHud((s) => s.debug);
  useTicker(250, visible);
  const status = useHud((s) => s.status);
  const log = useHud((s) => s.log);
  const focused = useStore((s) => s.focusedObjectId);
  const selected = useStore((s) => s.selectedObjectId);
  const overlayOn = useStore((s) => s.overlayOn);
  const mode = useStore((s) => s.trackingMode);
  const frozen = useStore((s) => s.frozen);
  const explode = useStore((s) => s.explodeAmount);
  const tdStatus = useStore((s) => s.teardownStatus);
  if (!visible) return null;
  const st = live.stats;
  const lines: string[] = [];
  lines.push(`render ${st.renderFps.toFixed(1)} fps | objects ${st.objMs.toFixed(1)} ms | hands ${st.handMs.toFixed(1)} ms${MOCK_MODE ? ' | MOCK' : ''}`);
  lines.push(`overlay ${overlayOn ? 'ON' : 'off'} | tracking ${mode}${frozen ? ' (FROZEN)' : ''} | explode ${explode.toFixed(2)} | teardown ${tdStatus}`);
  for (const n of st.notes) lines.push(n);
  for (const [key, l] of Object.entries(status)) lines.push(`[${l.level}] ${key}: ${l.text}`);
  lines.push(`focused: ${focused ?? '-'}   selected: ${selected ?? '-'}`);
  lines.push('objects:');
  for (const o of live.objects) {
    const b = o.box;
    lines.push(
      `  ${o.id.padEnd(14)} ${o.label.padEnd(10)} ${(o.confidence * 100).toFixed(0).padStart(3)}%  [${b.x.toFixed(2)} ${b.y.toFixed(2)} ${b.w.toFixed(2)} ${b.h.toFixed(2)}]`,
    );
  }
  for (const h of live.hands) {
    lines.push(`${h.id}  size ${h.handSize.toFixed(0)}px  active: ${h.activeFinger ?? '-'}`);
    for (const f of FINGERS) {
      const d = h.dyn[f];
      lines.push(
        `  ${f.padEnd(7)} curl ${d.curl.toFixed(2)}  v ${d.signal >= 0 ? ' ' : ''}${d.signal.toFixed(2)}  ${d.pressing ? 'PRESS' : '     '} ${d.extending ? 'EXT' : ''}`,
      );
    }
  }
  if (log.length) {
    lines.push('log:');
    for (const l of log) lines.push(`  ${(l.t / 1000).toFixed(1)}s ${l.level === 'info' ? '' : `[${l.level}] `}${l.text}`);
  }
  lines.push('keys: ' + KEYS.map(([k, v]) => `${k} ${v}`).join(' | '));
  return <div className="xr-card xr-debug">{lines.join('\n')}</div>;
}

function ToastView() {
  const toast = useHud((s) => s.toast);
  if (!toast) return null;
  return <div className={`xr-card xr-toast ${toast.level}`}>{toast.text}</div>;
}

export function Hud() {
  return (
    <div className="xr-hud">
      <style>{HUD_CSS}</style>
      <ObjectLabels />
      <ExplodedTitle />
      <StatusStack />
      <PartCard />
      <StepCard />
      <DebugPanel />
      <ToastView />
    </div>
  );
}

export default Hud;
