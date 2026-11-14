/**
 * /arm-demo: the X-ray arm on its own, playing the typing trace over a plain background.
 * Our fallback if live tracking or anything else breaks during the pitch.
 *
 * Buttons: Explode, steps 1-6, Reset, and "What muscles is this arm using?", which runs the same flow as the
 * voice agent (get_pose -> explode -> show_step 1..6). Keys: E explode, 1-6 steps, R reset, F freeze, Space = ask.
 * Previews: ?capture=assembled | exploded | pulse | step&n=3  (sets document.title = 'ready' when drawn).
 */
import { useEffect, useRef, useState } from 'react';
import { useArmStore } from './armStore';
import { ArmXrayView } from './ArmXrayView';
import { armExplode, armPose, armReset, armShowStep } from './tour';
import { startReplay, stopReplay } from './trace';
import { loadArmTeardown, type ArmTeardown } from './types';

const q = new URLSearchParams(location.search);
const capture = q.get('capture');

const btn: React.CSSProperties = {
  font: '600 14px -apple-system, Helvetica, sans-serif',
  padding: '9px 14px',
  borderRadius: 10,
  border: '1px solid rgba(230,247,255,0.25)',
  background: 'rgba(20,32,46,0.85)',
  color: '#e6f7ff',
  cursor: 'pointer',
};

export default function ArmDemo() {
  const s = useArmStore();
  const [td, setTd] = useState<ArmTeardown | null>(null);
  const [caption, setCaption] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const cancelTour = useRef(false);

  useEffect(() => {
    loadArmTeardown().then(setTd);
    useArmStore.getState().setActive(true);
    let stop: (() => void) | undefined;
    const pausedAt = capture ? Number(q.get('at') ?? 2400) : undefined;
    // capture modes run after the replay has fed the detector (so "typing" and its glowing parts are known)
    (async () => {
      stop = await startReplay(undefined, { pausedAt });
      if (capture === 'exploded') await armExplode(1);
      if (capture === 'step') await armShowStep(Number(q.get('n') ?? 1));
      if (capture === 'pulse') {
        await armExplode(1);
        await armShowStep(4); // tendons: the sliding one is easiest to see
      }
    })();
    return () => {
      stop?.();
      stopReplay();
    };
  }, []);

  // pulse preview: keep one fresh index-finger press "60 ms ago" so the frame shows the pulse at its peak
  useEffect(() => {
    if (capture !== 'pulse') return;
    const id = setInterval(() => {
      const t = performance.now() - 60;
      useArmStore.setState({ keystrokes: [{ finger: 'index', kind: 'press', t }, { finger: 'middle', kind: 'lift', t: t - 20 }] });
    }, 30);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (capture === 'step' && td) {
      const st = td.steps.find((x) => x.n === Number(q.get('n') ?? 1));
      if (st) setCaption(`${st.n}. ${td.layers_legend[String(st.layer_focus)]}: ${st.text}`);
    }
  }, [td]);

  const ask = async () => {
    if (busy) return;
    setBusy(true);
    cancelTour.current = false;
    const pose = await armPose();
    if (pose.activity !== 'typing') {
      setCaption('I cannot see typing yet. Type for a moment and ask again.');
      setBusy(false);
      return;
    }
    setCaption(`This arm is typing (confidence ${Math.round(pose.confidence * 100)}%). ${pose.summary}`);
    await armExplode(1);
    await sleep(3500);
    for (let n = 1; n <= 6 && !cancelTour.current; n++) {
      const r = await armShowStep(n);
      if (r.ok) setCaption(`${n}. ${r.layer}: ${r.text}`);
      await sleep(6000);
    }
    if (!cancelTour.current && td) setCaption(td.activities.typing.clinical_note);
    setBusy(false);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'e' || e.key === 'E') armExplode(useArmStore.getState().explode > 0.5 ? 0 : 1);
      if (/^[1-6]$/.test(e.key)) armShowStep(Number(e.key));
      if (e.key === 'r' || e.key === 'R') reset();
      if (e.key === 'f' || e.key === 'F') useArmStore.getState().setFrozen(!useArmStore.getState().frozen);
      if (e.key === ' ') ask();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  const reset = () => {
    cancelTour.current = true;
    armReset();
    setCaption('');
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'radial-gradient(ellipse at 40% 35%, #1d2a3b 0%, #0a0f17 75%)', overflow: 'hidden' }}>
      <ArmXrayView
        landmarks={s.frame}
        explode={s.explode}
        layerFocus={s.layerFocus}
        highlight={s.highlight}
        activity={s.activity}
        keystrokes={s.keystrokes}
        frozen={s.frozen}
        onReady={() => setTimeout(() => (document.title = 'ready'), 1800)}
      />
      {!capture && (
        <div style={{ position: 'absolute', left: 16, right: 16, top: 16, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button style={{ ...btn, background: '#ffd27a', color: '#1a1206' }} onClick={ask} disabled={busy}>
            What muscles is this arm using?
          </button>
          <button style={btn} onClick={() => armExplode(s.explode > 0.5 ? 0 : 1)}>
            {s.explode > 0.5 ? 'Collapse' : 'Explode'}
          </button>
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <button key={n} style={{ ...btn, outline: s.step === n ? '2px solid #ffd27a' : undefined }} onClick={() => armShowStep(n)}>
              {n}
            </button>
          ))}
          <button style={btn} onClick={reset}>
            Reset
          </button>
          <span style={{ color: '#9fb3c8', font: '13px -apple-system, Helvetica, sans-serif', marginLeft: 8 }}>
            {s.activity === 'typing' ? `typing · ${Math.round(s.confidence * 100)}%` : 'no typing detected'} · {s.source}
            {s.frozen ? ' · frozen' : ''}
          </span>
        </div>
      )}
      {caption && (
        <div
          style={{
            position: 'absolute',
            left: '50%',
            bottom: 28,
            transform: 'translateX(-50%)',
            maxWidth: 'min(860px, calc(100% - 32px))',
            padding: '12px 18px',
            borderRadius: 12,
            background: 'rgba(10,18,28,0.85)',
            color: '#e6f7ff',
            font: '500 17px/1.45 -apple-system, Helvetica, sans-serif',
            textAlign: 'center',
          }}
        >
          {caption}
        </div>
      )}
      {td && (
        <div style={{ position: 'absolute', right: 16, bottom: 16, color: '#7f93a8', font: '12px -apple-system, Helvetica, sans-serif' }}>{td.notice}</div>
      )}
    </div>
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
