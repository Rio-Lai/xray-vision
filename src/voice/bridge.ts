/**
 * Module-level bridge to the live ElevenLabs session, so non-React code (lib/flow.ts)
 * can talk to the agent without importing hooks. useVoiceAgent registers the real
 * functions while a session is connected; otherwise these are safe no-ops.
 */
import { useStore } from '../state/store';

export interface VoiceBridgeImpl {
  sendUserMessage: (text: string) => void;
  sendContextualUpdate: (text: string) => void;
}

let impl: VoiceBridgeImpl | null = null;

export function registerVoiceBridge(next: VoiceBridgeImpl | null) {
  impl = next;
}

const connected = () => impl !== null && useStore.getState().voiceStatus === 'connected';

export const voiceBridge = {
  isConnected: connected,
  sendUserMessage(text: string) {
    if (!connected()) return;
    try {
      impl!.sendUserMessage(text);
    } catch (err) {
      console.warn('[voice] sendUserMessage failed', err);
    }
  },
  sendContextualUpdate(text: string) {
    if (!connected()) return;
    try {
      impl!.sendContextualUpdate(text);
    } catch (err) {
      console.warn('[voice] sendContextualUpdate failed', err);
    }
  },
};
