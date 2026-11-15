/**
 * Small pure helpers for scripts/phone.mjs (npm run phone), kept apart so they can be tested on their own.
 */
import { randomInt } from 'node:crypto';

/**
 * The quick tunnel's public URL in one line of cloudflared's output, or null. cloudflared prints it in
 * a box ("|  https://some-words-here.trycloudflare.com  |"). Its error lines name the API host
 * (api.trycloudflare.com), which is never the tunnel.
 */
export function findTunnelUrl(line) {
  for (const m of String(line).matchAll(/https:\/\/([a-z0-9-]+)\.trycloudflare\.com(?![a-z0-9.-])/gi)) {
    const sub = m[1].toLowerCase();
    if (sub === 'api' || sub === 'www') continue;
    return `https://${sub}.trycloudflare.com`;
  }
  return null;
}

/** cloudflared says this once the tunnel can carry traffic. */
export function isTunnelReady(line) {
  return /Registered tunnel connection/i.test(String(line));
}

/** No 0/o, 1/l/i: easy to read off a screen and type. */
const CODE_LETTERS = 'abcdefghjkmnpqrstuvwxyz23456789';

/** A fresh access code for this run (10 characters, about 50 bits). */
export function makeCode(length = 10) {
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_LETTERS[randomInt(CODE_LETTERS.length)];
  return out;
}

/** Extra URL switches from the command line (`npm run phone -- detail=1 dpr=1`): only plain name=value words. */
export function extraParams(args) {
  return (args ?? []).filter((a) => /^[a-z][a-z0-9]*=[a-z0-9._-]+$/i.test(a) && !/^(phone|overlay|code|watch)=/i.test(a));
}

/** The link to open on the phone (`extra`: more switches, e.g. ['detail=1']). */
export function phoneLink(base, code, extra = []) {
  const more = extra.length ? `&${extra.join('&')}` : '';
  return `${String(base).replace(/\/+$/, '')}/?phone=1&overlay=1${more}&code=${encodeURIComponent(code)}`;
}

/** `npm run phone -- nowatch`: no big-screen page on the Mac. */
export function wantsWatch(args) {
  return !(args ?? []).some((a) => /^-*no-?watch$/i.test(a));
}

/**
 * The big-screen page on this Mac (src/watch/, `?watch=1`): localhost needs no code. The same extra
 * switches as the phone link, so e.g. detail=1 mounts the detail model there too.
 */
export function watchLink(port, extra = []) {
  const more = extra.length ? `&${extra.join('&')}` : '';
  return `http://localhost:${port}/?watch=1${more}`;
}

/** The official cloudflared release file for this machine, or null if there is none. */
export function releaseAsset(platform = process.platform, arch = process.arch) {
  const a = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'amd64' : null;
  if (!a) return null;
  if (platform === 'darwin') return { file: `cloudflared-darwin-${a}.tgz`, tgz: true };
  if (platform === 'linux') return { file: `cloudflared-linux-${a}`, tgz: false };
  return null;
}
