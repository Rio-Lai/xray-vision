import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // localhost only: /api spends API credits, and the camera needs a secure context (localhost) anyway.
    port: 5173,
    proxy: {
      // 127.0.0.1, not "localhost": Node may resolve localhost to ::1 while the server listens on IPv4.
      '/api': 'http://127.0.0.1:8787',
    },
  },
});
