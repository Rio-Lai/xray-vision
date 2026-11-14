/**
 * Runs first in `npm run dev`. If the app port or the API port is already taken it explains which
 * one and how to fix it, and exits non-zero so the dev servers never half-start (and the browser
 * never ends up talking to some other program on our port).
 */
import 'dotenv/config';
import { DEFAULT_PORT, WEB_PORT, apiPort, portInUseMessage } from './env';
import { isBlowfish, taken } from './ports';

async function main() {
  let port: number;
  try {
    port = apiPort();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  if (process.env.PORT?.trim() === '8787') {
    console.warn(
      `[preflight] PORT=8787 in .env is the old default and clashes with other dev tools. Remove the PORT line from .env (default ${DEFAULT_PORT}).`,
    );
  }

  // The API listens on 127.0.0.1 only. Vite listens on "localhost", which can be IPv4 or IPv6.
  if (await taken(port, ['127.0.0.1'])) fail(portInUseMessage(port, await isBlowfish(port)));
  if (await taken(WEB_PORT, ['127.0.0.1', '::1'])) {
    fail(
      [
        `Port ${WEB_PORT} (the app) is already in use, most likely by an older "npm run dev" or another Vite app.`,
        'Stop it with Ctrl+C in its terminal, then run "npm run dev" again.',
        `To see what is using it (macOS): lsof -nP -iTCP:${WEB_PORT} -sTCP:LISTEN`,
      ].join('\n'),
    );
  }
}

function fail(message: string): never {
  console.error(`\n[preflight] ${message.split('\n').join('\n[preflight] ')}\n`);
  process.exit(1);
}

void main();
