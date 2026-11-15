import { Stage } from './stage/Stage';
import { VoiceProvider } from './voice/VoiceProvider';
import { VoiceBar } from './voice/VoiceBar';
import { PHONE_MODE } from './camera/frame';
import { PhoneApp } from './phone/PhoneApp';

export default function App() {
  // ?phone=1 (npm run phone): the iPhone version, src/phone/PhoneApp.tsx. Without it, the laptop app as before.
  if (PHONE_MODE) return <PhoneApp />;
  return (
    <VoiceProvider>
      <div style={{ position: 'fixed', inset: 0 }}>
        <Stage />
      </div>
      <VoiceBar />
    </VoiceProvider>
  );
}
