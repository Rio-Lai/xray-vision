import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { errorHandler, wrap } from './lib/http';
import { anthropicModel, hasAnthropic, hasEleven, hasFal, isMock } from './lib/env';
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

const port = Number(process.env.PORT) || 8787;
// Loopback only, so nobody on the hackathon Wi-Fi can spend our API credits. vite.config.ts proxies to 127.0.0.1.
const host = process.env.HOST || '127.0.0.1';
app.listen(port, host, () => {
  console.log(`[server] http://${host}:${port}`);
  console.log(
    `[server] anthropic=${hasAnthropic()} fal=${hasFal()} elevenlabs=${hasEleven()} mock=${isMock()}`,
  );
});
