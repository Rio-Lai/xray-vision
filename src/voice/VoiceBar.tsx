/**
 * Voice UI (PROJECT.md section 2): a small frosted pill at the bottom centre showing the voice state
 * (off, listening, thinking, speaking) and subtitle-style captions above it that fade out.
 *
 * Hidden developer controls (never shown on screen):
 *   V      start / stop the voice session (same as clicking the pill)
 *   /      open the typed command box; Enter sends, Esc closes
 * A missing voice setup or an error shows as a quiet "Voice off" pill; details go to the console.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useStore, type TranscriptLine } from '../state/store';
import { useVoiceAgent } from './useVoiceAgent';
import { voiceBridge } from './bridge';
import { runLocalCommand } from './localCommands';
import { VOICE_CSS } from './voiceStyles';

type PillState = 'off' | 'connecting' | 'listening' | 'thinking' | 'speaking';

const PILL_TEXT: Record<PillState, string> = {
  off: 'Voice off',
  connecting: 'Connecting',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
};

/** After the user speaks, show "Thinking" until the agent answers, at most this long. */
const THINKING_MAX_MS = 10000;
/** How long the fade-out of a caption takes (matches .bf-vcap transition). */
const CAPTION_FADE_MS = 600;
/** At most this many captions on screen. */
const MAX_CAPTIONS = 2;

/** Captions stay longer for longer sentences: ~3 words a second, between 3.5 and 9 seconds. */
function captionMs(text: string): number {
  const words = text.trim().split(/\s+/).length;
  return Math.min(9000, Math.max(3500, words * 330 + 1500));
}

interface Caption {
  id: number;
  role: TranscriptLine['role'];
  text: string;
  fading: boolean;
}

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** Subtitle-style captions from the store transcript. Each new line appears, then fades out. */
function useCaptions(): Caption[] {
  const transcript = useStore((s) => s.transcript);
  const [captions, setCaptions] = useState<Caption[]>([]);
  const lastSeen = useRef<TranscriptLine | undefined>(transcript[transcript.length - 1]);
  const nextId = useRef(1);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    const line = transcript[transcript.length - 1];
    if (!line || line === lastSeen.current) return;
    lastSeen.current = line;
    const id = nextId.current++;
    setCaptions((cs) => [...cs, { id, role: line.role, text: line.text, fading: false }].slice(-MAX_CAPTIONS));
    const ms = captionMs(line.text);
    timers.current.push(
      window.setTimeout(() => setCaptions((cs) => cs.map((c) => (c.id === id ? { ...c, fading: true } : c))), ms),
      window.setTimeout(() => setCaptions((cs) => cs.filter((c) => c.id !== id)), ms + CAPTION_FADE_MS),
    );
  }, [transcript]);

  useEffect(
    () => () => {
      timers.current.forEach((t) => window.clearTimeout(t));
      timers.current = [];
    },
    [],
  );

  return captions;
}

/** "Thinking": connected, the agent is not speaking, and the last line was the user's (recently). */
function useThinking(connected: boolean, speaking: boolean): boolean {
  const transcript = useStore((s) => s.transcript);
  const last = transcript[transcript.length - 1];
  const waiting = connected && !speaking && last?.role === 'user';
  const [expired, setExpired] = useState<TranscriptLine | null>(null);
  useEffect(() => {
    if (!waiting || !last) return;
    const id = window.setTimeout(() => setExpired(last), THINKING_MAX_MS);
    return () => window.clearTimeout(id);
  }, [waiting, last]);
  return waiting && expired !== last;
}

export function VoiceBar() {
  const { start, stop, error, notConfigured } = useVoiceAgent();
  const voiceStatus = useStore((s) => s.voiceStatus);
  const speaking = useStore((s) => s.agentSpeaking);
  const captions = useCaptions();
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const connected = voiceStatus === 'connected';
  const busy = voiceStatus === 'connecting';
  const thinking = useThinking(connected, speaking);

  // Errors never go on screen; the pill just says "Voice off".
  useEffect(() => {
    if (error) console.warn('[voice]', error);
  }, [error]);
  useEffect(() => {
    if (notConfigured) console.info('[voice] not configured: set ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID in .env');
  }, [notConfigured]);

  const toggle = useCallback(() => {
    const vs = useStore.getState().voiceStatus;
    if (vs === 'connected') void stop();
    else if (vs !== 'connecting') void start();
  }, [start, stop]);

  // Hidden keys: V toggles voice, / opens the typed box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      if (isTypingTarget(e.target)) return;
      if (e.key === 'v' || e.key === 'V') {
        e.preventDefault();
        toggle();
      } else if (e.key === '/') {
        e.preventDefault();
        setTyping(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);

  useEffect(() => {
    if (typing) inputRef.current?.focus();
  }, [typing]);

  const closeTyping = () => {
    setTyping(false);
    setText('');
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const msg = text.trim();
    if (!msg) return;
    setText('');
    const add = useStore.getState().addTranscript;
    add({ role: 'user', text: msg });
    if (voiceBridge.isConnected()) {
      voiceBridge.sendUserMessage(msg);
      return;
    }
    const reply = await runLocalCommand(msg);
    add({ role: 'agent', text: reply ?? 'Voice is off. Try "explode this", "step 2", "what is the battery" or "reset".' });
  };

  const onInputKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    // Keep typing from triggering the stage's keyboard shortcuts.
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      closeTyping();
    }
  };

  const state: PillState = connected
    ? speaking
      ? 'speaking'
      : thinking
        ? 'thinking'
        : 'listening'
    : busy
      ? 'connecting'
      : 'off';

  return (
    <div className="bf-voice" data-xr-ui>
      <style>{VOICE_CSS}</style>

      {captions.length > 0 && (
        <div className="bf-vcaps" aria-live="polite">
          {captions.map((c) => (
            <div key={c.id} className={`bf-vcap ${c.role}${c.fading ? ' fading' : ''}`}>
              {c.text}
            </div>
          ))}
        </div>
      )}

      {typing && (
        <form onSubmit={onSubmit}>
          <input
            ref={inputRef}
            className="bf-vtype bf-vglass"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onInputKey}
            onBlur={closeTyping}
            placeholder='Type a command, e.g. "explode this"'
            aria-label="Typed command"
          />
        </form>
      )}

      <button
        type="button"
        className={`bf-vpill bf-vglass ${state}`}
        onClick={toggle}
        aria-label={connected ? 'Stop voice' : 'Start voice'}
      >
        <span className="bf-vicon" aria-hidden="true">
          {state === 'speaking' ? (
            <>
              <span className="bf-vbar" />
              <span className="bf-vbar" />
              <span className="bf-vbar" />
              <span className="bf-vbar" />
              <span className="bf-vbar" />
            </>
          ) : state === 'thinking' ? (
            <>
              <span className="bf-vthink" />
              <span className="bf-vthink" />
              <span className="bf-vthink" />
            </>
          ) : (
            <span className="bf-vdot" />
          )}
        </span>
        {PILL_TEXT[state]}
      </button>
    </div>
  );
}

export default VoiceBar;
