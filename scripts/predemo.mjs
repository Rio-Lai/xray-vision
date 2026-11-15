#!/usr/bin/env node
/**
 * Demo-day check: can the MacBook and hand demos run with the venue Wi-Fi off?
 *
 *   npm run predemo                        # download what is missing (fetch-models), then check
 *   node scripts/predemo.mjs --no-fetch    # check only, no network at all
 *
 * Plain Node 20+, no packages needed (it runs before or without npm install). Prints one line per
 * check (ok / WARN / FAIL / info / skip) and exits 1 if anything FAILs. Never prints key values.
 *
 *   1. Vision model download: runs scripts/fetch-models.mjs; a failed download is reported, not a crash.
 *   2. Installed packages: npm install needs the network, so it must already be done.
 *   3. MediaPipe models and wasm in public/models/ (missing files make the browser ask the CDN).
 *   4. Every checked parts list in public/cache/*.json: the schema (needs npm install), and every
 *      mesh_url is a local GLB that exists and is a glTF 2 binary with no external files and no
 *      extension that needs a decoder (glbCache.ts sets none up).
 *   5. No remote URLs in index.html, src/ or the parts lists, apart from the MediaPipe CDN fallbacks.
 *   6. Which keys .env sets (yes / no only) and what each one means without a network.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('Usage: node scripts/predemo.mjs [--no-fetch]\n  --no-fetch  do not download anything; only check the files already on this laptop');
  process.exit(0);
}
const noFetch = argv.includes('--no-fetch') || argv.includes('--offline');

/** The app only accepts a local model bigger than this (fetchLocalModel in src/detect/mediapipe.ts). */
const MIN_MODEL_BYTES = 100_000;
/** PROJECT.md: keep each GLB under about 3 MB. */
const BIG_GLB_BYTES = 3 * 1024 * 1024;
/** Extensions three.js's GLTFLoader can only read with a decoder, and glbCache.ts sets none up. */
const DECODER_EXTENSIONS = ['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_texture_basisu'];
/** Hosts that are fine in source: this machine, and XML namespaces (not fetched). */
const HARMLESS_HOSTS = new Set(['localhost', '127.0.0.1', 'www.w3.org']);
/** src/detect/mediapipe.ts falls back to these only when the local files in section 3 are missing. */
const MEDIAPIPE_FALLBACK_HOSTS = new Set(['cdn.jsdelivr.net', 'storage.googleapis.com']);

let failures = 0;
let warnings = 0;
const say = (tag, text) => console.log(`  ${tag.padEnd(5)} ${text}`);
const ok = (t) => say('ok', t);
const info = (t) => say('info', t);
const skip = (t) => say('skip', t);
const warn = (t) => {
  warnings++;
  say('WARN', t);
};
const fail = (t) => {
  failures++;
  say('FAIL', t);
};
const section = (title) => console.log(`\n${title}`);

const rel = (p) => relative(root, p).split(sep).join('/');
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const errText = (e) => (e instanceof Error ? e.message : String(e));

function readText(p) {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}
function readJson(p) {
  const t = readText(p);
  if (t === null) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}
function sizeOf(p) {
  try {
    const s = statSync(p);
    return s.isFile() ? s.size : -1;
  } catch {
    return -1;
  }
}

/** MEDIAPIPE_VERSION from src/detect/mediapipe.ts, so the check follows the code. */
function expectedMediapipeVersion() {
  const src = readText(join(root, 'src', 'detect', 'mediapipe.ts')) ?? '';
  return src.match(/MEDIAPIPE_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1] ?? null;
}

