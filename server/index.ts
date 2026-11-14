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
app.use(cors());
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
app.listen(port, () => {
  console.log(`[server] http://localhost:${port}`);
  console.log(
    `[server] anthropic=${hasAnthropic()} fal=${hasFal()} elevenlabs=${hasEleven()} mock=${isMock()}`,
  );
});
