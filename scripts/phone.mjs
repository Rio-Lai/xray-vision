#!/usr/bin/env node
/**
 * npm run phone: Blowfish on an iPhone (and the XREAL glasses plugged into it), with this Mac as the
 * server. One command, one link:
 *
 *   1. the same port check as `npm run dev` (server/lib/preflight.ts)
 *   2. the vision models if they are missing (scripts/fetch-models.mjs; not fatal), then `vite build`
 *   3. the API server, which then also serves dist/ on its own port (BLOWFISH_SERVE_DIST=1), behind
 *      this run's access code (BLOWFISH_PHONE_CODE from .env, or a fresh random one)
 *   4. a Cloudflare quick tunnel to that port: https://<random>.trycloudflare.com, the https iOS needs
 *      for the camera and microphone. cloudflared is got only now, never on npm install: one already
 *      installed (brew, PATH), else the official release, downloaded once into .bin/
 *   5. prints the phone link, its QR code and what to do on the phone
 *      (`npm run phone -- detail=1 dpr=1` adds those switches to the link)
 *   6. prints the big-screen link for the projector (http://localhost:<PORT>/?watch=1, src/watch/) and
 *      opens it in Chrome on this Mac (`npm run phone -- nowatch`: neither)
 *
 * While it runs the Mac is kept awake (caffeinate). Ctrl-C stops the server and the tunnel.
 * Plain Node (no build step); `npm run phone` puts node_modules/.bin on PATH.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extraParams, findTunnelUrl, isTunnelReady, makeCode, phoneLink, releaseAsset, wantsWatch, watchLink } from './phone-lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const require = createRequire(import.meta.url);

const say = (line = '') => console.log(line);
/** One plain line for Rio, then stop everything. */
function giveUp(line) {
  if (stopping) return;
  say('');
  say(`  ${line}`);
  say('');
  stopAll(1);
}

// --------------------------------------------------------------------------------------------
// children, and stopping them all (Ctrl-C, or one of them dying)

const children = new Set();
let stopping = false;

function track(child) {
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}

function stopAll(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    try {
      c.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  const deadline = Date.now() + 2000;
  const wait = setInterval(() => {
    if (children.size === 0 || Date.now() > deadline) {
      clearInterval(wait);
      for (const c of children) {
        try {
          c.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
      process.exit(exitCode);
    }
  }, 100);
}

process.on('SIGINT', () => {
  say('\n  Stopping Blowfish (server and tunnel)...');
  stopAll(0);
});
process.on('SIGTERM', () => stopAll(0));

// --------------------------------------------------------------------------------------------
// helpers

/** node_modules/.bin/<name> if it is there, else the bare name (on PATH through npm run). */
function localBin(name) {
  const p = join(root, 'node_modules', '.bin', name);
  return existsSync(p) ? p : name;
}

function runStep(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) return { ok: false, why: r.error.code === 'ENOENT' ? 'missing' : String(r.error.message) };
  return { ok: r.status === 0, why: `exit ${r.status}` };
}

/** A real cloudflared answers `--version` with "cloudflared version 2026.x.y ...". */
function works(bin) {
  try {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 20_000 });
    return r.status === 0 && /cloudflared version/i.test(`${r.stdout ?? ''}${r.stderr ?? ''}`);
  } catch {
    return false;
  }
}

/** Lines from a child's stdout and stderr, one at a time. */
function onLines(child, fn) {
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        fn(buf.slice(0, i).replace(/\r$/, ''));
        buf = buf.slice(i + 1);
      }
    });
    stream.on('end', () => {
      if (buf) fn(buf);
      buf = '';
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function serverAnswers(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
    const body = await res.json();
    return res.ok && body && body.ok === true;
  } catch {
    return false;
  }
}

// --------------------------------------------------------------------------------------------
// cloudflared

const DOWNLOAD_TIMEOUT_MS = 180_000;
const MB = 1024 * 1024;

/** The first file called "cloudflared" under dir (the macOS .tgz holds just the binary). */
function findExtracted(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isFile() && name === 'cloudflared') return p;
    if (st.isDirectory()) {
      const inner = findExtracted(p);
      if (inner) return inner;
    }
  }
  return null;
}

/**
 * The official release binary from github.com/cloudflare/cloudflared, into .bin/ (gitignored), only when
 * `npm run phone` needs it. Prints its progress, gives up after DOWNLOAD_TIMEOUT_MS, and leaves nothing
 * half-downloaded behind. Returns the path, or null.
 */