/** The demo objects' ids from DEMO_IDENTIFY in shared/demo.ts. */
function demoObjectIds() {
  const src = readText(join(root, 'shared', 'demo.ts')) ?? '';
  return [...src.matchAll(/object_id:\s*['"]([a-z0-9-]+)['"]/g)].map((m) => m[1]);
}

// ---------------------------------------------------------------------------------------------
console.log('Blowfish demo-day check: what works with the Wi-Fi off');

section('1. Download the vision models (scripts/fetch-models.mjs)');
if (noFetch) {
  skip('--no-fetch: nothing downloaded; checking the files already here');
} else {
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'fetch-models.mjs')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 180_000,
  });
  if (r.error) {
    const timedOut = /ETIMEDOUT/.test(String(r.error.code ?? r.error.message));
    warn(timedOut ? 'download stopped after 3 minutes (slow network?)' : `could not run fetch-models: ${errText(r.error)}`);
  }
  let reported = 0;
  for (const raw of `${r.stdout ?? ''}\n${r.stderr ?? ''}`.split('\n')) {
    const m = raw.trim().match(/^(ok|got|info|FAIL)\s+(.*)$/);
    if (!m) continue;
    reported++;
    if (m[1] === 'FAIL') warn(`could not download ${m[2]}`);
    else if (m[1] === 'info') info(m[2]);
    else ok(m[1] === 'got' ? `downloaded ${m[2]}` : m[2]);
  }
  if (!r.error && r.status !== 0 && reported === 0) {
    const first = `${r.stderr ?? ''}${r.stdout ?? ''}`.trim().split('\n')[0] ?? '';
    warn(`fetch-models stopped (exit ${r.status}): ${first}`);
  }
  if (!r.error && r.status !== 0) info('section 3 says whether the files the app needs are here anyway');
}

// ---------------------------------------------------------------------------------------------
section('2. Installed packages (npm install needs the network: do it before)');
const nm = join(root, 'node_modules');
const hasNodeModules = existsSync(nm);
const binPath = (name) => [join(nm, '.bin', name), join(nm, '.bin', `${name}.cmd`)].find((p) => existsSync(p)) ?? null;
const mpWant = expectedMediapipeVersion();
if (!hasNodeModules) {
  fail('node_modules is missing: run npm install while you still have the network');
} else {
  const missing = ['vite', 'tsx', 'concurrently'].filter((b) => !binPath(b));
  if (missing.length) fail(`node_modules/.bin has no ${missing.join(', ')}: run npm install`);
  else ok('npm install done (vite, tsx, concurrently)');
  const mpGot = readJson(join(nm, '@mediapipe', 'tasks-vision', 'package.json'))?.version ?? null;
  if (!mpGot) fail('@mediapipe/tasks-vision is not installed: run npm install');
  else if (mpWant && mpGot !== mpWant) fail(`@mediapipe/tasks-vision ${mpGot} is installed but src/detect/mediapipe.ts expects ${mpWant}`);
  else ok(`@mediapipe/tasks-vision ${mpGot}`);
}

// ---------------------------------------------------------------------------------------------
section('3. Vision models and wasm in public/models/ (missing files make the browser ask the CDN)');
const modelsDir = join(root, 'public', 'models');

function checkModel(file, use, looksRight, kind) {
  const p = join(modelsDir, file);
  const n = sizeOf(p);
  if (n < 0) {
    fail(`${file} is missing (${use} would need storage.googleapis.com): run npm run fetch-models on a working network`);
    return;
  }
  if (n <= MIN_MODEL_BYTES) {
    fail(`${file} is only ${n} bytes (a failed download?): delete it and run npm run fetch-models`);
    return;
  }
  let head = Buffer.alloc(0);
  try {
    head = readFileSync(p).subarray(0, 8);
  } catch {
    /* size check above already passed; treat as unreadable below */
  }
  if (!looksRight(head)) warn(`${file} (${mb(n)}) does not look like a ${kind}; if detection fails, delete it and run npm run fetch-models`);
  else ok(`${file} ${mb(n)} (${use})`);
}
checkModel('efficientdet_lite0.tflite', 'object labels', (b) => b.length >= 8 && b.subarray(4, 8).toString('latin1') === 'TFL3', 'TFLite model');
if (sizeOf(join(modelsDir, 'efficientdet_lite2.tflite')) > MIN_MODEL_BYTES) checkModel('efficientdet_lite2.tflite', 'sharper object labels (#110)', (b) => b.length >= 8 && b.subarray(4, 8).toString('latin1') === 'TFL3', 'TFLite model'); else warn('efficientdet_lite2.tflite is missing: offline, object labels use the smaller Lite0 (#110); run npm run fetch-models on a working network');
checkModel('hand_landmarker.task', 'hands, gestures, muscle overlay', (b) => b.length >= 4 && b.readUInt32LE(0) === 0x04034b50, 'MediaPipe task bundle');
checkModel('face_landmarker.task', 'eyes for "analyse the eye"', (b) => b.length >= 4 && b.readUInt32LE(0) === 0x04034b50, 'MediaPipe task bundle');

