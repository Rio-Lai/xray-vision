/**
 * HUD (PROJECT.md section 2): the exploded object's title pill, the part and step cards, one
 * quiet status pill near the bottom, and the hidden debug panel (D) with the developer keys.
 * Object and part labels are drawn by src/overlay (objectLabels.ts, labels.ts) every frame.
 * Overlay off (the default) = nothing from here on screen, apart from a real error.
 * Pointer events are off for the whole HUD so clicks reach the Stage picker.
 * Look (#86): the Figma Make interface kit's markup and classes by default (src/hud/kit/);
 * `?look=classic` renders the previous markup with the previous stylesheet. Same states either way.
 */
import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { useStore } from '../state/store';
import { MOCK_MODE } from '../camera/frame';
import { live } from '../detect/live';
import { FINGERS, HAND_TUNING_DEFAULTS, handTuning, setHandTuning } from '../detect/handTracker';
import type { HandTuning } from '../detect/handTracker';
import { useHud } from './hudStore';
import { HUD_CSS } from './styles';
import { KIT_LOOK, LOOK } from './look';
import { modelControl } from '../stage/modelControl';
import type { AppState } from '../state/store';
import { gestureLive } from '../detect/gestureDriver';
import { GESTURE_TUNING_DEFAULTS } from '../detect/gestures';
import type { GestureTuning } from '../detect/gestures';
import { gestureTuning, gestureTuningUrl, setGestureTuning } from '../detect/gestureTuning';
import { isPinnedId } from '../detect/centre';
import { shortName } from './names';

