/**
 * Sci-fi HUD: reticle, object brackets, lens / mode / fps badges, status lines, part and step cards,
 * AI-estimated chip, key legend (H), debug panel (D), toast.
 * Pointer events are off for the whole HUD so clicks reach the Stage picker.
 */
import { useEffect, useState } from 'react';
import { useStore } from '../state/store';
import { boxToView, getCoverMap } from '../camera/frame';
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

function ObjectBrackets() {
  const objects = useStore((s) => s.objects);
  const lens = useStore((s) => s.lens);
  const focused = useStore((s) => s.focusedObjectId);
  const selected = useStore((s) => s.selectedObjectId);
  const hasTeardown = useStore((s) => s.teardown !== null);
  useViewportVersion();
  const map = getCoverMap();
  return (
    <>
      {objects
        .filter((o) => o.lens === lens)
        .map((o) => {
          const b = boxToView(map, o.box);
          const isFocused = o.id === focused;
          const dim = hasTeardown && (o.id === selected || o.id === focused);
          const label = o.label === 'hand' ? `hand ${o.id === 'hand-left' ? 'L' : 'R'}` : o.name ?? o.label;
          return (
            <div
              key={o.id}
              className={`xr-obj${isFocused ? ' focused' : ''}`}
              style={{
                transform: `translate(${b.x.toFixed(1)}px, ${b.y.toFixed(1)}px)`,
                width: Math.max(4, b.w),
                height: Math.max(4, b.h),
                opacity: dim ? 0.3 : 1,
              }}
            >
              <i className="tl" />
              <i className="tr" />
              <i className="bl" />
              <i className="br" />
              <div className="xr-obj-tag">
                {label.toUpperCase()}
                <span>{Math.round(o.confidence * 100)}%</span>
              </div>
            </div>
          );
        })}
    </>
  );
}

function Reticle() {
  const label = useStore((s) => {
    const o = s.focusedObjectId ? s.objects.find((x) => x.id === s.focusedObjectId) : undefined;
    return o ? o.name ?? o.label : null;
  });
  const locked = label !== null;
  const c = locked ? '#c9f5ff' : 'rgba(125,227,255,0.75)';
  return (
    <>
      <div className={`xr-reticle${locked ? ' locked' : ''}`}>
        <svg viewBox="0 0 76 76">
          <circle className="ring" cx="38" cy="38" r="20" fill="none" stroke={c} strokeWidth={locked ? 2.5 : 1.5} />
          <g className="spin">
            <circle cx="38" cy="38" r="28" fill="none" stroke={c} strokeWidth="1.5" strokeDasharray={locked ? '10 8' : '3 9'} />
          </g>
          <line x1="38" y1="2" x2="38" y2="12" stroke={c} strokeWidth="2" />
          <line x1="38" y1="64" x2="38" y2="74" stroke={c} strokeWidth="2" />
          <line x1="2" y1="38" x2="12" y2="38" stroke={c} strokeWidth="2" />
          <line x1="64" y1="38" x2="74" y2="38" stroke={c} strokeWidth="2" />
          <circle cx="38" cy="38" r={locked ? 3 : 2} fill={c} />
        </svg>
      </div>
      {locked && <div className="xr-lock">LOCK · {label.toUpperCase()}</div>}
    </>
  );
}

function StatusStack() {
  const tdStatus = useStore((s) => s.teardownStatus);
  const tdError = useStore((s) => s.teardownError);
  const status = useHud((s) => s.status);
  const showWarn = useHud((s) => s.legend || s.debug);
  // Errors and progress always show; warnings only while the legend (first 10 s, H) or debug (D) is open.
  const lines = Object.entries(status).filter(([, l]) => l.level !== 'warn' || showWarn);
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

function TopBadges() {
  const lens = useStore((s) => s.lens);
  const mode = useStore((s) => s.trackingMode);
  const frozen = useStore((s) => s.frozen);
  const tdName = useStore((s) => s.teardown?.name ?? null);
  const live_ = useStore((s) => s.teardown?.source === 'live');
  useTicker(500);
  const fps = Math.round(live.stats.renderFps);
  return (
    <>
      <div className="xr-card xr-badge xr-tl">{lens === 'engineering' ? 'ENGINEERING' : 'BIOLOGY'}</div>
      <div className="xr-tr">
        <div className="xr-card xr-pill">{mode}</div>
        {frozen && <div className="xr-card xr-pill xr-frozen">FROZEN</div>}
        <div className="xr-card xr-pill" style={{ color: fps > 0 && fps < 24 ? '#ffd27a' : undefined }}>
          {fps} fps
        </div>
      </div>
      {tdName && (
        <div className="xr-tc">
          <div className="xr-card xr-pill" style={{ textTransform: 'none', letterSpacing: '0.06em' }}>
            {tdName}
          </div>
          {live_ && <div className="xr-card xr-pill xr-chip-ai">AI-estimated</div>}
        </div>
      )}
    </>
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

const KEYS: [string, string][] = [
  ['E', 'explode this'],
  ['R', 'reset'],
  ['F', 'freeze frame'],
  ['L', 'switch lens'],
  ['< >', 'prev / next part'],
  ['S', 'next step'],
  ['M', 'tracking mode'],
  ['H', 'this legend'],
  ['D', 'debug'],
  ['click', 'pick a part'],
];

function Legend() {
  const visible = useHud((s) => s.legend);
  useEffect(() => {
    const id = setTimeout(() => useHud.setState({ legend: false }), 10_000);
    return () => clearTimeout(id);
  }, []);
  if (!visible) return null;
  return (
    <div className="xr-card xr-legend">
      {KEYS.map(([k, v]) => (
        <div key={k}>
          <b>{k}</b> {v}
        </div>
      ))}
    </div>
  );
}

function DebugPanel() {
  const visible = useHud((s) => s.debug);
  useTicker(250, visible);
  const focused = useStore((s) => s.focusedObjectId);
  const selected = useStore((s) => s.selectedObjectId);
  if (!visible) return null;
  const st = live.stats;
  const lines: string[] = [];
  lines.push(`render ${st.renderFps.toFixed(1)} fps | objects ${st.objMs.toFixed(1)} ms | hands ${st.handMs.toFixed(1)} ms`);
  for (const n of st.notes) lines.push(n);
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
      <ObjectBrackets />
      <Reticle />
      <StatusStack />
      <TopBadges />
      <PartCard />
      <StepCard />
      <Legend />
      <DebugPanel />
      <ToastView />
    </div>
  );
}

export default Hud;
