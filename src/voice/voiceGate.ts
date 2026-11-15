/**
 * Noise gate for the voice session (Rio, 15 Nov): Blowfish keeps listening while it thinks and
 * speaks (so the wearer can talk over it), but background noise, a cough or someone talking across
 * the room no longer counts as speech and cancels the answer.
 *
 * How: the wearer's microphone is close to the mouth (the webcam on the cap), so the wearer is much
 * louder at the mic than the room. A second, analysis-only stream of the same microphone (echo
 * cancellation and noise suppression on, so Blowfish's own voice and steady hum count less) is
 * measured every POLL_MS: its level in dBFS against the room's noise floor (the 20th percentile of
 * the last FLOOR_WINDOW_MS). The agent's microphone is open only while the level is MARGIN_DB or more
 * above the floor (and for HANGOVER_MS after, so the ends of words and the gaps between them get
 * through); otherwise it is muted and ElevenLabs hears silence. The bar is THINKING_EXTRA_DB higher
 * while Blowfish is working on a command and SPEAKING_EXTRA_DB higher while it speaks, and then the
 * sound must also last SUSTAIN_MS before the microphone opens (short bangs never interrupt it)
 * (voiceLock.ts voicePhase): only a clear, close voice interrupts then. The bar always stays between
 * MIN_DB and MAX_DB, so a very quiet room still needs real speech and a very loud one never shuts
 * the wearer out.
 *
 * Fails open: no microphone for the gate, a suspended audio context, or no signal at all leaves the
 * agent's microphone open (as before the gate). Holding Space or a mouse side button always talks.
 * `?gate=0` turns it off; `?gatedb=12` sets MARGIN_DB, `?gatespeak=12` the extra while it speaks. `?lock=1` (the hard lock) replaces it.
 * The level, floor and bar are in the debug panel (D).
 */
import { devLog } from '../hud/hudStore';
import { PHONE_MODE } from '../camera/frame';
import { resolveInputDeviceId, usePtt } from './pushToTalk';
import { LOCK_COMMANDS, voicePhase } from './voiceLock';

function param(name: string): string | null {
  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch {
    return null;
  }
}

const gateParam = param('gate');
/** Phone mode (?phone=1): off. On iOS a second capture of the microphone can mute or stop the agent's own. */
export const GATE_ON = !PHONE_MODE && !LOCK_COMMANDS && !(gateParam !== null && /^(0|false|off|no)$/i.test(gateParam));
const marginParam = Number(param('gatedb'));
/** Speech must be this much above the room's noise floor (dB). */
const MARGIN_DB = Number.isFinite(marginParam) && marginParam > 0 && marginParam < 40 ? marginParam : 12;
/**
 * ...this much more while Blowfish is working on a command, and while it speaks (`?gatespeak=` sets
 * the speaking one). Raised from 6 / 4 (Rio, 15 Nov): room sounds still cut its answers off.
 */
const speakParam = Number(param('gatespeak'));
const THINKING_EXTRA_DB = 8;
const SPEAKING_EXTRA_DB = Number.isFinite(speakParam) && speakParam >= 0 && speakParam < 40 ? speakParam : 12;
/** The bar never goes below or above these (dBFS); the top is higher while Blowfish thinks or speaks. */
const MIN_DB = -62;
const MAX_DB = -30;
const MAX_DB_BUSY = -22;
/**
 * While Blowfish thinks or speaks, the sound must stay above the bar this long before the microphone
 * opens (ms): a clap, a cough or a door is over sooner; someone really talking over it is not.
 */
const SUSTAIN_MS = 180;
/** Open this long after the last loud moment (ms): word endings and short gaps get through. */
const HANGOVER_MS = 700;
/** The noise floor is the 20th percentile of the last this-many ms. */
const FLOOR_WINDOW_MS = 5000;
const POLL_MS = 30;
/** Open for the first moments, while the floor is measured (ms). */
const WARMUP_MS = 1500;
/** Below this the stream carries no sound at all (a muted or wrong device): never shut the agent out. */
const SILENT_DB = -95;

const N = Math.ceil(FLOOR_WINDOW_MS / POLL_MS);
/** (its type is the one getFloatTimeDomainData takes, whichever TypeScript lib is installed) */
const EMPTY = new Float32Array(0);

const g = {
  run: 0,
  ctx: null as AudioContext | null,
  stream: null as MediaStream | null,
  analyser: null as AnalyserNode | null,
  buf: null as typeof EMPTY | null,
  timer: 0,
  levels: new Float32Array(N),
  sorted: new Float32Array(N),
  count: 0,
  idx: 0,
  startedAt: 0,
  lastLoudAt: -1e9,
  /** since when the level has been above the bar without a break (-1 = it is below) */
  loudSince: -1,
  open: true,
  level: -120,
  floor: -120,
  bar: MIN_DB,
  peak: -120,
};