async function downloadRelease(dest) {
  const asset = releaseAsset();
  if (!asset) return null;
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset.file}`;
  const dir = dirname(dest);
  const part = join(dir, `${asset.file}.part`);
  const unpack = join(dir, 'cloudflared-unpack');
  const cleanUp = () => {
    for (const p of [part, unpack]) rmSync(p, { recursive: true, force: true });
  };
  say('  Downloading cloudflared (the tunnel to the phone) from github.com/cloudflare/cloudflared, once...');
  try {
    mkdirSync(dir, { recursive: true });
    cleanUp();
    const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    const chunks = [];
    let got = 0;
    let shown = 0;
    for await (const chunk of res.body) {
      chunks.push(chunk);
      got += chunk.length;
      if (got - shown >= 10 * MB) {
        shown = got;
        say(`    ${(got / MB).toFixed(0)} MB${total ? ` of ${(total / MB).toFixed(0)} MB` : ''}`);
      }
    }
    writeFileSync(part, Buffer.concat(chunks));
    if (asset.tgz) {
      mkdirSync(unpack, { recursive: true });
      const r = spawnSync('tar', ['-xzf', part, '-C', unpack], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`could not unpack it (${(r.stderr || '').trim() || `tar exit ${r.status}`})`);
      const extracted = findExtracted(unpack);
      if (!extracted) throw new Error('the download had no cloudflared in it');
      rmSync(dest, { force: true });
      renameSync(extracted, dest);
    } else {
      rmSync(dest, { force: true });
      renameSync(part, dest);
    }
    cleanUp();
    chmodSync(dest, 0o755);
    if (works(dest)) {
      say(`    done (${(got / MB).toFixed(0)} MB, kept in .bin/ for next time)`);
      return dest;
    }
    rmSync(dest, { force: true });
    say('  The downloaded cloudflared does not run on this Mac.');
    return null;
  } catch (e) {
    cleanUp();
    const why = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'it took too long' : e instanceof Error ? e.message : String(e);
    say(`  Could not download cloudflared: ${why}.`);
    return null;
  }
}

/**
 * cloudflared, got only when `npm run phone` runs (never on npm install): one already installed (the
 * brew locations, then PATH), else the copy in .bin/ from an earlier run, else the official release.
 */
async function findCloudflared() {
  for (const p of ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared', 'cloudflared']) {
    if ((p === 'cloudflared' || existsSync(p)) && works(p)) return p;
  }
  const local = join(root, '.bin', 'cloudflared');
  if (existsSync(local) && works(local)) return local;
  return downloadRelease(local);
}

// --------------------------------------------------------------------------------------------

async function main() {
  say('');
  say('  Blowfish for the iPhone: getting everything ready (about a minute)...');
  say('');

  try {
    require('dotenv').config({ path: join(root, '.env') });
  } catch {
    giveUp('The packages are not installed. Paste this, then run the command again:  npm install');
    return;
  }
  const port = Number((process.env.PORT ?? '').trim() || 8791);

  // 1. the same check as npm run dev: both ports free (it explains and exits if not)
  const pre = runStep(localBin('tsx'), ['server/lib/preflight.ts']);
  if (!pre.ok) {
    giveUp(
      pre.why === 'missing'
        ? 'The packages are not installed. Paste this, then run the command again:  npm install'
        : 'A port is busy (see above). Close the other Blowfish window, or restart the Mac, then run the command again.',
    );
    return;
  }

  // Keep the Mac awake while this runs (caffeinate -w ends with us).
  if (process.platform === 'darwin') {
    try {
      const c = spawn('caffeinate', ['-i', '-m', '-s', '-w', String(process.pid)], { stdio: 'ignore' });
      c.on('error', () => undefined);
      track(c);
    } catch {
      /* no caffeinate: the docs say to keep the Mac awake */
    }
  }

  // 2. the vision models (local copies load faster over the tunnel than from Google), then the build
  if (!existsSync(join(root, 'public', 'models', 'hand_landmarker.task'))) {
    say('  Downloading the vision models (once)...');
    const fm = runStep(process.execPath, [join(root, 'scripts', 'fetch-models.mjs')], { timeout: 180_000 });
    if (!fm.ok) say('  (Some models did not download: the phone will fetch them from Google instead.)');
  }
  say('  Building the app...');
  const build = runStep(localBin('vite'), ['build', '--logLevel', 'warn']);
  if (!build.ok) {
    giveUp('The app did not build (the error is above). Send a photo of it to the team.');
    return;
  }

  // 3. the server: the built app and /api on one port, behind the access code
  const code = (process.env.BLOWFISH_PHONE_CODE ?? '').trim() || makeCode();
  const server = track(
    spawn(localBin('tsx'), ['server/index.ts'], {
      env: { ...process.env, BLOWFISH_SERVE_DIST: '1', BLOWFISH_PHONE_CODE: code },
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
  let serverReady = false;
  onLines(server, (line) => {
    // its "open http://localhost:5173" lines are for npm run dev, not for this
    if (!line.trim() || line.includes('App (open in Chrome)') || line.includes('API health:')) return;
    console.log(line);
  });
  server.on('error', () => giveUp('The Blowfish server could not start. Paste this, then run the command again:  npm install'));
  server.on('exit', (c) => {
    if (!stopping) giveUp(`The Blowfish server stopped (exit ${c}; the reason is above). Run the command again.`);
  });
  for (let i = 0; i < 100 && !serverReady && !stopping; i++) {
    serverReady = await serverAnswers(port);
    if (!serverReady) await sleep(300);
  }
  if (stopping) return;
  if (!serverReady) {
    giveUp(`The Blowfish server did not answer on port ${port}. Run the command again.`);
    return;
  }

  // 4. the tunnel
  const bin = await findCloudflared();
  if (stopping) return;
  if (!bin) {
    giveUp('Could not get cloudflared (the tunnel to the phone). Paste this, then run the command again:  brew install cloudflared');
    return;
  }
  const tunnel = track(
    spawn(bin, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'] }),
  );
  let url = null;
  let ready = false;
  const recent = [];
  onLines(tunnel, (line) => {
    recent.push(line);
    if (recent.length > 8) recent.shift();
    url ??= findTunnelUrl(line);
    if (isTunnelReady(line)) ready = true;
    // once it runs, only its errors are worth showing
    if (ready && / ERR /.test(line)) console.log(`[tunnel] ${line}`);
  });
  tunnel.on('error', () => giveUp('cloudflared could not start. Paste this, then run the command again:  brew install cloudflared'));
  tunnel.on('exit', (c) => {
    if (stopping) return;
    const last = url ? '' : ` Last message: ${(recent.at(-1) ?? 'none').trim()}`;
    giveUp(`The tunnel closed (exit ${c}). Check the Mac is online, then run the command again for a new link.${last}`);
  });
  for (let i = 0; i < 150 && !url && !stopping; i++) await sleep(200);
  if (stopping) return;
  if (!url) {
    giveUp(`The tunnel did not start (no network, or Cloudflare is busy). Wait a minute and run the command again. Last message: ${recent.at(-1) ?? 'none'}`);
    return;
  }
  for (let i = 0; i < 100 && !ready && !stopping; i++) await sleep(200);
  if (stopping) return;

  // 5. the link
  // (`npm run phone -- detail=1` adds switches to the link, e.g. the detail explainer)
  const extra = extraParams(process.argv.slice(2));
  const link = phoneLink(url, code, extra);
  say('');
  say('  ============================================================================');
  say('  Blowfish is ready for the iPhone. Open this link on the phone (or scan the QR');
  say('  code with the iPhone Camera app):');
  say('');
  say(`  ${link}`);
  say('');
  try {
    const qr = require('qrcode-terminal');
    qr.generate(link, { small: true }, (text) => say(text.replace(/^/gm, '  ')));
  } catch {
    say('  (No QR code: the qrcode-terminal package is missing. Type or AirDrop the link instead.)');
  }
  say('');
  say('  On the phone:');
  say('    1. Open the link in Safari, tap "Tap to start", allow the camera and the microphone.');
  say('    2. Turn the phone sideways, then plug in the glasses.');
  say('    3. Optional, for full screen: Share > Add to Home Screen, then open Blowfish from there.');
  say('       That icon only works until this window stops. After a restart of npm run phone there');
  say('       is a new link: open it in Safari, then Add to Home Screen again.');
  say('');
  say('  If Safari cannot find the page, wait 20 seconds and reload. Keep this Mac awake,');
  say('  plugged in and online, with the lid open. Ctrl-C here stops everything.');
  say('  ============================================================================');
  say('');

  // 6. the big screen: the phone's view (camera and overlay) on this Mac, for the projector
  if (wantsWatch(process.argv.slice(2))) {
    const watch = watchLink(port, extra);
    say('  For the projector, open this on this Mac (Chrome):');
    say('');
    say(`  ${watch}`);
    say('');
    say('  It opens by itself. Drag that window to the projector screen and click it for full');
    say('  screen (Esc leaves it). It shows the phone\'s view once the phone has tapped "Tap to');
    say('  start". The sound plays on the phone: pair the Bluetooth speaker with the iPhone.');
    say('  (npm run phone -- nowatch: no big-screen window)');
    say('');
    openInChrome(watch);
  }
}

/** macOS: open the link in Google Chrome, else in the default browser. Elsewhere nothing (the link is printed). */
function openInChrome(link) {
  if (process.platform !== 'darwin') return;
  try {
    const r = spawnSync('open', ['-a', 'Google Chrome', link], { stdio: 'ignore', timeout: 15_000 });
    if (r.status === 0) return;
    spawnSync('open', [link], { stdio: 'ignore', timeout: 15_000 });
  } catch {
    /* the link is printed above */
  }
}

main().catch((e) => giveUp(`Something went wrong: ${e instanceof Error ? e.message : String(e)}. Run the command again.`));
