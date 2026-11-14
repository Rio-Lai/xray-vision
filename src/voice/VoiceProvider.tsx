import type { ReactNode } from 'react';
import { ConversationProvider } from '@elevenlabs/react';
import { voiceOptions } from './useVoiceAgent';

/**
 * ElevenLabs' ConversationProvider (required by @elevenlabs/react 1.x: every conversation hook needs it
 * as an ancestor). Client tools and callbacks are set here. Mounting it does not connect or ask for the mic.
 */
export function VoiceProvider({ children }: { children: ReactNode }) {
  return <ConversationProvider {...voiceOptions}>{children}</ConversationProvider>;
}