function setGated(shut: boolean): void {
  if (usePtt.getState().gated !== shut) usePtt.getState().setGated(shut);
}

function tick(): void {
  const an = g.analyser;
  const buf = g.buf;
  const ctx = g.ctx;
  if (!an || !buf || !ctx) return;
  if (ctx.state !== 'running') {
    // (a suspended context reads silence: fail open)
    g.open = true;
    setGated(false);
    void ctx.resume().catch(() => undefined);
    return;
  }
  an.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  const db = 20 * Math.log10(Math.max(1e-7, Math.sqrt(sum / buf.length)));
  g.level = db;
  g.levels[g.idx] = db;
  g.idx = (g.idx + 1) % N;
  g.count = Math.min(N, g.count + 1);

  // The noise floor (20th percentile) and the loudest moment in the window.
  const n = g.count;
  for (let i = 0; i < n; i++) g.sorted[i] = g.levels[i];
  const part = g.sorted.subarray(0, n);
  part.sort();
  g.floor = part[Math.floor(0.2 * (n - 1))];
  g.peak = part[n - 1];

  const phase = voicePhase();
  const extra = phase === 'thinking' ? THINKING_EXTRA_DB : phase === 'speaking' ? SPEAKING_EXTRA_DB : 0;
  const busy = phase !== 'listening';
  g.bar = Math.min(busy ? MAX_DB_BUSY : MAX_DB, Math.max(MIN_DB, g.floor + MARGIN_DB + extra));

  const now = performance.now();
  if (db >= g.bar) {
    if (g.loudSince < 0) g.loudSince = now;
    // (already open: any loud moment keeps it open; shut while busy: only a sustained one opens it)
    if (g.open || !busy || now - g.loudSince >= SUSTAIN_MS) g.lastLoudAt = now;
  } else {
    g.loudSince = -1;
  }
  const warm = now - g.startedAt < WARMUP_MS;
  const noSignal = g.peak < SILENT_DB;
  const open = warm || noSignal || now - g.lastLoudAt <= HANGOVER_MS;
  if (open !== g.open) g.open = open;
  setGated(!open);
}

/** Start measuring (the voice session connected, or the microphone changed). */
export async function startGate(): Promise<void> {
  if (!GATE_ON) return;
  stopGate();
  const run = ++g.run;
  try {
    const deviceId = await resolveInputDeviceId();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), echoCancellation: true, noiseSuppression: true, autoGainControl: false },
    });
    if (run !== g.run) {
      for (const t of stream.getTracks()) t.stop();
      return;
    }
    const ctx = new AudioContext();
    if (ctx.state !== 'running') await ctx.resume().catch(() => undefined);
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 2048;
    src.connect(an);
    g.ctx = ctx;
    g.stream = stream;
    g.analyser = an;
    g.buf = new Float32Array(an.fftSize);
    g.count = 0;
    g.idx = 0;
    g.startedAt = performance.now();
    g.lastLoudAt = -1e9;
    g.loudSince = -1;
    g.open = true;
    g.timer = window.setInterval(tick, POLL_MS);
    devLog(`Voice: noise gate on (speech ${MARGIN_DB} dB above the room; ?gate=0 off, ?gatedb= to change)`);
  } catch (err) {
    setGated(false);
    devLog(`Voice: noise gate off (could not open the microphone for it: ${err instanceof Error ? err.message : String(err)})`, 'warn');
  }
}

/** Stop measuring and open the agent's microphone (the session ended). */
export function stopGate(): void {
  g.run += 1;
  if (g.timer) window.clearInterval(g.timer);
  g.timer = 0;
  if (g.stream) for (const t of g.stream.getTracks()) t.stop();
  if (g.ctx) void g.ctx.close().catch(() => undefined);
  g.ctx = null;
  g.stream = null;
  g.analyser = null;
  g.buf = null;
  g.open = true;
  setGated(false);
}

// A new microphone choice: measure that one.
let lastMic = usePtt.getState().mic;
usePtt.subscribe((s) => {
  if (s.mic === lastMic) return;
  lastMic = s.mic;
  if (g.analyser) void startGate();
});

/** For the debug panel. */
export function describeGate(): string {
  if (!GATE_ON) return PHONE_MODE ? 'noise gate off (phone mode)' : LOCK_COMMANDS ? 'noise gate off (?lock=1: hard lock instead)' : 'noise gate off (?gate=0)';
  if (!g.analyser) return 'noise gate: waiting for the voice session';
  const f = (v: number) => (v <= -119 ? '-inf' : v.toFixed(0));
  return `noise gate ${g.open ? 'OPEN' : 'shut (background only)'} | level ${f(g.level)} dB, room ${f(g.floor)} dB, bar ${f(g.bar)} dB (+${MARGIN_DB}, ${voicePhase()})`;
}
