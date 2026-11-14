import { createRoot } from 'react-dom/client';
import App from './App';
import ArmDemo from './biology/arm/ArmDemo';

// No StrictMode: it runs effects twice in dev, which would open the camera and models twice.
// /arm-demo: the X-ray arm on its own (replayed typing trace), our fallback for the pitch.
const Page = location.pathname.replace(/\/+$/, '') === '/arm-demo' ? ArmDemo : App;
createRoot(document.getElementById('root')!).render(<Page />);
