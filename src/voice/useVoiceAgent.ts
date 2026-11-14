/**
 * Wraps the ElevenLabs React SDK (@elevenlabs/react 1.x, provider style per the current docs):
 * <VoiceProvider> (ConversationProvider) takes the client tools and callbacks below, and this hook
 * calls useConversation() inside it for status, startSession and the send methods.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useConversation } from '@elevenlabs/react';
import { useStore, type VoiceStatus } from '../state/store';
import { api, ApiError } from '../lib/api';
import { describeTeardown } from '../lib/flow';
import { clientTools } from './clientTools';
import { registerVoiceBridge, voiceBridge } from './bridge';

const errorListeners = new Set<(msg: string) => void>();
const emitError = (msg: string) => errorListeners.forEach((fn) => fn(msg));

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

/** ConversationProvider props. Module-level so the functions are stable. */
export const voiceOptions = {
  clientTools,
  onConnect: () => {
    useStore.getState().setVoiceStatus('connected');
  },
  onDisconnect: () => {
    registerVoiceBridge(null);
    useStore.getState().setVoiceStatus('disconnected');
    useStore.getState().setAgentSpeaking(false);
  },
  // SDK 1.x payload: { message, role: 'user' | 'agent', source: 'user' | 'ai' (deprecated), event_id, ... }
  onMessage: (m: unknown) => {
    const o = asRecord(m);
    const text = typeof o.message === 'string' ? o.message : '';
    if (!text.trim()) return;
    const who = o.role ?? o.source;
    useStore.getState().addTranscript({ role: who === 'user' ? 'user' : 'agent', text });
  },
  onModeChange: (m: unknown) => {
    const mode = typeof m === 'string' ? m : asRecord(m).mode;
    useStore.getState().setAgentSpeaking(mode === 'speaking');
  },
  onError: (...args: unknown[]) => {
    console.error('[voice] error', ...args);
    const first = args[0];
    emitError(first instanceof Error ? first.message : typeof first === 'string' ? first : 'Voice error');
  },
};

const toVoiceStatus = (s: string): VoiceStatus =>
  s === 'connected' ? 'connected' : s === 'connecting' ? 'connecting' : 'disconnected';

export function useVoiceAgent() {
  const conversation = useConversation();
  const ref = useRef(conversation);
  ref.current = conversation;

  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);

  useEffect(() => {
    errorListeners.add(setError);
    return () => {
      errorListeners.delete(setError);
    };
  }, []);

  // Show "Voice not configured yet" before anyone clicks the mic.
  useEffect(() => {
    let alive = true;
    api
      .health()
      .then((h) => {
        if (alive && !h.keys.elevenlabs) setNotConfigured(true);
      })
      .catch(() => {
        /* server not up yet; start() reports it */
      });
    return () => {
      alive = false;
    };
  }, []);

  const status = conversation.status;
  const isSpeaking = conversation.isSpeaking;

  // Mirror SDK state into the store (callbacks also do this; this covers SDKs that skip them).
  useEffect(() => {
    const vs = toVoiceStatus(status);
    if (vs === 'connected') {
      registerVoiceBridge({
        sendUserMessage: (t) => ref.current.sendUserMessage(t),
        sendContextualUpdate: (t) => ref.current.sendContextualUpdate(t),
      });
    } else {
      registerVoiceBridge(null);
    }
    // Do not overwrite our own 'connecting' while the SDK still reports disconnected.
    if (!(vs === 'disconnected' && useStore.getState().voiceStatus === 'connecting')) {
      useStore.getState().setVoiceStatus(vs);
    }
    if (vs === 'connected') {
      const td = useStore.getState().teardown;
      if (td) voiceBridge.sendContextualUpdate(describeTeardown(td));
    }
  }, [status]);

  useEffect(() => {
    useStore.getState().setAgentSpeaking(Boolean(isSpeaking));
  }, [isSpeaking]);

  const start = useCallback(async () => {
    setError(null);
    let signedUrl: string;
    try {
      signedUrl = (await api.agentToken()).signed_url;
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) {
        setNotConfigured(true);
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    setNotConfigured(false);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    } catch {
      setError('Microphone permission denied.');
      return;
    }
    useStore.getState().setVoiceStatus('connecting');
    try {
      // Signed URLs are for WebSocket sessions.
      await ref.current.startSession({ signedUrl, connectionType: 'websocket' });
    } catch (err) {
      useStore.getState().setVoiceStatus('disconnected');
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const stop = useCallback(async () => {
    try {
      await ref.current.endSession();
    } finally {
      registerVoiceBridge(null);
      useStore.getState().setVoiceStatus('disconnected');
      useStore.getState().setAgentSpeaking(false);
    }
  }, []);

  return { start, stop, error, notConfigured };
}
