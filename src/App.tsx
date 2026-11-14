import { Stage } from './stage/Stage';
import { VoiceProvider } from './voice/VoiceProvider';
import { VoiceBar } from './voice/VoiceBar';

export default function App() {
  return (
    <VoiceProvider>
      <div style={{ position: 'fixed', inset: 0 }}>
        <Stage />
      </div>
      <VoiceBar />
    </VoiceProvider>
  );
}
