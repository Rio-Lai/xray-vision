/**
 * Port checks shared by the preflight in `npm run dev` (server/lib/preflight.ts) and `npm run check`
 * (scripts/check.ts). Node built-ins only.
 */
import net from 'node:net';

/** Can we bind host:port ourselves? Only "in use" counts as taken; a missing IPv6 stack does not. */
export function canListen(port: number, host: string): Promise<boolean> {
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
export function answers(port: number, host: string): Promise<boolean> {
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

/** Is the port taken on any of these hosts? */
export async function taken(port: number, hosts: string[]): Promise<boolean> {
  for (const host of hosts) {
    if (!(await canListen(port, host)) || (await answers(port, host))) return true;
  }
  return false;
}

/**
 * Does our own server answer /api/health on this port? Same check as the browser does in src/lib/api.ts.
 * Works for the API port and, through the Vite proxy, for the app port.
 */
export async function isBlowfish(port: number, host = '127.0.0.1'): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
    const body = (await res.json()) as { ok?: unknown; keys?: unknown; model?: unknown };
    return res.ok && body.ok === true && typeof body.keys === 'object' && typeof body.model === 'string';
  } catch {
    return false;
  }
}