const wasmDir = join(modelsDir, 'wasm');
const wasmMagic = (p) => {
  try {
    return readFileSync(p).subarray(0, 4).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d]));
  } catch {
    return false;
  }
};
let wasmPresent = false;
for (const [base, required] of [
  ['vision_wasm_internal', true],
  ['vision_wasm_nosimd_internal', false],
]) {
  const js = join(wasmDir, `${base}.js`);
  const wasm = join(wasmDir, `${base}.wasm`);
  const problems = [];
  if (sizeOf(js) <= 0) problems.push(`${base}.js missing`);
  if (sizeOf(wasm) <= 0) problems.push(`${base}.wasm missing`);
  else if (!wasmMagic(wasm)) problems.push(`${base}.wasm is not WebAssembly`);
  if (problems.length === 0) ok(`wasm/${base}.js + .wasm ${mb(sizeOf(wasm))}`);
  if (problems.length === 0 && required) wasmPresent = true;
  else if (required) fail(`wasm: ${problems.join(', ')} (the app would load the wasm from jsDelivr): run npm run fetch-models`);
  else warn(`wasm: ${problems.join(', ')} (only used by browsers without WebAssembly SIMD; current Chrome has it)`);
}
const wasmVersion = (readText(join(wasmDir, 'VERSION')) ?? '').trim();
if (!wasmPresent) {
  /* the FAIL above covers it */
} else if (!wasmVersion) warn('wasm/VERSION is missing: run npm run fetch-models so the wasm matches the installed package');
else if (mpWant && wasmVersion !== mpWant) fail(`wasm is from tasks-vision ${wasmVersion}, src/detect/mediapipe.ts expects ${mpWant}: run node scripts/fetch-models.mjs --force`);
else ok(`wasm version ${wasmVersion}`);

// ---------------------------------------------------------------------------------------------
section('4. Checked parts lists and their 3D models (public/cache/)');
const cacheDir = join(root, 'public', 'cache');
const listFiles = existsSync(cacheDir)
  ? readdirSync(cacheDir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => join(cacheDir, f))
  : [];

