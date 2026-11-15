/**
 * Where the voice turn is (always tracked): 'thinking' from the wearer's final words until Blowfish
 * has answered, 'speaking' while it speaks, else 'listening'. The noise gate (voiceGate.ts) is
 * stricter while it thinks and speaks.
 *
 * The hard command lock (`?lock=1`, off by default since Rio found it too harsh): the microphone
 * stays muted from the wearer's final words until Blowfish has answered, and while it speaks.
 *
 * "Answered" = the agent has spoken and finished (plus a short tail), or has been quiet for a while
 * after its last tool call or message, or at the latest after LOCK_MAX_MS. Holding Space or a mouse
 * side button (push-to-talk) always opens the microphone.
 */
import { devLog } from '../hud/hudStore';
import { usePtt } from './pushToTalk';

/** After the agent stops speaking, the microphone opens again this much later (ms): its own echo dies away. */
const TAIL_MS = 400;
/** No speech yet, but a tool ran or a message came: open again after this much quiet (ms). */
const QUIET_AFTER_ACTIVITY_MS = 2500;
/** Nothing at all from the agent after the command: open again after this long (ms). */
const NO_ANSWER_MS = 8000;
/** Never locked longer than this (ms). */
const LOCK_MAX_MS = 25000;
const POLL_MS = 100;

function readEnabled(): boolean {
  try {
    const v = new URLSearchParams(window.location.search).get('lock');
    return v !== null && /^(1|true|on|yes)$/i.test(v);
  } catch {
    return false;
  }
}

export const LOCK_COMMANDS = readEnabled();

const st = {
  /** a command is locked in and not answered yet */
  pending: false,
  /** the agent is speaking right now */
  speaking: false,
  lockedAt: 0,
  lastActivityAt: 0,
  sawActivity: false,
  sawSpeech: false,
  speechEndedAt: 0,
  timer: 0,
};

function apply(): void {
  const locked = LOCK_COMMANDS && (st.pending || st.speaking);
  if (usePtt.getState().locked !== locked) usePtt.getState().setLocked(locked);
}

function poll(): void {
  if (!st.pending) {
    window.clearInterval(st.timer);
    st.timer = 0;
    return;
  }
  const now = performance.now();
  const answered = st.sawSpeech && !st.speaking && now - st.speechEndedAt >= TAIL_MS;
  const quiet = !st.speaking && now - st.lastActivityAt >= (st.sawActivity ? QUIET_AFTER_ACTIVITY_MS : NO_ANSWER_MS);
  const tooLong = now - st.lockedAt >= LOCK_MAX_MS;
  if (answered || quiet || tooLong) {
    st.pending = false;
    apply();
    if (!answered && LOCK_COMMANDS) devLog(`Voice: microphone open again (${tooLong ? 'locked too long' : 'no spoken answer'})`);
  }
}

/** The agent has the wearer's words (final user transcript): mute until it has answered (?lock=1). */
export function lockOnCommand(): void {
  const now = performance.now();
  st.pending = true;
  st.lockedAt = now;
  st.lastActivityAt = now;
  st.sawActivity = false;
  st.sawSpeech = false;
  apply();
  if (!st.timer) st.timer = window.setInterval(poll, POLL_MS);
}

/** A tool call or an agent message: the agent is working on the command. */
export function noteAgentActivity(): void {
  st.lastActivityAt = performance.now();
  st.sawActivity = true;
}

/** The agent started or stopped speaking (onModeChange). */
export function noteAgentSpeaking(speaking: boolean): void {
  const now = performance.now();
  if (speaking) {
    st.sawSpeech = true;
  } else if (st.speaking) {
    st.speechEndedAt = now;
  }
  st.speaking = speaking;
  st.lastActivityAt = now;
  if (speaking) st.sawActivity = true;
  apply();
}

/** Session over: everything open again. */
export function releaseLock(): void {
  st.pending = false;
  st.speaking = false;
  apply();
}

/** Where the turn is now. */
export function voicePhase(): 'thinking' | 'speaking' | 'listening' {
  return st.speaking ? 'speaking' : st.pending ? 'thinking' : 'listening';
}

/** For the debug panel. */
export function describeLock(): string {
  const phase = voicePhase();
  if (!LOCK_COMMANDS) return `voice: ${phase} (hard lock off; ?lock=1 mutes while thinking and speaking)`;
  return st.pending ? 'command locked in: microphone muted until Blowfish answers' : st.speaking ? 'Blowfish speaking: microphone muted' : 'listening';
}
