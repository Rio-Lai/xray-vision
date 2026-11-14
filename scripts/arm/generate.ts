/**
 * fal generation for the X-ray arm, in stages so a human can check between them.
 *
 *   npx tsx scripts/arm/generate.ts images [ids...] [--model fal-ai/flux-pro/v1.1] [--dir <folder>]
 *   npx tsx scripts/arm/generate.ts sheet  [ids...] [--dir <folder>] [--out file.png]   (candidates side by side)
 *   npx tsx scripts/arm/generate.ts pick   biceps=a triceps=b ...                         (record the chosen candidate)
 *   npx tsx scripts/arm/generate.ts meshes [ids...] [--model fal-ai/hunyuan-3d/v3.1/pro/image-to-3d]
 *   npx tsx scripts/arm/generate.ts cost                                                  (running fal spend)
 *
 * Never regenerates something that exists (delete the file to redo it). Stops after "balance exhausted".
 * Raw meshes go to .cache-live/arm-hand/raw/ (gitignored); scripts/arm/normalise.ts turns them into
 * public/cache/arm-hand/<id>.glb.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { downloadFalFile, falRun, generateImages, isBalanceError, isFalUrl } from '../../server/lib/fal';
import { imagePrompt, SPECS, type MeshSpec } from './specs';

const ROOT = process.cwd();
const ARM = path.join(ROOT, 'public', 'cache', 'arm-hand');
const IMG_DIR = path.join(ARM, 'images');
const LIVE = path.join(ROOT, '.cache-live', 'arm-hand');
const RAW = path.join(LIVE, 'raw');
const LEDGER = path.join(LIVE, 'ledger.json');
const CHOICES = path.join(IMG_DIR, 'choices.json');
const META = path.join(IMG_DIR, 'images.json');

export const IMAGE_MODEL_DEFAULT = 'fal-ai/flux-pro/v1.1';
export const MESH_MODEL_DEFAULT = 'fal-ai/hunyuan-3d/v3.1/pro/image-to-3d';

/** Estimated USD per call, from fal's model pages (checked 14 Nov 2026). */
function estimate(model: string, images = 1): number {
  if (model === 'fal-ai/flux/schnell') return 0.003 * 1.05 * images;
  if (model === 'fal-ai/flux/dev') return 0.025 * images;
  if (model.startsWith('fal-ai/flux-pro')) return 0.04 * images;
  if (model === 'fal-ai/hunyuan3d/v2/turbo') return 0.42;
  if (model.includes('hunyuan-3d/v3.1/pro')) return 0.375;
  if (model.includes('hunyuan3d-v3')) return 0.375;
  return 0.5; // unknown: assume the worst
}

const readJson = <T>(f: string, d: T): T => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d);
const writeJson = (f: string, v: unknown) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n');
};