/** Reads a GLB header and JSON chunk. Returns { error } or { json, size }. */
function inspectGlb(p) {
  let buf;
  try {
    buf = readFileSync(p);
  } catch (e) {
    return { error: `unreadable (${errText(e)})` };
  }
  if (buf.length < 20) return { error: 'too small to be a GLB' };
  if (buf.readUInt32LE(0) !== 0x46546c67) return { error: 'not a GLB file (bad header)' };
  const version = buf.readUInt32LE(4);
  if (version !== 2) return { error: `glTF version ${version}, the app needs 2` };
  if (buf.readUInt32LE(8) > buf.length) return { error: 'truncated (shorter than its header says)' };
  const jsonLen = buf.readUInt32LE(12);
  if (buf.readUInt32LE(16) !== 0x4e4f534a || 20 + jsonLen > buf.length) return { error: 'no JSON chunk' };
  try {
    return { json: JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8')), size: buf.length };
  } catch {
    return { error: 'its JSON chunk does not parse' };
  }
}

/** Problems that would make a GLB fail or need the network in the browser. */
function glbProblems(json) {
  const out = [];
  const external = [...(json.buffers ?? []), ...(json.images ?? [])]
    .map((x) => (x && typeof x.uri === 'string' ? x.uri : null))
    .filter((u) => u !== null && !u.startsWith('data:'));
  if (external.length) out.push(`needs external files (${external.slice(0, 2).join(', ')})`);
  const needsDecoder = (json.extensionsRequired ?? []).filter((x) => DECODER_EXTENSIONS.includes(x));
  if (needsDecoder.length) out.push(`needs a decoder the app does not set up (${needsDecoder.join(', ')})`);
  return out;
}

const demoIds = demoObjectIds();
/** Parts lists that parse, for the schema check, and remote mesh_urls already reported here (not again in section 5). */
const parsedLists = [];
const flaggedUrls = new Set();
for (const id of demoIds) {
  if (!existsSync(join(cacheDir, `${id}.json`))) fail(`demo object ${id} has no public/cache/${id}.json: "analyse this" would need Claude`);
}

for (const file of listFiles) {
  const name = rel(file);
  const td = readJson(file);
  if (!td || typeof td !== 'object') {
    fail(`${name} is not valid JSON: the server would skip it`);
    continue;
  }
  parsedLists.push(file);
  const stem = file.slice(file.lastIndexOf(sep) + 1, -'.json'.length);
  if (td.object_id !== stem) warn(`${name}: object_id is "${td.object_id}" but the file is named ${stem}.json (the server finds it by file name)`);
  const parts = Array.isArray(td.parts) ? td.parts : [];
  const isHand = td.anchor === 'hand';
  const problems = [];
  let models = 0;
  let bytes = 0;
  const noModel = [];
  for (const part of parts) {
    const url = part && typeof part.mesh_url === 'string' ? part.mesh_url.trim() : '';
    if (!url) {
      noModel.push(part?.id ?? '?');
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
      problems.push(`${part.id}: mesh_url ${url} is remote (needs the network)`);
      flaggedUrls.add(url);
      continue;
    }
    if (!url.startsWith('/')) {
      problems.push(`${part.id}: mesh_url ${url} should start with /cache/`);
      continue;
    }
    let local = url.split(/[?#]/)[0];
    try {
      local = decodeURIComponent(local);
    } catch {
      /* keep it as written */
    }
    const p = join(root, 'public', ...local.split('/').filter(Boolean));
    if (!p.startsWith(join(root, 'public') + sep)) {
      problems.push(`${part.id}: mesh_url ${url} points outside public/`);
      continue;
    }
    if (sizeOf(p) <= 0) {
      problems.push(`${part.id}: ${rel(p)} is missing`);
      continue;
    }
    const g = inspectGlb(p);
    if (g.error) {
      problems.push(`${part.id}: ${rel(p)} ${g.error}`);
      continue;
    }
    const gp = glbProblems(g.json);
    if (gp.length) {
      problems.push(`${part.id}: ${rel(p)} ${gp.join('; ')}`);
      continue;
    }
    if (g.size > BIG_GLB_BYTES) warn(`${part.id}: ${rel(p)} is ${mb(g.size)} (aim for under 3 MB)`);
    models++;
    bytes += g.size;
  }
  for (const pr of problems) fail(`${name}: ${pr}`);
  const label = `${name}: ${parts.length} parts`;
  if (parts.length === 0) fail(`${name}: no parts`);
  else if (problems.length && noModel.length === 0) info(`${label}, ${models} local models load`);
  else if (isHand && noModel.length === parts.length) ok(`${label}, drawn from the hand landmarks (no models needed)`);
  else if (noModel.length === 0) ok(`${label}, ${models} local models (${mb(bytes)})`);
  else if (isHand) ok(`${label}, ${models} local models; the rest are drawn from the hand landmarks`);
  else
    warn(
      `${label}, ${models} local models; no model for ${noModel.join(', ')}: placeholder shapes offline (online, fal is asked for them)`,
    );
}
if (listFiles.length === 0) fail('public/cache/ has no parts lists');

// Schema: the server skips a file that does not match TeardownSchema. zod and tsx come with npm install.
const tsxBin = hasNodeModules ? binPath('tsx') : null;
const hasZod = hasNodeModules && existsSync(join(nm, 'zod', 'package.json'));
if (parsedLists.length > 0 && tsxBin && hasZod) {
  const tmpDir = join(nm, '.cache', 'blowfish-predemo');
  const script = join(tmpDir, 'schema-check.mts');
  try {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      script,
      [
        "import { readFileSync } from 'node:fs';",
        'const [schemaUrl, filesJson] = process.argv.slice(2);',
        'const { TeardownSchema } = await import(schemaUrl);',
        'const out = (JSON.parse(filesJson) as string[]).map((f) => {',
        '  try {',
        "    const r = TeardownSchema.safeParse(JSON.parse(readFileSync(f, 'utf8')));",
        '    if (r.success) return { f, ok: true, issues: [] as string[] };',
        "    return { f, ok: false, issues: r.error.issues.slice(0, 3).map((i: { path: (string | number)[]; message: string }) => `${i.path.join('.') || '(root)'}: ${i.message}`) };",
        '  } catch (e) {',
        '    return { f, ok: false, issues: [String(e)] };',
        '  }',
        '});',
        "console.log('@@SCHEMA@@' + JSON.stringify(out));",
        '',
      ].join('\n'),
    );
    const r = spawnSync(tsxBin, [script, pathToFileURL(join(root, 'shared', 'teardown.ts')).href, JSON.stringify(parsedLists)], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60_000,
      shell: process.platform === 'win32',
    });
    const marker = (r.stdout ?? '').split('\n').find((l) => l.startsWith('@@SCHEMA@@'));
    if (!marker) {
      const why = r.error ? errText(r.error) : `${r.stderr ?? ''}`.trim().split('\n').slice(-1)[0] || `exit ${r.status}`;
      warn(`schema check could not run (${why})`);
    } else {
      const res = JSON.parse(marker.slice('@@SCHEMA@@'.length));
      const bad = res.filter((x) => !x.ok);
      for (const b of bad) fail(`${rel(b.f)} does not match TeardownSchema, so the server skips it: ${b.issues.join('; ')}`);
      if (bad.length === 0) ok(`all ${res.length} parts lists match TeardownSchema (shared/teardown.ts)`);
    }
  } catch (e) {
    warn(`schema check could not run (${errText(e)})`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
} else if (parsedLists.length > 0) {
  skip('schema check (TeardownSchema) needs npm install (zod and tsx)');
}

// Live results from earlier runs on this laptop.
const liveDir = join(root, '.cache-live');
if (existsSync(liveDir)) {
  const liveLists = readdirSync(liveDir).filter((f) => f.endsWith('.json') && f !== 'meshes.json');
  if (liveLists.length) info(`${liveLists.length} live parts list(s) in .cache-live/ open without Claude (shown as AI-estimated)`);
  const meshes = readJson(join(liveDir, 'meshes.json'));
  if (meshes && typeof meshes === 'object') {
    const remote = Object.values(meshes).filter((m) => m && typeof m.mesh_url === 'string' && /^https?:/i.test(m.mesh_url)).length;
    if (remote) info(`${remote} live fal model(s) in .cache-live/meshes.json are fal.media links: they load only with the network`);
  }
}

// ---------------------------------------------------------------------------------------------
section('5. Remote URLs the app could fetch (index.html, src/, public/cache/*.json)');
function walk(dir, exts, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, exts, out);
    else if (exts.some((x) => entry.name.endsWith(x))) out.push(p);
  }
  return out;
}
const scanFiles = [join(root, 'index.html'), ...walk(join(root, 'src'), ['.ts', '.tsx', '.js', '.jsx', '.css', '.html']), ...listFiles].filter(
  (p) => existsSync(p),
);
const unexpected = [];
let fallbackCount = 0;
for (const p of scanFiles) {
  const lines = (readText(p) ?? '').split('\n');
  lines.forEach((text, i) => {
    for (const m of text.matchAll(/https?:\/\/[^\s'"`<>()\]\\]+/g)) {
      const host = m[0].match(/^https?:\/\/([^/:?#$]+)/)?.[1]?.toLowerCase() ?? '';
      if (HARMLESS_HOSTS.has(host) || flaggedUrls.has(m[0])) continue;
      if (rel(p) === 'src/detect/mediapipe.ts' && MEDIAPIPE_FALLBACK_HOSTS.has(host)) {
        fallbackCount++;
        continue;
      }
      unexpected.push(`${rel(p)}:${i + 1} ${m[0]}`);
    }
  });
}
if (fallbackCount) info('src/detect/mediapipe.ts has CDN fallbacks; they are used only if a file in section 3 is missing');
if (unexpected.length === 0) ok(`no web fonts or other remote URLs in ${scanFiles.length} files (the UI uses the system font)`);
else for (const u of unexpected) warn(`remote URL: ${u} (check it is not fetched at run time)`);

// ---------------------------------------------------------------------------------------------
section('6. Keys in .env (yes / no only) and what they mean without a network');
const envText = readText(join(root, '.env'));
if (envText === null) {
  warn('.env is missing: everything runs from the cache and voice is off (cp .env.example .env, then add the keys)');
} else {
  const env = {};
  for (const raw of envText.split('\n')) {
    const m = raw.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (/^["']/.test(v)) v = v.slice(1, v.indexOf(v[0], 1) > 0 ? v.indexOf(v[0], 1) : undefined);
    else v = v.replace(/\s+#.*$/, '');
    env[m[1]] = v.trim();
  }
  const set = (k) => Boolean(env[k]);
  const mock = env.MOCK === '1';
  const yn = (b) => (b ? 'yes' : 'no');
  info(
    `ANTHROPIC_API_KEY ${yn(set('ANTHROPIC_API_KEY'))}, FAL_KEY ${yn(set('FAL_KEY'))}, ELEVENLABS_API_KEY + ELEVENLABS_AGENT_ID ${yn(
      set('ELEVENLABS_API_KEY') && set('ELEVENLABS_AGENT_ID'),
    )}, MOCK=${mock ? '1' : '0'}`,
  );
  if (mock) warn('MOCK=1: every route answers from the cache and voice is off too');
  else {
    if (!(set('ELEVENLABS_API_KEY') && set('ELEVENLABS_AGENT_ID'))) warn('no ElevenLabs keys: voice is off (the hidden keys and the mouse still work)');
    else info('voice: needs the network (ElevenLabs); without it the pill says "Voice off" and the hidden keys still work');
    if (set('ANTHROPIC_API_KEY'))
      info('Claude: names objects when online; with no network the MacBook and hand still open (identify falls back to the detector label). On slow Wi-Fi, comment the key out and restart so "analyse" never waits for Claude');
    else info('no Claude key: the MacBook and hand open from the cache; other objects cannot be analysed');
    if (set('FAL_KEY')) info('fal: only asked for parts without a model (none for the MacBook, never for hands)');
  }
}

// ---------------------------------------------------------------------------------------------
console.log('');
if (failures) console.log(`Result: FAIL, ${failures} problem(s)${warnings ? ` and ${warnings} warning(s)` : ''}. Fix the FAIL lines before the Wi-Fi goes.`);
else console.log(`Result: PASS${warnings ? ` with ${warnings} warning(s)` : ''}.`);
console.log('Works with the Wi-Fi off: camera, object labels, hand tracking and gestures, the muscle overlay, the hidden keys and mouse, and the cached MacBook and hand (parts lists and models).');
console.log('Needs the network: the voice session (ElevenLabs), Claude naming or listing an object that is not cached, and live fal models.');
process.exit(failures ? 1 : 0);
