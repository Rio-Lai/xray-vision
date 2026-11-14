/**
 * HUD (PROJECT.md section 2): the exploded object's title pill, the part and step cards, one
 * quiet status pill near the bottom, and the hidden debug panel (D) with the developer keys.
 * Object and part labels are drawn by src/overlay (objectLabels.ts, labels.ts) every frame.
 * Overlay off (the default) = nothing from here on screen, apart from a real error.
 * Pointer events are off for the whole HUD so clicks reach the Stage picker.
 */
import { useEffect, useState } from 'react';
import { useStore } from '../state/store';
import { MOCK_MODE } from '../camera/frame';
import { live } from '../detect/live';
import { FINGERS } from '../detect/handTracker';
import { useHud } from './hudStore';
import { HUD_CSS } from './styles';

function useTicker(ms: number, enabled = true): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setN((k) => k + 1), ms);
    return () => clearInterval(id);
  }, [ms, enabled]);
  return n;
}

/** The one status pill: an error if there is one, else a developer warning, else "Looking...". */
function StatusPill() {
  const tdStatus = useStore((s) => s.teardownStatus);
  const tdError = useStore((s) => s.teardownError);
  const status = useHud((s) => s.status);
  const toast = useHud((s) => s.toast);
  const firstError = Object.values(status).find((l) => l.level === 'error');
  let kind: 'error' | 'warn' | 'busy' | null = null;
  let text = '';
  if (tdStatus === 'error') {
    kind = 'error';
    text = tdError || 'I could not load the parts for that.';
  } else if (firstError) {
    kind = 'error';
    text = firstError.text;
  } else if (toast && toast.level !== 'info') {
    kind = toast.level;
    text = toast.text;
  } else if (tdStatus === 'loading') {
    kind = 'busy';
    text = 'Looking\u2026';
  }
  if (!kind) return null;
  return (
    <div className="bf-status" key={`${kind}:${text}`}>
      <div className="bf-pill bf-glass">
        <i className={`bf-status-dot ${kind}`} />
        <span>{text}</span>
      </div>
    </div>
  );
}

/** Name of the exploded object, plus "AI-estimated" when the parts list was generated live. */
function ExplodedTitle() {
  const tdName = useStore((s) => s.teardown?.name ?? null);
  const isLive = useStore((s) => s.teardown?.source === 'live');
  if (!tdName) return null;
  return (
    <div className="bf-title" key={tdName}>
      <div className="bf-pill bf-glass">{tdName}</div>
      {isLive && <div className="bf-pill bf-glass bf-chip-ai">AI-estimated</div>}
    </div>
  );
}

/** The selected part: name, one sentence, safety in warm amber. Bottom-left. */
function PartCard() {
  const part = useStore((s) => (s.highlightedPartId && s.teardown ? s.teardown.parts.find((p) => p.id === s.highlightedPartId) ?? null : null));
  if (!part) return null;
  return (
    <div className="bf-card bf-card-part" data-bf-avoid key={part.id}>
      <div className="bf-card-title">{part.name}</div>
      <div className="bf-card-body">{part.summary}</div>
      {part.safety && <div className="bf-card-safety">{part.safety}</div>}
    </div>
  );
}

/** The current repair / explanation step. Bottom-right. */
function StepCard() {
  const activeStep = useStore((s) => s.activeStep);
  const steps = useStore((s) => s.teardown?.steps ?? null);
  if (activeStep === null || !steps) return null;
  const step = steps.find((st) => st.n === activeStep);
  if (!step) return null;
  return (
    <div className="bf-card bf-card-step" data-bf-avoid key={step.n}>
      <div className="bf-card-kicker">
        Step {step.n} of {steps.length}
      </div>
      <div className="bf-card-body">{step.text}</div>
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
  return <div className="bf-debug">{lines.join('\n')}</div>;
}

export function Hud() {
  return (
    <div className="bf-hud">
      <style>{HUD_CSS}</style>
      <ExplodedTitle />
      <StatusPill />
      <PartCard />
      <StepCard />
      <DebugPanel />
    </div>
  );
}

export default Hud;
