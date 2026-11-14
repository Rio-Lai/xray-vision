import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { WEB_PORT, apiPort } from './server/lib/env';

export default defineConfig(({ mode }) => {
  // The same PORT the server reads (.env or the shell), with the same default (server/lib/env.ts).
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react()],
    server: {
      // localhost only: /api spends API credits, and the camera needs a secure context (localhost) anyway.
      port: WEB_PORT,
      // Fail instead of moving to 5174: the old tab on 5173 would then be some other page.
      strictPort: true,
      proxy: {
        // 127.0.0.1, not "localhost": Node may resolve localhost to ::1 while the server listens on IPv4.
        '/api': `http://127.0.0.1:${apiPort(env)}`,
      },
    },
  };
});
