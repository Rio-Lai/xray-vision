/**
 * Runs first in `npm run dev`. If the app port or the API port is already taken it explains which
 * one and how to fix it, and exits non-zero so the dev servers never half-start (and the browser
 * never ends up talking to some other program on our port).
 */
import 'dotenv/config';
import net from 'node:net';
import { DEFAULT_PORT, WEB_PORT, apiPort, portInUseMessage } from './env';

/** Can we bind host:port ourselves? Only "in use" counts as taken; a missing IPv6 stack does not. */
function canListen(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (err: Error) => {
      const code = (err as NodeJS.ErrnoException).code;
      resolve(!(code === 'EADDRINUSE' || code === 'EACCES'));
    });
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

/** Does anything accept connections on host:port? Catches wildcard listeners that macOS lets us bind beside. */
function answers(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (result: boolean) => {
      sock.destroy();
      resolve(result);
    };
    sock.setTimeout(500, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

async function taken(port: number, hosts: string[]): Promise<boolean> {
  for (const host of hosts) {
    if (!(await canListen(port, host)) || (await answers(port, host))) return true;
  }
  return false;
}

/** Is the program on this port one of our own servers? Same check as the browser does in src/lib/api.ts. */
async function isBlowfish(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
    const body = (await res.json()) as { ok?: unknown; keys?: unknown; model?: unknown };
    return res.ok && body.ok === true && typeof body.keys === 'object' && typeof body.model === 'string';
  } catch {
    return false;
  }
}

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
