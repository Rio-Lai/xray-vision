import type { ReactNode } from 'react';
import { ConversationProviderComp, voiceOptions } from './useVoiceAgent';

/** Wraps the app in ElevenLabs' ConversationProvider when the installed SDK has one. */
export function VoiceProvider({ children }: { children: ReactNode }) {
  if (!ConversationProviderComp) return <>{children}</>;
  const Provider = ConversationProviderComp;
  return <Provider {...voiceOptions}>{children}</Provider>;
}
