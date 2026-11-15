/**
 * Phone mode (`?phone=1`): the voice session's start and stop, registered by VoiceBar (the same ones
 * the V key and the voice pill use), so the start screen and the settings sheet's Voice button can call them.
 */
import { useStore } from '../state/store';
import { showToast } from '../hud/hudStore';

export interface PhoneVoiceControls {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  /** the Mac has no ElevenLabs keys */
  notConfigured: boolean;
}

let controls: PhoneVoiceControls | null = null;

export function registerPhoneVoice(next: PhoneVoiceControls | null): void {
  controls = next;
}

const NOT_SET_UP = 'Voice is off: the Mac has no ElevenLabs keys in .env. The gear at the top right has Analyse, Explode and Put away.';

export const phoneVoice = {
  /** Start the session unless it is already on or connecting. */
  start(): void {
    if (!controls) return;
    if (controls.notConfigured) {
      showToast(NOT_SET_UP, 'warn', 6000);
      return;
    }
    if (useStore.getState().voiceStatus !== 'disconnected') return;
    void controls.start().then(() => {
      // (start() finds out about missing keys itself; VoiceBar registers the new state on its next render)
      window.setTimeout(() => {
        if (controls?.notConfigured) showToast(NOT_SET_UP, 'warn', 6000);
      }, 500);
    });
  },
  toggle(): void {
    if (!controls) return;
    const vs = useStore.getState().voiceStatus;
    if (vs === 'connected') void controls.stop();
    else if (vs !== 'connecting') phoneVoice.start();
  },
};
