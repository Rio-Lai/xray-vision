/**
 * fal generation for the iPhone 17 Pro INTERNAL parts (the exterior is built in code: build-exterior.ts).
 *
 *   npx tsx scripts/iphone/generate.ts images [ids...]     2 flux-pro candidates per part -> public/cache/iphone-17-pro/images/
 *   npx tsx scripts/iphone/generate.ts sheet               candidates side by side -> .cache-live/iphone/candidates.png
 *   npx tsx scripts/iphone/generate.ts pick id=a id=b ...  record choices
 *   npx tsx scripts/iphone/generate.ts meshes [ids...]     Hunyuan 3D v3.1 Pro -> .cache-live/iphone/raw/<id>.glb
 * Never regenerates a file that exists. Stops after "balance exhausted".
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { fal } from '@fal-ai/client';
import { downloadFalFile, falRun, generateImages, isBalanceError, isFalUrl } from '../../server/lib/fal';

export const INTERNALS: { id: string; looks: string }[] = [
  { id: 'face-id', looks: 'the Face ID TrueDepth camera module removed from inside a smartphone: a slim black rectangular bar about 3 cm long holding a small infrared camera, a dot projector and a flood illuminator, with a short gold flex ribbon cable' },
  { id: 'logic-board', looks: 'a compact smartphone logic board removed from a phone: a dense dark green multi-layer circuit board, wide and short, crowded with a large square processor chip with a metal lid, memory chips, tiny black components, gold board-to-board connectors' },
  { id: 'vapour-chamber', looks: 'a thin flat copper vapour chamber cooling plate from a smartphone: one rectangular sheet of brushed copper with rounded corners and a slightly raised sealed edge, about 6 cm wide' },
  { id: 'battery', looks: 'a flat rectangular lithium-ion smartphone battery cell inside a thin brushed stainless steel metal tray, with a short black flex connector at one end' },
  { id: 'taptic-engine', looks: 'a smartphone haptic Taptic Engine vibration motor: a small elongated dark grey metal box about 3 cm long with mounting tabs and a short flex cable' },
  { id: 'usb-c', looks: 'a smartphone USB-C charging port assembly: a small metal USB-C socket mounted on a thin black flex circuit with a few tiny components' },
  { id: 'speaker', looks: 'a small smartphone loudspeaker module: a black plastic rectangular enclosure about 2 cm long with a fine metal mesh grille at one end and two gold contact pads' },
];

const ROOT = process.cwd();
const IMG = path.join(ROOT, 'public/cache/iphone-17-pro/images');
const LIVE = path.join(ROOT, '.cache-live/iphone');
const RAW = path.join(LIVE, 'raw');
const CHOICES = path.join(IMG, 'choices.json');
const META = path.join(IMG, 'images.json');
const LEDGER = path.join(LIVE, 'ledger.json');
const IMAGE_MODEL = 'fal-ai/flux-pro/v1.1';
const MESH_MODEL = 'fal-ai/hunyuan-3d/v3.1/pro/image-to-3d';

const rd = <T>(f: string, d: T): T => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d);
const wr = (f: string, v: unknown) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n');
};
const spend = (what: string, usd: number, request_id?: string) => {
  const rows = rd<{ usd: number }[]>(LEDGER, []);
  rows.push({ at: new Date().toISOString(), what, usd, request_id } as never);
  wr(LEDGER, rows);
  return rows.reduce((s, r) => s + r.usd, 0);
};
const prompt = (looks: string) =>
  `Studio product photograph of one single isolated electronic component on a plain white background: ${looks}. ` +
  `Teardown photo, the whole part in frame and filling most of the image, sharp, realistic, nothing else in the image, no text, no logo.`;
const pick = (args: string[]) => {
  const ids = args.filter((a) => !a.startsWith('--'));
  return ids.length ? INTERNALS.filter((p) => ids.includes(p.id)) : INTERNALS;
};

async function pool<T>(items: T[], n: number, job: (t: T) => Promise<void>) {
  let stop = false;
  const q = [...items];
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (!stop && q.length) {
        const it = q.shift()!;
        try {
          await job(it);
        } catch (e) {
          if (isBalanceError(e)) {
            stop = true;
            console.error('[iphone] fal balance exhausted: stopping, not retrying.');
          }
          console.error(`[iphone] FAIL ${e instanceof Error ? e.message.slice(0, 300) : e}`);
        }
      }
    }),
  );
}

async function cropToSubject(file: string): Promise<Buffer> {
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const mx = Math.max(data[i], data[i + 1], data[i + 2]);
      const mn = Math.min(data[i], data[i + 1], data[i + 2]);
      if (mx < 200 || mx - mn > 40) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
    }
  if (x1 < 0) return fs.readFileSync(file);
  const pad = Math.round(0.04 * Math.max(x1 - x0, y1 - y0)) + 4;
  const grow = (a: number, b: number, size: number): [number, number] => {
    const need = Math.max(0, 160 - (b - a));
    let lo = a - Math.ceil(need / 2), hi = b + Math.floor(need / 2);
    if (lo < 0) [lo, hi] = [0, hi - lo];
    if (hi > size) [lo, hi] = [Math.max(0, lo - (hi - size)), size];
    return [lo, hi];
  };
  const [l, r] = grow(Math.max(0, x0 - pad), Math.min(w, x1 + pad + 1), w);
  const [t, b] = grow(Math.max(0, y0 - pad), Math.min(h, y1 + pad + 1), h);
  return sharp(file).extract({ left: l, top: t, width: r - l, height: b - t }).png().toBuffer();
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'images') {
    fs.mkdirSync(IMG, { recursive: true });
    const meta = rd<Record<string, unknown>>(META, {});
    const todo = pick(args).filter((p) => !fs.existsSync(path.join(IMG, `${p.id}-a.png`)));
    console.log(`[iphone] images: ${todo.length} parts x 2 (~$${(todo.length * 0.08).toFixed(2)})`);
    await pool(todo, 4, async (p) => {
      const r = await generateImages(prompt(p.looks), IMAGE_MODEL, 2);
      for (const [k, u] of r.urls.entries()) fs.writeFileSync(path.join(IMG, `${p.id}-${'ab'[k]}.png`), await downloadFalFile(u));
      meta[p.id] = { model: IMAGE_MODEL, prompt: prompt(p.looks), request_id: r.requestId };
      wr(META, meta);
      const total = spend(`images ${p.id}`, 0.04 * r.urls.length, r.requestId);
      console.log(`[iphone] OK images ${p.id.padEnd(15)} request ${r.requestId}  (new-account spend ~$${total.toFixed(2)})`);
    });
  } else if (cmd === 'sheet') {
    const T = 300, L = 26;
    const rows = INTERNALS.filter((p) => fs.existsSync(path.join(IMG, `${p.id}-a.png`)));
    const comp: sharp.OverlayOptions[] = [];
    for (const [r, p] of rows.entries()) {
      comp.push({ input: Buffer.from(`<svg width="${2 * T}" height="${L}"><rect width="100%" height="100%" fill="#222"/><text x="8" y="18" font-family="Helvetica" font-size="15" fill="#fff">${p.id} (a | b)</text></svg>`), left: 0, top: r * (T + L) });
      for (const [k, s] of ['a', 'b'].entries()) comp.push({ input: await sharp(path.join(IMG, `${p.id}-${s}.png`)).resize(T, T).png().toBuffer(), left: k * T, top: r * (T + L) + L });
    }
    fs.mkdirSync(LIVE, { recursive: true });
    await sharp({ create: { width: 2 * T, height: rows.length * (T + L), channels: 3, background: '#222' } }).composite(comp).png().toFile(path.join(LIVE, 'candidates.png'));
    console.log(path.join(LIVE, 'candidates.png'));
  } else if (cmd === 'pick') {
    const c = rd<Record<string, string>>(CHOICES, {});
    for (const a of args) {
      const [id, k] = a.split('=');
      c[id] = k;
    }
    wr(CHOICES, c);
    console.log(c);
  } else if (cmd === 'meshes') {
    const c = rd<Record<string, string>>(CHOICES, {});
    fs.mkdirSync(RAW, { recursive: true });
    fal.config({ credentials: process.env.FAL_KEY });
    const todo = pick(args).filter((p) => c[p.id] && !fs.existsSync(path.join(RAW, `${p.id}.glb`)));
    console.log(`[iphone] meshes: ${todo.length} with ${MESH_MODEL} (~$${(todo.length * 0.375).toFixed(2)})`);
    const runs = rd<unknown[]>(path.join(LIVE, 'mesh-runs.json'), []);
    await pool(todo, 4, async (p) => {
      const t0 = Date.now();
      const url = await fal.storage.upload(new Blob([new Uint8Array(await cropToSubject(path.join(IMG, `${p.id}-${c[p.id]}.png`)))], { type: 'image/png' }));
      if (!isFalUrl(url)) throw new Error('bad upload url');
      const r = await falRun(MESH_MODEL, { input_image_url: url, generate_type: 'Normal' });
      const glb = (r.data as { model_glb?: { url?: string } }).model_glb?.url;
      if (!glb) throw new Error(`no GLB for ${p.id}`);
      fs.writeFileSync(path.join(RAW, `${p.id}.glb`), await downloadFalFile(glb));
      const secs = Math.round((Date.now() - t0) / 1000);
      runs.push({ id: p.id, seconds: secs, mesh_request_id: r.requestId, image_request_id: (rd<Record<string, { request_id?: string }>>(META, {})[p.id] ?? {}).request_id });
      wr(path.join(LIVE, 'mesh-runs.json'), runs);
      const total = spend(`mesh ${p.id}`, 0.375, r.requestId);
      console.log(`[iphone] OK mesh ${p.id.padEnd(15)} ${secs} s  request ${r.requestId}  (new-account spend ~$${total.toFixed(2)})`);
    });
  } else {
    console.error('usage: generate.ts images|sheet|pick|meshes');
    process.exit(1);
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
