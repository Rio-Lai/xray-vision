/**
 * Noisy-room fallbacks for the voice session (issue #18). Nothing here is drawn on screen except the
 * pill text "Hold to talk" (VoiceBar) while push-to-talk is the only way to talk.
 *
 * Push-to-talk: hold Space, or hold a side button of a wireless mouse (middle, back or forward;
 * left click stays the part picker), to unmute the microphone.
 *   - Normal mode: the mic is always open; holding does nothing extra.
 *   - Push-to-talk only (`?ptt=1`, or press P to toggle; remembered in this browser): the mic is
 *     muted except while the key or button is held.
 *
 * Microphone: `?mic=<part of the device name>` (for example `?mic=c920` for the webcam on the cap),
 * or press \ to cycle through the microphones; remembered in this browser. Changes take effect at
 * once if a session is running.
 *
 * Settings and changes are logged in the hidden debug panel (D).
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import { devLog } from '../hud/hudStore';

const KEY_PTT = 'blowfish.ptt';
const KEY_MIC = 'blowfish.mic';

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* private window: the setting lasts until reload */
  }
}
function urlParam(name: string): string | null {
  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch {
    return null;
  }
}

function initialPttOnly(): boolean {
  const fromUrl = urlParam('ptt');
  if (fromUrl !== null) {
    const on = /^(1|true|on|yes)$/i.test(fromUrl);
    write(KEY_PTT, on ? '1' : '0');
    return on;
  }
  return read(KEY_PTT) === '1';
}

function initialMic(): string | null {
  const fromUrl = urlParam('mic');
  if (fromUrl !== null) {
    write(KEY_MIC, fromUrl.trim() || null);
    return fromUrl.trim() || null;
  }
  return read(KEY_MIC);
}

interface PttState {
  /** true = the mic is muted unless the talk key or button is held. */
  pttOnly: boolean;
  /** true while Space or a mouse side button is held. */
  held: boolean;
  /** Device id or part of a device label; null = the browser's default microphone. */
  mic: string | null;
  /** A command is locked in, or Blowfish is speaking (voiceLock.ts, ?lock=1): muted unless the talk key is held. */
  locked: boolean;
  /** The noise gate is shut (voiceGate.ts): only background noise right now, so the agent hears silence. */
  gated: boolean;
  setPttOnly: (on: boolean) => void;
  setLocked: (locked: boolean) => void;
  setGated: (gated: boolean) => void;
  setHeld: (held: boolean) => void;
  setMic: (mic: string | null) => void;
}

export const usePtt = create<PttState>((set) => ({
  pttOnly: initialPttOnly(),
  held: false,
  mic: initialMic(),
  locked: false,
  gated: false,
  setLocked: (locked) => set({ locked }),
  setGated: (gated) => set({ gated }),
  setPttOnly: (pttOnly) => {
    write(KEY_PTT, pttOnly ? '1' : '0');
    set({ pttOnly });
  },
  setHeld: (held) => set({ held }),
  setMic: (mic) => {
    write(KEY_MIC, mic);
    set({ mic });
  },
}));

/** true when push-to-talk alone mutes the mic right now (the pill then says "Hold to talk"). */
export const shouldMute = (s: Pick<PttState, 'pttOnly' | 'held'>) => s.pttOnly && !s.held;
/** true when the mic is muted right now: push-to-talk, a locked-in command (voiceLock.ts) or the noise gate (voiceGate.ts); holding always talks. */
export const micMutedNow = (s: Pick<PttState, 'pttOnly' | 'held' | 'locked' | 'gated'>) => !s.held && (s.pttOnly || s.locked || s.gated);

async function microphones(): Promise<MediaDeviceInfo[]> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
  } catch {
    return [];
  }
}

/**
 * The deviceId to pass to startSession, or undefined for the default microphone.
 * Call after microphone permission was granted (labels are empty before that).
 */
