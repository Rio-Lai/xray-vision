import { createRoot } from 'react-dom/client';
import App from './App';

// No StrictMode: it runs effects twice in dev, which would open the camera and models twice.
createRoot(document.getElementById('root')!).render(<App />);
