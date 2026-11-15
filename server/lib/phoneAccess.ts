/**
 * The access code for `npm run phone` (scripts/phone.mjs). The phone reaches this laptop through a
 * public Cloudflare quick tunnel (https://<random>.trycloudflare.com), and /api spends our API credit,
 * so every request that did not come from this laptop itself needs the run's code:
 *  - the first visit carries `?code=...` (in the printed link); that sets an HttpOnly, Secure,
 *    SameSite=Lax cookie holding a hash of the code (never the code itself);
 *  - every later request (the page, its assets, /api) is let in by that cookie;
 *  - anything else gets a plain-text 401. With no code configured, everything not local is refused.
 * "From this laptop" means: a loopback address, a localhost Host header, and none of the headers a
 * proxy or Cloudflare adds. cloudflared also connects from 127.0.0.1, but it passes on the public Host
 * and adds Cf-Connecting-IP / X-Forwarded-For, so tunnel traffic never counts as local.
 * Only mounted when BLOWFISH_SERVE_DIST=1 (server/lib/serveDist.ts): `npm run dev` never runs it.
 * Pure functions (checkAccess) plus a small Express middleware (phoneGate).
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';

export const PHONE_COOKIE = 'bf_phone';
/** How long the phone stays let in without the code in the URL (seconds): one demo day. */
const COOKIE_MAX_AGE_S = 12 * 60 * 60;

/** Headers a proxy or Cloudflare adds. Any of them means "not this laptop". */
const PROXY_HEADERS = [
  'cf-connecting-ip',
  'cf-ray',
  'cf-ipcountry',
  'cf-visitor',
  'cdn-loop',
  'true-client-ip',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'forwarded',
];
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export const DENIED_TEXT =
  'Blowfish: this link needs its access code. Open the whole link that "npm run phone" printed on the Mac (it ends in &code=...).\n';

export interface AccessRequest {
  /** req.socket.remoteAddress */
  remoteAddress: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  /** the request's path and query, e.g. "/?phone=1&code=abc" */
  url: string;
}

export type AccessResult = { ok: true; setCookie?: string } | { ok: false };

/** "localhost:8791" -> "localhost", "[::1]:8791" -> "[::1]". */
function hostName(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end > 0 ? h.slice(0, end + 1) : h;
  }
  const i = h.lastIndexOf(':');
  return i >= 0 ? h.slice(0, i) : h;
}

/** The laptop itself (its browser, or npm run dev's Vite proxy): loopback, a localhost Host, no proxy headers. */
export function isLocalRequest(r: AccessRequest): boolean {
  if (!r.remoteAddress || !LOOPBACK.has(r.remoteAddress)) return false;
  const host = r.headers.host;
  if (typeof host !== 'string' || !LOCAL_HOSTS.has(hostName(host))) return false;
  return PROXY_HEADERS.every((name) => r.headers[name] === undefined);
}

/** What the cookie holds: a hash of the code, so the code itself is never stored in the browser. */
export function cookieToken(code: string): string {
  return createHash('sha256').update(`blowfish-phone\n${code}`).digest('hex');
}

/** Constant-time compare of two strings of any length (both are hashed to 32 bytes first). */
export function sameSecret(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

function cookieValue(header: string | string[] | undefined, name: string): string | null {
  const raw = Array.isArray(header) ? header.join(';') : header;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function queryCode(url: string): string | null {
  try {
    return new URL(url, 'http://blowfish.invalid').searchParams.get('code');
  } catch {
    return null;
  }
}

/** The Set-Cookie value for a phone that showed the right code. */
export function accessCookie(code: string): string {
  return `${PHONE_COOKIE}=${cookieToken(code)}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; HttpOnly; Secure; SameSite=Lax`;
}

/**
 * Let this request in? Local: always. Otherwise only with the right `?code=` (sets the cookie) or the
 * cookie from an earlier visit. `code` empty or missing: nothing that is not local gets in.
 */
export function checkAccess(r: AccessRequest, code: string | undefined): AccessResult {
  if (isLocalRequest(r)) return { ok: true };
  const want = (code ?? '').trim();
  if (!want) return { ok: false };
  const fromUrl = queryCode(r.url);
  if (fromUrl !== null && sameSecret(fromUrl.trim(), want)) return { ok: true, setCookie: accessCookie(want) };
  const fromCookie = cookieValue(r.headers.cookie, PHONE_COOKIE);
  if (fromCookie !== null && sameSecret(fromCookie, cookieToken(want))) return { ok: true };
  return { ok: false };
}

/** Express middleware: the first thing every request meets in phone mode. Never logs the code. */
export function phoneGate(code: string | undefined): RequestHandler {
  return (req, res, next) => {
    const result = checkAccess({ remoteAddress: req.socket.remoteAddress, headers: req.headers, url: req.originalUrl || req.url }, code);
    if (!result.ok) {
      res.status(401).set('Cache-Control', 'no-store').type('text/plain').send(DENIED_TEXT);
      return;
    }
    if (result.setCookie) res.append('Set-Cookie', result.setCookie);
    next();
  };
}
