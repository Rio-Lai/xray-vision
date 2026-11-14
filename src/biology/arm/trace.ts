/**
 * Landmark feed for the arm: live (from the detection loop), replay (a recorded trace) and record.
 *
 * Both paths end in the same place: armStore.frame + detectTyping over the last 1.5 s
 * -> armStore.activity / confidence / keystrokes. So replay behaves exactly like live tracking.
 * All times are performance.now() milliseconds.
 */
import { useArmStore } from './armStore';
import { detectTyping, type HandSample } from './detectTyping';
import { ARM_TRACE_URL, type ArmFrame, type Landmark } from './types';

const history: HandSample[] = [];

function ingest(frame: ArmFrame) {
  const s = useArmStore.getState();
  if (s.frozen) return;
  s.setFrame(frame);
  if (frame.hand) {
    history.push({ t: frame.t, hand: frame.hand });
    while (history.length && history[0].t < frame.t - 2000) history.shift();
    const r = detectTyping(history, { handedness: frame.handedness ?? 'right' });
    s.setActivity(r.activity, r.confidence);
    // only keep keystrokes from the newest part of the window (older ones were reported already)
    s.pushKeystrokes(r.keystrokes.filter((k) => k.t > frame.t - 400));
  }
  if (recorder) recorder.push(frame);
}

/**
 * LIVE: call this from the detection loop each frame with MediaPipe Pose (33 landmarks) and Hand Landmarker
 * (21 landmarks) results for the same video frame. Either may be null if not detected.
 */
export function feedArmLandmarks(pose: Landmark[] | null, hand: Landmark[] | null, handedness: 'left' | 'right' = 'right') {
  if (useArmStore.getState().source !== 'live') return;
  ingest({ t: performance.now(), pose, hand, handedness });
}

/* ------------------------------ replay ------------------------------ */

export interface Trace {
  source: string;
  fps: number;
  side?: 'left' | 'right';
  frames: ArmFrame[];
}

let raf = 0;
let stopFlag = false;

/** Play a trace in a loop. Returns a stop function. `pausedAt` (ms into the trace) holds one moment (previews). */
export async function startReplay(url = ARM_TRACE_URL, opts: { pausedAt?: number } = {}): Promise<() => void> {
  stopReplay();
  const trace = (await fetch(url).then((r) => r.json())) as Trace;
  if (!trace.frames?.length) throw new Error('trace has no frames');
  useArmStore.getState().setSource('replay');
  history.length = 0;
  const dur = trace.frames[trace.frames.length - 1].t + 1000 / (trace.fps || 30);
  const t0 = performance.now();
  let i = 0;
  let loopStart = t0;
  stopFlag = false;
  // preview mode: feed the 1.5 s before `pausedAt` at once, then hold that frame
  if (opts.pausedAt !== undefined) {
    const now = performance.now();
    const at = opts.pausedAt;
    for (const f of trace.frames.filter((x) => x.t >= at - 1600 && x.t <= at)) ingest({ ...f, t: now - (at - f.t) });
    return stopReplay;
  }
  const tick = () => {
    if (stopFlag) return;
    const now = performance.now();
    let local = now - loopStart;
    if (local >= dur) {
      loopStart += dur;
      local -= dur;
      i = 0;
    }
    while (i < trace.frames.length && trace.frames[i].t <= local) {
      const f = trace.frames[i];
      ingest({ ...f, t: loopStart + f.t });
      i++;
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return stopReplay;
}

export function stopReplay() {
  stopFlag = true;
  cancelAnimationFrame(raf);
}

/* ------------------------------ record ------------------------------ */

let recorder: ArmFrame[] | null = null;

/**
 * Record ~10 s of LIVE landmarks, then download them as typing-trace.json.
 * Put the file in public/cache/arm-hand/ (replacing the synthetic one) and commit it.
 */
export function recordTrace(seconds = 10): Promise<number> {
  if (useArmStore.getState().source !== 'live') return Promise.reject(new Error('Recording needs the live feed.'));
  recorder = [];
  useArmStore.getState().setRecording(true);
  return new Promise((resolve) => {
    setTimeout(() => {
      const frames = recorder ?? [];
      recorder = null;
      useArmStore.getState().setRecording(false);
      const t0 = frames[0]?.t ?? 0;
      const out = {
        source: 'recorded',
        note: `Recorded live on ${new Date().toISOString()} from the cap rig.`,
        fps: Math.round(frames.length / seconds),
        side: frames[0]?.handedness ?? 'right',
        frames: frames.map((f) => ({ ...f, t: Math.round(f.t - t0) })),
      };
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(out)], { type: 'application/json' }));
      a.download = 'typing-trace.json';
      a.click();
      resolve(frames.length);
    }, seconds * 1000);
  });
}