/** Something is open: exploded in freeze / follow, or any model on stage (even at explode 0). */
function isShowing(s: AppState): boolean {
  return s.teardown !== null && (s.explodeAmount > 0 || s.trackingMode === 'stage');
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

/** How long an explode error ("I do not have parts for the phone yet.") stays on screen. */
const EXPLODE_ERROR_MS = 6000;

/** true until `ms` after `key` last changed (null key = false). */
function useFreshFor(key: string | null, ms: number): boolean {
  const [expired, setExpired] = useState<string | null>(null);
  useEffect(() => {
    if (key === null) return;
    const id = setTimeout(() => setExpired(key), ms);
    return () => clearTimeout(id);
  }, [key, ms]);
  return key !== null && expired !== key;
}

/**
 * While "analyse this" loads something Claude named in the middle of the view (#80), its name;
 * null while it is still being looked at, and for anything the detector found.
 */
function namedInCentre(s: AppState): string | null {
  if (s.teardownStatus !== 'loading' || !isPinnedId(s.selectedObjectId)) return null;
  const name = s.objects.find((o) => o.id === s.selectedObjectId)?.name;
  return name ? shortName(name) : null;
}

/** The one status pill: an error if there is one, else a developer warning, else "Looking..." (then the name, #80). */
function StatusPill() {
  const tdStatus = useStore((s) => s.teardownStatus);
  const tdError = useStore((s) => s.teardownError);
  const centreName = useStore(namedInCentre);
  const status = useHud((s) => s.status);
  const toast = useHud((s) => s.toast);
  const busy = useHud((s) => s.busy);
  const firstError = Object.values(status).find((l) => l.level === 'error');
  // Count each new failure, so the same message twice in a row shows again.
  const errSeq = useRef(0);
  const prevStatus = useRef(tdStatus);
  if (tdStatus !== prevStatus.current) {
    if (tdStatus === 'error') errSeq.current += 1;
    prevStatus.current = tdStatus;
  }
  const explodeErrorFresh = useFreshFor(tdStatus === 'error' ? `${errSeq.current}:${tdError ?? ''}` : null, EXPLODE_ERROR_MS);
  let kind: 'error' | 'warn' | 'busy' | null = null;
  let text = '';
  if (tdStatus === 'error' && explodeErrorFresh) {
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
    text = busy ?? centreName ?? 'Looking\u2026';
  }
  if (!kind) return null;
  if (KIT_LOOK) {
    // kit StatusPill: "looking" has a static accent dot, errors a coral dot; warnings keep a warm dot
    const variant = kind === 'busy' ? 'looking' : kind;
    return (
      <div className={`bf-status-pill bf-status-pill--${variant} bf-glass bf-enter`} key={`${kind}:${text}`}>
        <span className="bf-pill-dot" />
        <span>{text}</span>
      </div>
    );
  }
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
  const tdName = useStore((s) => (isShowing(s) ? s.teardown?.name ?? null : null));
  const isLive = useStore((s) => s.teardown?.source === 'live');
  if (!tdName) return null;
  if (KIT_LOOK) {
    // kit TitlePill: one pill, the "AI-estimated" chip inside it in neutral grey
    return (
      <div className="bf-title-pill bf-glass bf-enter" key={tdName}>
        {tdName}
        {isLive && <span className="bf-title-pill__chip">AI-estimated</span>}
      </div>
    );
  }
  return (
    <div className="bf-title" key={tdName}>
      <div className="bf-pill bf-glass">{tdName}</div>
      {isLive && <div className="bf-pill bf-glass bf-chip-ai">AI-estimated</div>}
    </div>
  );
}

/** The selected part: name, one sentence, safety in warm amber. Bottom-left. */
function PartCard() {
  const part = useStore((s) =>
    s.highlightedPartId && s.teardown && isShowing(s) ? s.teardown.parts.find((p) => p.id === s.highlightedPartId) ?? null : null,
  );
  const partIndex = useStore((s) => s.teardown?.parts.findIndex((p) => p.id === s.highlightedPartId) ?? -1);
  const partCount = useStore((s) => s.teardown?.parts.length ?? 0);
  if (!part) return null;
  if (KIT_LOOK) {
    // kit PartCard: kicker, name, summary, safety note with the warning glyph
    return (
      <section className="bf-card bf-part-card bf-enter" data-bf-avoid key={part.id}>
        {partIndex >= 0 && partCount > 0 && (
          <p className="bf-card__kicker">
            Part {partIndex + 1} of {partCount}
          </p>
        )}
        <h2 className="bf-card__name">{part.name}</h2>
        <p className="bf-card__body">{part.summary}</p>
        {part.safety && (
          <p className="bf-card__safety">
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M10 2.4 18 17H2L10 2.4Z" stroke="currentColor" strokeWidth="1.5" />
              <path d="M10 7v4.5M10 14.2v.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <span>{part.safety}</span>
          </p>
        )}
      </section>
    );
  }
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
  const activeStep = useStore((s) => (isShowing(s) ? s.activeStep : null));
  const steps = useStore((s) => s.teardown?.steps ?? null);
  if (activeStep === null || !steps) return null;
  const step = steps.find((st) => st.n === activeStep);
  if (!step) return null;
  if (KIT_LOOK) {
    // kit StepCard: kicker, segmented progress line (the current step lit), sentence
    return (
      <section className="bf-card bf-step-card bf-enter" data-bf-avoid key={step.n}>
        <p className="bf-card__kicker">
          Step {step.n} of {steps.length}
        </p>
        <div className="bf-progress" aria-hidden="true">
          {steps.map((st, i) => (
            <span key={i} className={`bf-progress__segment${st === step ? ' bf-progress__segment--active' : ''}`} />
          ))}
        </div>
        <p className="bf-card__body">{step.text}</p>
      </section>
    );
  }
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
  ['A', 'analyse this (stage, parts just apart)'],
  ['E', 'explode this'],
  ['R', 'reset'],
  ['D', 'this panel'],
  ['F', 'freeze frame'],
  ['S', 'next step'],
  ['M', 'tracking mode'],
  ['< >', 'previous / next part'],
  ['click', 'pick a part'],
  ['drag', 'turn the model (stage)'],
  ['wheel', 'open / close it (stage)'],
];

const SLIDERS: { key: 'pressOn' | 'pressOff' | 'extendOn'; label: string; min: number; max: number; step: number }[] = [
  { key: 'pressOn', label: 'Press starts above', min: 0.1, max: 3, step: 0.05 },
  { key: 'pressOff', label: 'Press ends below', min: 0, max: 1.5, step: 0.05 },
  { key: 'extendOn', label: 'Lift (extend) above', min: 0.2, max: 4, step: 0.05 },
];

/**
 * Hand tuning (debug panel only): the three press thresholds and the left/right swap, live and
 * saved in localStorage. Watch "peak" per finger in the text panel while typing: a good press
 * threshold sits between the peaks of real presses and of fingers that only ride along.
 */
function TuningPanel() {
  const [t, setT] = useState<HandTuning>(() => ({ ...handTuning }));
  const update = (patch: Partial<HandTuning>) => {
    setHandTuning(patch);
    setT({ ...handTuning });
  };
  const url = `?press=${t.pressOn.toFixed(2)}&release=${t.pressOff.toFixed(2)}&extend=${t.extendOn.toFixed(2)}${t.swapHandedness ? '' : '&hands=raw'}`;
  return (
    <div className="bf-tuning" data-xr-ui>
      <div className="bf-tuning-title">Hand tuning (hand sizes per second)</div>
      {SLIDERS.map((sl) => (
        <label key={sl.key}>
          <span>
            {sl.label} <b>{t[sl.key].toFixed(2)}</b>
          </span>
          <input
            type="range"
            min={sl.min}
            max={sl.max}
            step={sl.step}
            value={t[sl.key]}
            onChange={(e: ChangeEvent<HTMLInputElement>) => update({ [sl.key]: Number(e.target.value) } as Partial<HandTuning>)}
          />
        </label>
      ))}
      <label className="bf-tuning-row">
        <input
          type="checkbox"
          checked={t.swapHandedness}
          onChange={(e: ChangeEvent<HTMLInputElement>) => update({ swapHandedness: e.target.checked })}
        />
        <span>Swap left / right (camera not mirrored)</span>
      </label>
      <div className="bf-tuning-row">
        <button type="button" onClick={() => update({ ...HAND_TUNING_DEFAULTS })}>
          Defaults
        </button>
        <code>{url}</code>
      </div>
    </div>
  );
}

type NumKey = { [K in keyof GestureTuning]: GestureTuning[K] extends number ? K : never }[keyof GestureTuning];
type BoolKey = { [K in keyof GestureTuning]: GestureTuning[K] extends boolean ? K : never }[keyof GestureTuning];

const GESTURE_SLIDERS: { key: NumKey; label: string; min: number; max: number; step: number }[] = [
  { key: 'pinchOn', label: 'Pinch starts below (hand sizes)', min: 0.05, max: 0.6, step: 0.01 },
  { key: 'pinchOff', label: 'Pinch ends above (hand sizes)', min: 0.1, max: 0.9, step: 0.01 },
  { key: 'holdMs', label: 'Hold before it counts (ms)', min: 0, max: 300, step: 5 },
  { key: 'releaseMs', label: 'Open before release (ms)', min: 0, max: 300, step: 5 },
  { key: 'restOpenMin', label: 'Other fingers open at least (not a fist)', min: 0.5, max: 1.6, step: 0.01 },
  { key: 'rotGain', label: 'Turn (radians per hand size dragged)', min: 0.2, max: 3, step: 0.05 },
  { key: 'spreadGain', label: 'Open per doubling of the two-hand distance', min: 0.2, max: 2, step: 0.05 },
  { key: 'fistMax', label: 'Fist at or below (openness)', min: 0.5, max: 1.4, step: 0.01 },
  { key: 'spreadMin', label: 'Spread at or above (openness)', min: 1.1, max: 2.1, step: 0.01 },
  { key: 'burstMs', label: 'Fist to spread within (ms)', min: 150, max: 1000, step: 10 },
];

const GESTURE_TOGGLES: { key: BoolKey; label: string }[] = [
  { key: 'enabled', label: 'Hand gestures on' },
  { key: 'twoHand', label: 'Two hands pinch and pull apart to open' },
  { key: 'burst', label: 'Fist opening quickly opens (closing collapses)' },
];

/** Gesture tuning (debug panel only): every threshold live, saved in localStorage, URL-overridable. */
function GestureTuningPanel() {
  const [t, setT] = useState<GestureTuning>(() => ({ ...gestureTuning }));
  const update = (patch: Partial<GestureTuning>) => {
    setGestureTuning(patch);
    setT({ ...gestureTuning });
  };
  return (
    <div className="bf-tuning" data-xr-ui>
      <div className="bf-tuning-title">Gesture tuning</div>
      {GESTURE_TOGGLES.map((tg) => (
        <label className="bf-tuning-row" key={tg.key}>
          <input type="checkbox" checked={t[tg.key]} onChange={(e: ChangeEvent<HTMLInputElement>) => update({ [tg.key]: e.target.checked } as Partial<GestureTuning>)} />
          <span>{tg.label}</span>
        </label>
      ))}
      {GESTURE_SLIDERS.map((sl) => (
        <label key={sl.key}>
          <span>
            {sl.label} <b>{sl.step >= 1 ? Math.round(t[sl.key]) : t[sl.key].toFixed(2)}</b>
          </span>
          <input
            type="range"
            min={sl.min}
            max={sl.max}
            step={sl.step}
            value={t[sl.key]}
            onChange={(e: ChangeEvent<HTMLInputElement>) => update({ [sl.key]: Number(e.target.value) } as Partial<GestureTuning>)}
          />
        </label>
      ))}
      <div className="bf-tuning-row">
        <button type="button" onClick={() => update({ ...GESTURE_TUNING_DEFAULTS })}>
          Defaults
        </button>
        <code>?{gestureTuningUrl(t)}</code>
      </div>
    </div>
  );
}

/** Debug-panel lines for the gesture recogniser: mode, last events, per-hand values. */
function gestureLines(now: number): string[] {
  const out = gestureLive.out;
  const lines: string[] = [];
  const ago = gestureLive.lastAt ? `${((now - gestureLive.lastAt) / 1000).toFixed(1)}s ago` : '';
  lines.push(`gestures ${gestureTuning.enabled ? 'on' : 'OFF'} | mode ${out?.mode ?? '-'} | last ${gestureLive.last} ${ago}`);
  for (const h of out?.hands ?? []) {
    const state = h.pinched ? (h.stale ? 'PINCH (let go first)' : 'PINCH') : '     ';
    lines.push(
      `  ${h.id.padEnd(10)} pinch ${h.pinchDist.toFixed(2)}  open ${h.open.toFixed(2)}  rest ${h.restOpen.toFixed(2)}  ${h.openState.padEnd(6)} ${state}`,
    );
  }
  return lines;
}

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
  const yaw = useStore((s) => s.modelYaw);
  const pitch = useStore((s) => s.modelPitch);
  if (!visible) return null;
  const st = live.stats;
  const lines: string[] = [];
  lines.push(
    `render ${st.renderFps.toFixed(1)} fps | objects ${st.objMs.toFixed(1)} ms | hands ${st.handMs.toFixed(1)} ms | faces ${st.faceMs.toFixed(1)} ms${MOCK_MODE ? ' | MOCK' : ''}`,
  );
  lines.push(`overlay ${overlayOn ? 'ON' : 'off'} | tracking ${mode}${frozen ? ' (FROZEN)' : ''} | explode ${explode.toFixed(2)} | teardown ${tdStatus}`);
  const deg = (r: number) => `${Math.round((r * 180) / Math.PI)}\u00b0`;
  lines.push(`model yaw ${deg(yaw)} pitch ${deg(pitch)} | input ${modelControl.describe()}`);
  lines.push(`look ${LOOK === 'kit' ? 'kit (Figma Make interface kit, #86; ?look=classic for the previous look)' : 'classic (?look=classic; drop it for the Figma Make kit)'}`);
  lines.push(...gestureLines(performance.now()));
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
  for (const f of live.faces) {
    const head = f.headYaw === null || f.headPitch === null ? '' : `  head yaw ${f.headYaw.toFixed(0)}\u00b0 pitch ${f.headPitch.toFixed(0)}\u00b0`;
    const eyes = f.eyes.map((e) => `${e.side} ${e.open ? 'open' : 'closed'} ${e.looking}`).join(', ');
    lines.push(`face ${f.slot}  ${(f.outline.w * 100).toFixed(0)}% wide  eyes: ${eyes}${head}`);
  }
  for (const h of live.hands) {
    lines.push(`${h.id}  size ${h.handSize.toFixed(0)}px  active: ${h.activeFinger ?? '-'}`);
    for (const f of FINGERS) {
      const d = h.dyn[f];
      lines.push(
        `  ${f.padEnd(7)} curl ${d.curl.toFixed(2)}  v ${d.signal >= 0 ? ' ' : ''}${d.signal.toFixed(2)}  peak ${d.peak.toFixed(2)}  ${d.pressing ? 'PRESS' : '     '} ${d.extending ? 'EXT' : ''}`,
      );
    }
  }
  if (log.length) {
    lines.push('log:');
    for (const l of log) lines.push(`  ${(l.t / 1000).toFixed(1)}s ${l.level === 'info' ? '' : `[${l.level}] `}${l.text}`);
  }
  lines.push('keys: ' + KEYS.map(([k, v]) => `${k} ${v}`).join(' | '));
  return (
    <>
      <div className="bf-debug">{lines.join('\n')}</div>
      <div className="bf-tuning-col" data-xr-ui>
        <TuningPanel />
        <GestureTuningPanel />
      </div>
    </>
  );
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