interface LedgerRow {
  at: string;
  what: string;
  model: string;
  usd: number;
  request_id?: string;
  ok: boolean;
}
function ledger(row: LedgerRow) {
  const rows = readJson<LedgerRow[]>(LEDGER, []);
  rows.push(row);
  writeJson(LEDGER, rows);
}
export function spentUsd(): number {
  return readJson<LedgerRow[]>(LEDGER, []).filter((r) => r.ok).reduce((s, r) => s + r.usd, 0);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
function selected(args: string[]): MeshSpec[] {
  const skip = new Set<string>();
  args.forEach((a, i) => {
    if (a.startsWith('--')) skip.add(String(i + 1));
  });
  const ids = args.filter((a, i) => !a.startsWith('--') && !skip.has(String(i)));
  const unknown = ids.filter((id) => !SPECS.some((s) => s.id === id));
  if (unknown.length) throw new Error(`unknown mesh ids: ${unknown.join(', ')}`);
  return ids.length ? SPECS.filter((s) => ids.includes(s.id)) : SPECS;
}

/** Run jobs with limited parallelism; stop starting new ones after a balance error. */
async function pool<T>(items: T[], n: number, job: (t: T) => Promise<void>) {
  let stop = false;
  const queue = [...items];
  const worker = async () => {
    while (!stop && queue.length) {
      const it = queue.shift()!;
      try {
        await job(it);
      } catch (err) {
        if (isBalanceError(err)) {
          stop = true;
          console.error('[arm] fal balance exhausted: starting nothing else, retrying nothing.');
        }
        console.error(`[arm] FAIL: ${err instanceof Error ? err.message : err}`);
      }
    }
  };
  await Promise.all(Array.from({ length: n }, worker));
  return stop;
}

async function images(args: string[]) {
  const model = flag(args, '--model') ?? IMAGE_MODEL_DEFAULT;
  const dir = path.resolve(flag(args, '--dir') ?? IMG_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const meta = readJson<Record<string, unknown>>(path.join(dir, 'images.json'), {});
  const todo = selected(args).filter((s) => !fs.existsSync(path.join(dir, `${s.id}-a.png`)));
  console.log(`[arm] images: ${todo.length} parts x 2 candidates with ${model} (~$${(todo.length * estimate(model, 2)).toFixed(2)})`);
  await pool(todo, 4, async (s) => {
    const t0 = Date.now();
    const prompt = imagePrompt(s);
    try {
      const r = await generateImages(prompt, model, 2);
      const files: string[] = [];
      for (const [k, url] of r.urls.entries()) {
        const f = `${s.id}-${'ab'[k]}.png`;
        fs.writeFileSync(path.join(dir, f), await downloadFalFile(url));
        files.push(f);
      }
      meta[s.id] = { model, prompt, request_id: r.requestId, files };
      writeJson(path.join(dir, 'images.json'), meta);
      ledger({ at: new Date().toISOString(), what: `images ${s.id}`, model, usd: estimate(model, r.urls.length), request_id: r.requestId, ok: true });
      console.log(`[arm] OK   images ${s.id.padEnd(20)} ${((Date.now() - t0) / 1000).toFixed(1)} s  request ${r.requestId}`);
    } catch (err) {
      ledger({ at: new Date().toISOString(), what: `images ${s.id}`, model, usd: 0, ok: false });
      throw err;
    }
  });
  console.log(`[arm] running fal spend for the arm: $${spentUsd().toFixed(2)}`);
}

/** Candidates side by side (a | b per row), labelled, for choosing by eye. */
async function sheet(args: string[]) {
  const dir = path.resolve(flag(args, '--dir') ?? IMG_DIR);
  const out = path.resolve(flag(args, '--out') ?? path.join(LIVE, 'candidates.png'));
  const specs = selected(args).filter((s) => fs.existsSync(path.join(dir, `${s.id}-a.png`)));
  const W = 300;
  const rows = await Promise.all(
    specs.map(async (s) => {
      const tiles = await Promise.all(
        ['a', 'b'].map(async (k) => {
          const f = path.join(dir, `${s.id}-${k}.png`);
          return fs.existsSync(f) ? sharp(f).resize(W, W).png().toBuffer() : sharp({ create: { width: W, height: W, channels: 3, background: '#ccc' } }).png().toBuffer();
        }),
      );
      return { s, tiles };
    }),
  );
  const LABEL = 26;
  const H = rows.length * (W + LABEL);
  const comp: sharp.OverlayOptions[] = [];
  rows.forEach(({ s, tiles }, r) => {
    const y = r * (W + LABEL);
    const svg = `<svg width="${2 * W}" height="${LABEL}"><rect width="100%" height="100%" fill="#222"/><text x="8" y="18" font-family="Helvetica" font-size="15" fill="#fff">${s.id}   (a | b)</text></svg>`;
    comp.push({ input: Buffer.from(svg), left: 0, top: y });
    tiles.forEach((t, k) => comp.push({ input: t, left: k * W, top: y + LABEL }));
  });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await sharp({ create: { width: 2 * W, height: H, channels: 3, background: '#222' } }).composite(comp).png().toFile(out);
  console.log(out);
}

function pick(args: string[]) {
  const choices = readJson<Record<string, string>>(CHOICES, {});
  for (const a of args) {
    const [id, k] = a.split('=');
    if (!SPECS.some((s) => s.id === id) || !['a', 'b'].includes(k)) throw new Error(`bad choice ${a} (use id=a or id=b)`);
    choices[id] = k;
  }
  writeJson(CHOICES, choices);
  console.log(`[arm] choices: ${Object.entries(choices).map(([i, k]) => `${i}=${k}`).join(' ')}`);
}

/** Crop a white-background product image to the object's bounding box plus a small margin. */
async function cropToSubject(file: string): Promise<Buffer> {
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      // "not background": clearly darker or more saturated than the near-white backdrop (ignores soft shadows)
      const mx = Math.max(data[i], data[i + 1], data[i + 2]);
      const mn = Math.min(data[i], data[i + 1], data[i + 2]);
      if (mx < 200 || mx - mn > 40) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  if (x1 < 0) return fs.readFileSync(file);
  const pad = Math.round(0.04 * Math.max(x1 - x0, y1 - y0)) + 4;
  // fal accepts 128..5000 px per side: grow a very thin crop symmetrically to at least MIN px.
  const MIN = 160;
  const grow = (a: number, b: number, size: number): [number, number] => {
    const need = Math.max(0, MIN - (b - a));
    let lo = a - Math.ceil(need / 2);
    let hi = b + Math.floor(need / 2);
    if (lo < 0) [lo, hi] = [0, hi - lo];
    if (hi > size) [lo, hi] = [Math.max(0, lo - (hi - size)), size];
    return [lo, hi];
  };
  const [left, right] = grow(Math.max(0, x0 - pad), Math.min(w, x1 + pad + 1), w);
  const [top, bottom] = grow(Math.max(0, y0 - pad), Math.min(h, y1 + pad + 1), h);
  const width = right - left;
  const height = bottom - top;
  return sharp(file).extract({ left, top, width, height }).png().toBuffer();
}

async function meshes(args: string[]) {
  const model = flag(args, '--model') ?? MESH_MODEL_DEFAULT;
  const tag = flag(args, '--tag') ?? '';
  const choices = readJson<Record<string, string>>(CHOICES, {});
  const meta = readJson<Record<string, { request_id?: string }>>(META, {});
  fs.mkdirSync(RAW, { recursive: true });
  const rawFile = (id: string) => path.join(RAW, `${id}${tag}.glb`);
  const todo = selected(args).filter((s) => choices[s.id] && !fs.existsSync(rawFile(s.id)));
  const missing = selected(args).filter((s) => !choices[s.id]).map((s) => s.id);
  if (missing.length) console.log(`[arm] no image chosen yet (skipped): ${missing.join(', ')}`);
  console.log(`[arm] meshes: ${todo.length} with ${model} (~$${(todo.length * estimate(model)).toFixed(2)})`);
  const runs = readJson<unknown[]>(path.join(LIVE, 'mesh-runs.json'), []);
  // fal needs a URL: upload the chosen local image to fal storage first.
  const { fal } = await import('@fal-ai/client');
  fal.config({ credentials: process.env.FAL_KEY });
  const stopped = await pool(todo, 4, async (s) => {
    const t0 = Date.now();
    const img = path.join(IMG_DIR, `${s.id}-${choices[s.id]}.png`);
    // Hunyuan 3D v3.1 rejects images where the object fills < 50% of the frame (thin nerves and tendons on a
    // big white square). Crop tightly around the object first; harmless for the others.
    const imageUrl = await fal.storage.upload(new Blob([new Uint8Array(await cropToSubject(img))], { type: 'image/png' }));
    if (!isFalUrl(imageUrl)) throw new Error(`upload returned a non-fal url for ${s.id}`);
    const input: Record<string, unknown> = model.includes('hunyuan3d/v2')
      ? { input_image_url: imageUrl, textured_mesh: true }
      : { input_image_url: imageUrl, generate_type: 'Normal' };
    try {
      const r = await falRun(model, input);
      const d = r.data as Record<string, { url?: string } | undefined>;
      const url = d.model_glb?.url ?? d.model_mesh?.url;
      if (!url) throw new Error(`${model} returned no GLB for ${s.id}`);
      fs.writeFileSync(rawFile(s.id), await downloadFalFile(url));
      const secs = (Date.now() - t0) / 1000;
      ledger({ at: new Date().toISOString(), what: `mesh ${s.id}${tag}`, model, usd: estimate(model), request_id: r.requestId, ok: true });
      runs.push({ id: s.id + tag, model, seconds: Math.round(secs), image_request_id: meta[s.id]?.request_id, mesh_request_id: r.requestId, ok: true });
      writeJson(path.join(LIVE, 'mesh-runs.json'), runs);
      console.log(`[arm] OK   mesh ${(s.id + tag).padEnd(22)} ${secs.toFixed(0)} s  request ${r.requestId}  ${(fs.statSync(rawFile(s.id)).size / 1e6).toFixed(1)} MB`);
    } catch (err) {
      runs.push({ id: s.id + tag, model, seconds: Math.round((Date.now() - t0) / 1000), ok: false, error: err instanceof Error ? err.message : String(err) });
      writeJson(path.join(LIVE, 'mesh-runs.json'), runs);
      ledger({ at: new Date().toISOString(), what: `mesh ${s.id}${tag}`, model, usd: 0, ok: false });
      throw err;
    }
  });
  if (stopped) console.log('[arm] STOPPED: fal balance exhausted.');
  console.log(`[arm] running fal spend for the arm: $${spentUsd().toFixed(2)}`);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'images') return images(args);
  if (cmd === 'sheet') return sheet(args);
  if (cmd === 'pick') return pick(args);
  if (cmd === 'meshes') return meshes(args);
  if (cmd === 'cost') return console.log(`[arm] fal spend for the arm so far: $${spentUsd().toFixed(2)}`);
  console.error('usage: generate.ts images|sheet|pick|meshes|cost [ids...]');
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
