import { Stage } from './stage/Stage';
import { VoiceProvider } from './voice/VoiceProvider';
import { VoiceBar } from './voice/VoiceBar';
import { PHONE_MODE, WATCH_MODE } from './camera/frame';
import { PhoneApp } from './phone/PhoneApp';
import { WatchApp } from './watch/WatchApp';

export default function App() {
  // ?watch=1 (npm run phone opens it on the Mac): the projector's copy of the phone's view, src/watch/.
  if (WATCH_MODE) return <WatchApp />;
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
