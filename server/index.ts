import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { errorHandler, wrap } from './lib/http';
import { WEB_PORT, anthropicModel, apiPort, hasAnthropic, hasEleven, hasFal, isMock, portInUseMessage } from './lib/env';
import { identify } from './routes/identify';
import { teardown } from './routes/teardown';
import { generatePart } from './routes/generate-part';
import { agentToken } from './routes/agent-token';

const app = express();
// The browser reaches us through the Vite proxy (same origin); only allow local pages to call directly.
app.use(cors({ origin: [/^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/] }));
app.use(express.json({ limit: '15mb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    mock: isMock(),
    keys: {
      anthropic: hasAnthropic(),
      fal: hasFal(),
      elevenlabs: hasEleven(),
    },
    model: anthropicModel(),
  });
});

app.post('/api/identify', wrap(identify));
app.post('/api/teardown', wrap(teardown));
app.post('/api/generate-part', wrap(generatePart));
app.get('/api/agent-token', wrap(agentToken));

app.use(errorHandler);

const port = apiPort(); // PORT in .env, default in server/lib/env.ts (vite.config.ts proxies to the same one)
// Loopback only, so nobody on the hackathon Wi-Fi can spend our API credits. vite.config.ts proxies to 127.0.0.1.
const host = process.env.HOST || '127.0.0.1';
const server = app.listen(port, host, () => {
  console.log(`[server] Blowfish API listening on http://${host}:${port}`);
  console.log(
    `[server] anthropic=${hasAnthropic()} fal=${hasFal()} elevenlabs=${hasEleven()} mock=${isMock()}`,
  );
  console.log('');
  console.log(`  App (open in Chrome):  http://localhost:${WEB_PORT}`);
  console.log(`  API health:            http://localhost:${WEB_PORT}/api/health`);
  console.log('');
});
server.on('error', (err: Error) => {
  const code = (err as NodeJS.ErrnoException).code;
  console.error('');
  console.error(
    code === 'EADDRINUSE'
      ? portInUseMessage(port, null)
      : `[server] could not listen on ${host}:${port}: ${err.message}`,
  );
  console.error('');
  process.exit(1);
});
