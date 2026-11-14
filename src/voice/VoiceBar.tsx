import { useState, type CSSProperties, type FormEvent } from 'react';
import { useStore } from '../state/store';
import { useVoiceAgent } from './useVoiceAgent';
import { voiceBridge } from './bridge';
import { runLocalCommand } from './localCommands';

const CYAN = '#7de3ff';

const styles: Record<string, CSSProperties> = {
  bar: {
    position: 'fixed',
    left: '50%',
    bottom: 24,
    transform: 'translateX(-50%)',
    width: 'min(760px, 92vw)',
    padding: '12px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    background: 'rgba(6, 14, 20, 0.72)',
    backdropFilter: 'blur(10px)',
    WebkitBackdropFilter: 'blur(10px)',
    border: `1px solid ${CYAN}`,
    borderRadius: 14,
    color: '#e6f7ff',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 18,
    zIndex: 50,
    pointerEvents: 'auto',
  },
  row: { display: 'flex', alignItems: 'center', gap: 12 },
  mic: {
    width: 52,
    height: 52,
    borderRadius: '50%',
    border: `2px solid ${CYAN}`,
    background: 'transparent',
    color: CYAN,
    fontSize: 22,
    cursor: 'pointer',
    flexShrink: 0,
  },
  status: { color: CYAN, fontSize: 16, letterSpacing: 1, textTransform: 'uppercase' },
  line: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  input: {
    flex: 1,
    background: 'rgba(0,0,0,0.4)',
    border: `1px solid rgba(125, 227, 255, 0.5)`,
    borderRadius: 8,
    color: '#e6f7ff',
    fontFamily: 'inherit',
    fontSize: 16,
    padding: '8px 10px',
    outline: 'none',
  },
};

export function VoiceBar() {
  const { start, stop, error, notConfigured } = useVoiceAgent();
  const voiceStatus = useStore((s) => s.voiceStatus);
  const speaking = useStore((s) => s.agentSpeaking);
  const transcript = useStore((s) => s.transcript);
  const [text, setText] = useState('');

  const connected = voiceStatus === 'connected';
  const busy = voiceStatus === 'connecting';

  const onMic = () => {
    if (connected) void stop();
    else if (!busy) void start();
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const msg = text.trim();
    if (!msg) return;
    setText('');
    const add = useStore.getState().addTranscript;
    add({ role: 'user', text: msg });
    if (connected) {
      voiceBridge.sendUserMessage(msg);
      return;
    }
    const reply = await runLocalCommand(msg);
    add({ role: 'agent', text: reply ?? 'Voice is off. Try "explode this", "step 2", "what is the battery" or "reset".' });
  };

  const statusText = notConfigured
    ? 'Voice not configured yet'
    : error
      ? `Error: ${error}`
      : connected
        ? speaking
          ? 'Tutor speaking'
          : 'Listening'
        : busy
          ? 'Connecting...'
          : 'Voice off';

  const lastTwo = transcript.slice(-2);

  return (
    <div style={styles.bar}>
      <div style={styles.row}>
        <button
          type="button"
          style={{ ...styles.mic, background: connected ? 'rgba(125,227,255,0.18)' : 'transparent' }}
          onClick={onMic}
          disabled={busy}
          aria-label={connected ? 'Stop voice' : 'Start voice'}
          title={connected ? 'Stop voice' : 'Start voice'}
        >
          {connected ? '■' : '●'}
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={styles.status}>{statusText}</div>
          {lastTwo.map((l, i) => (
            <div key={`${transcript.length}-${i}`} style={{ ...styles.line, opacity: i === lastTwo.length - 1 ? 1 : 0.6 }}>
              <span style={{ color: l.role === 'user' ? '#9fb3c8' : CYAN }}>{l.role === 'user' ? 'you' : 'tutor'}: </span>
              {l.text}
            </div>
          ))}
        </div>
      </div>
      <form style={styles.row} onSubmit={onSubmit}>
        <input
          style={styles.input}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder='Type instead of talking, e.g. "explode this"'
          // Keep typing from triggering the stage's keyboard shortcuts.
          onKeyDown={(e) => e.stopPropagation()}
        />
      </form>
    </div>
  );
}

export default VoiceBar;