export async function resolveInputDeviceId(): Promise<string | undefined> {
  const want = usePtt.getState().mic;
  if (!want) return undefined;
  const mics = await microphones();
  const q = want.toLowerCase();
  const hit = mics.find((d) => d.deviceId === want) ?? mics.find((d) => d.label.toLowerCase().includes(q));
  if (!hit) {
    devLog(`Microphone "${want}" not found; using the default`, 'warn');
    return undefined;
  }
  devLog(`Microphone: ${hit.label || hit.deviceId}`);
  return hit.deviceId;
}

/** Next microphone in the list (wraps to the browser default). */
async function cycleMic(): Promise<void> {
  const mics = await microphones();
  if (mics.length === 0) {
    devLog('No microphones found (allow microphone access first)', 'warn');
    return;
  }
  const cur = usePtt.getState().mic;
  const idx = mics.findIndex((d) => d.deviceId === cur);
  const next = idx + 1 < mics.length ? mics[idx + 1] : null;
  usePtt.getState().setMic(next ? next.deviceId : null);
  devLog(`Microphone: ${next ? next.label || next.deviceId : 'browser default'}`);
}

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** Mouse buttons that count as "talk": middle (1), back (3), forward (4). Left click (0) picks parts. */
const TALK_BUTTONS = new Set([1, 3, 4]);

interface Controls {
  connected: boolean;
  setMuted: (muted: boolean) => void;
  changeInputDevice: (config: { inputDeviceId?: string }) => Promise<void>;
}

/** Wires the hidden keys and mouse buttons, and keeps the session's mute and mic in step with them. */
export function usePushToTalk({ connected, setMuted, changeInputDevice }: Controls) {
  const pttOnly = usePtt((s) => s.pttOnly);
  const held = usePtt((s) => s.held);
  const locked = usePtt((s) => s.locked);
  const gated = usePtt((s) => s.gated);
  const mic = usePtt((s) => s.mic);

  // Mute follows the setting, the held key, the command lock and the noise gate.
  useEffect(() => {
    if (!connected) return;
    try {
      setMuted(micMutedNow({ pttOnly, held, locked, gated }));
    } catch (err) {
      console.warn('[voice] setMuted failed', err);
    }
  }, [connected, pttOnly, held, locked, gated, setMuted]);

  // A new microphone choice applies to a running session at once.
  useEffect(() => {
    if (!connected) return;
    let alive = true;
    void (async () => {
      const inputDeviceId = await resolveInputDeviceId();
      if (!alive) return;
      try {
        await changeInputDevice(inputDeviceId ? { inputDeviceId } : {});
      } catch (err) {
        console.warn('[voice] changeInputDevice failed', err);
      }
    })();
    return () => {
      alive = false;
    };
    // Only when the choice changes while connected; startSession already used the current one.
  }, [mic]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const ptt = usePtt.getState;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      if (e.code === 'Space') {
        e.preventDefault(); // no page scroll
        if (!e.repeat && !ptt().held) ptt().setHeld(true);
        return;
      }
      if (e.repeat) return;
      if (e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        const on = !ptt().pttOnly;
        ptt().setPttOnly(on);
        devLog(on ? 'Push-to-talk only: hold Space or a mouse side button to talk' : 'Push-to-talk off: microphone always open');
      } else if (e.key === '\\') {
        e.preventDefault();
        void cycleMic();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || isTypingTarget(e.target)) return;
      e.preventDefault(); // a focused button (the voice pill) would otherwise be clicked
      if (ptt().held) ptt().setHeld(false);
    };
    const onMouseDown = (e: MouseEvent) => {
      if (!TALK_BUTTONS.has(e.button)) return;
      e.preventDefault(); // no autoscroll or browser back/forward
      ptt().setHeld(true);
    };
    const onMouseUp = (e: MouseEvent) => {
      if (!TALK_BUTTONS.has(e.button)) return;
      e.preventDefault();
      ptt().setHeld(false);
    };
    // Back/forward buttons would otherwise navigate away from the app.
    const onAuxClick = (e: MouseEvent) => {
      if (TALK_BUTTONS.has(e.button)) e.preventDefault();
    };
    const release = () => ptt().held && ptt().setHeld(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('auxclick', onAuxClick);
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('auxclick', onAuxClick);
      window.removeEventListener('blur', release);
    };
  }, []);
}
