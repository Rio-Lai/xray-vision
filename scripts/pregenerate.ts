/**
 * Generate every missing part mesh for one teardown with fal, for a human to review.
 *
 *   npm run pregenerate -- <object_id | path/to/<object_id>.json> [--white]
 *   npm run pregenerate -- <object_id> --promote        (no fal calls; see below)
 *
 * Generate (spends fal credit, about $0.45 a part textured, $0.15 with --white):
 *   - Reads public/cache/<object_id>.json (or .cache-live/<object_id>.json).
 *   - Refuses teardowns with "mesh_source": "procedural" (built by code, e.g. scripts/build-eye.ts)
 *     and hand teardowns (the hand overlay ignores mesh_url).
 *   - SKIPS any part that already has a GLB in public/cache/meshes/<id>/ or the review folder:
 *     a part that has been paid for is never generated again. To redo a part, delete its GLB first.
 *   - Runs up to 4 parts at once. Saves .cache-live/review/<object_id>.json after EACH part,
 *     so a crash or a failure never loses finished parts.
 *   - After "balance exhausted" no new parts are started and nothing is retried.
 *   - Prints OK/FAIL, seconds and request ids per part, then a summary table.
 *     The run is also logged to .cache-live/review/<object_id>.runs.json.
 *
 * Promote (after you have looked at the GLBs, e.g. at https://gltf-viewer.donmccurdy.com):
 *   compresses each GLB (1024 px JPEG textures, quantized geometry), then
 *   copies every reviewed GLB not yet in public/cache/meshes/<id>/ there and sets its mesh_url in
 *   public/cache/<object_id>.json. Nothing is generated.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { TeardownSchema, type Teardown } from '../shared/teardown';
import { partPrompt } from '../shared/prompts';
import { CHECKED_DIR, LIVE_DIR, safeId, writeJson, writeMeshEntry } from '../server/lib/cache';
import { downloadFalFile, generateMesh, isBalanceError } from '../server/lib/fal';
import { hasFal } from '../server/lib/env';

const CONCURRENCY = 4;

interface PartResult {
  id: string;
  status: 'OK' | 'FAIL' | 'SKIP' | 'NOT STARTED';
  seconds?: number;
  image_request_id?: string;
  mesh_request_id?: string;
  note?: string;
}

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function readRaw(file: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    die(`Could not read ${file}: ${err instanceof Error ? err.message : err}`);
  }
}

/** Accept "macbook-air-m3-13" or "public/cache/macbook-air-m3-13.json". */
function resolveSource(arg: string): { objectId: string; file: string } {
  if (arg.endsWith('.json')) {
    const file = path.resolve(arg);
    if (!fs.existsSync(file)) die(`No such file: ${arg}`);
    return { objectId: safeId(path.basename(file, '.json')), file };
  }
  const objectId = safeId(arg);
  const checked = path.join(CHECKED_DIR, `${objectId}.json`);
  const live = path.join(LIVE_DIR, `${objectId}.json`);
  const file = fs.existsSync(checked) ? checked : fs.existsSync(live) ? live : '';
  if (!file) die(`No teardown found for ${objectId} in public/cache/ or .cache-live/.`);
  return { objectId, file };
}

function table(rows: PartResult[]) {
  const head = ['part', 'result', 'secs', 'image request', 'mesh request', 'note'];
  const body = rows.map((r) => [
    r.id,
    r.status,
    r.seconds === undefined ? '' : String(r.seconds),
    r.image_request_id ?? '',
    r.mesh_request_id ?? '',
    (r.note ?? '').slice(0, 90),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log('\n' + line(head));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const b of body) console.log(line(b));
}

/**
 * Shrink a fal GLB for committing: textures to 1024 px JPEG, geometry welded and quantized.
 * Hunyuan returns ~3-5 MB per part, mostly a 2048 px PNG texture; this keeps the look at a fraction of the size.
 */
async function compressGlb(src: string, dst: string): Promise<{ before: number; after: number }> {
  const { NodeIO } = await import('@gltf-transform/core');
  const { KHRONOS_EXTENSIONS } = await import('@gltf-transform/extensions');
  const { dedup, prune, quantize, textureCompress, weld } = await import('@gltf-transform/functions');
  const sharp = (await import('sharp')).default;
  const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS);
  const doc = await io.read(src);
  await doc.transform(
    dedup(),
    weld(),
    prune(),
    textureCompress({ encoder: sharp, targetFormat: 'jpeg', resize: [1024, 1024], quality: 85 }),
    quantize(),
  );
  const out = await io.writeBinary(doc);
  fs.writeFileSync(dst, out);
  return { before: fs.statSync(src).size, after: out.byteLength };
}

async function promote(objectId: string, file: string) {
  const meshUrl = (id: string) => `/cache/meshes/${objectId}/${id}.glb`;
  const reviewMeshDir = path.join(LIVE_DIR, 'review', 'meshes', objectId);
  const publicMeshDir = path.join(CHECKED_DIR, 'meshes', objectId);
  if (!file.startsWith(CHECKED_DIR)) die('Only teardowns in public/cache/ can be promoted.');
  const raw = readRaw(file);
  const parts = Array.isArray(raw.parts) ? (raw.parts as Record<string, unknown>[]) : [];
  // Edit only the mesh_url lines in place, so a teammate's hand-formatted JSON keeps its layout (small diffs).
  let text = fs.readFileSync(file, 'utf8');
  let copied = 0;
  for (const p of parts) {
    const id = safeId(String(p.id));
    const src = path.join(reviewMeshDir, `${id}.glb`);
    const dst = path.join(publicMeshDir, `${id}.glb`);
    if (!fs.existsSync(dst) && fs.existsSync(src)) {
      fs.mkdirSync(publicMeshDir, { recursive: true });
      const { before, after } = await compressGlb(src, dst);
      copied++;
      console.log(`[promote] ${id}.glb -> ${path.relative(process.cwd(), dst)}  ${(before / 1e6).toFixed(1)} MB -> ${(after / 1e6).toFixed(2)} MB`);
    }
    if (fs.existsSync(dst)) {
      const esc = String(p.id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      text = text.replace(new RegExp(`("id":\\s*"${esc}",[\\s\\S]*?"mesh_url":\\s*)(null|"[^"]*")`), `$1"${meshUrl(id)}"`);
    }
  }
  fs.writeFileSync(file, text);
  console.log(`[promote] ${copied} GLB(s) copied; mesh_url updated in ${path.relative(process.cwd(), file)}`);
}

async function main() {
  const args = process.argv.slice(2);
  const textured = !args.includes('--white');
  const idArg = args.find((a) => !a.startsWith('--'));
  if (!idArg) die('usage: npm run pregenerate -- <object_id | teardown.json> [--white | --promote]');

  const { objectId, file } = resolveSource(idArg);
  const raw = readRaw(file);

  if (raw.mesh_source === 'procedural') {
    die(`[pregenerate] ${objectId} has "mesh_source": "procedural": its meshes are built by code, not fal. Nothing to do.`);
  }
  if (typeof raw.note === 'string' && /do not run pregenerate/i.test(raw.note)) die(`[pregenerate] ${raw.note}`);
  if (raw.anchor === 'hand') die(`[pregenerate] ${objectId} is a hand teardown; the hand overlay ignores mesh_url.`);

  if (args.includes('--promote')) return await promote(objectId, file);

  const parsed = TeardownSchema.safeParse(raw);
  if (!parsed.success) die(`[pregenerate] ${file} does not match TeardownSchema: ${JSON.stringify(parsed.error.issues.slice(0, 3))}`);
  if (!hasFal()) die('FAL_KEY is not set (or MOCK=1). Add it to .env first.');

  const reviewDir = path.join(LIVE_DIR, 'review');
  const reviewMeshDir = path.join(reviewDir, 'meshes', objectId);
  const publicMeshDir = path.join(CHECKED_DIR, 'meshes', objectId);
  fs.mkdirSync(reviewMeshDir, { recursive: true });
  const outFile = path.join(reviewDir, `${objectId}.json`);
  const imagesFile = path.join(reviewDir, `${objectId}.images.json`);
  const runsFile = path.join(reviewDir, `${objectId}.runs.json`);
  const meshUrl = (id: string) => `/cache/meshes/${objectId}/${id}.glb`;

  const td: Teardown = structuredClone(parsed.data);
  const images: Record<string, string> = fs.existsSync(imagesFile) ? JSON.parse(fs.readFileSync(imagesFile, 'utf8')) : {};
  // Node runs this file on one thread and these writes are synchronous, so saves never interleave.
  const save = () => {
    writeJson(outFile, td);
    writeJson(imagesFile, images);
  };

  const results = new Map<string, PartResult>();
  const queue: Teardown['parts'] = [];
  for (const part of td.parts) {
    const id = safeId(part.id);
    const existing = [path.join(publicMeshDir, `${id}.glb`), path.join(reviewMeshDir, `${id}.glb`)].find((f) => fs.existsSync(f));
    if (existing) {
      part.mesh_url = meshUrl(id);
      results.set(part.id, { id: part.id, status: 'SKIP', note: `GLB exists: ${path.relative(process.cwd(), existing)}` });
    } else {
      part.mesh_url = null;
      queue.push(part);
      results.set(part.id, { id: part.id, status: 'NOT STARTED' });
    }
  }
  save();

  const cost = (queue.length * (textured ? 0.45 : 0.15)).toFixed(2);
  console.log(
    `[pregenerate] ${objectId}: ${queue.length} of ${td.parts.length} parts to generate (${textured ? 'textured' : 'white'}, about $${cost}); ${td.parts.length - queue.length} skipped`,
  );

  let stop = false;
  const worker = async () => {
    while (!stop && queue.length > 0) {
      const part = queue.shift()!;
      const id = safeId(part.id);
      const started = Date.now();
      const secs = () => Math.round((Date.now() - started) / 100) / 10;
      try {
        const out = await generateMesh(partPrompt(td, part), textured);
        fs.writeFileSync(path.join(reviewMeshDir, `${id}.glb`), await downloadFalFile(out.mesh_url));
        writeMeshEntry(`${objectId}/${id}`, { image_url: out.image_url, mesh_url: out.mesh_url });
        part.mesh_url = meshUrl(id);
        images[part.id] = out.image_url;
        save();
        results.set(part.id, { id: part.id, status: 'OK', seconds: secs(), image_request_id: out.image_request_id, mesh_request_id: out.mesh_request_id });
        console.log(`[pregenerate] OK   ${part.id}  ${secs()} s  image ${out.image_request_id ?? '?'}  mesh ${out.mesh_request_id ?? '?'}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const requestId = err && typeof err === 'object' && 'requestId' in err ? String((err as { requestId?: string }).requestId ?? '') : '';
        results.set(part.id, { id: part.id, status: 'FAIL', seconds: secs(), mesh_request_id: requestId || undefined, note: msg });
        console.error(`[pregenerate] FAIL ${part.id}  ${secs()} s  ${requestId ? `request ${requestId}  ` : ''}${msg}`);
        if (isBalanceError(err)) {
          stop = true;
          console.error('[pregenerate] fal balance exhausted: starting no more parts and retrying nothing.');
        }
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  save();

  const rows = td.parts.map((p) => results.get(p.id)!);
  table(rows);
  const runs = fs.existsSync(runsFile) ? JSON.parse(fs.readFileSync(runsFile, 'utf8')) : [];
  runs.push({ at: new Date().toISOString(), textured, results: rows });
  writeJson(runsFile, runs);

  const failed = rows.filter((r) => r.status === 'FAIL' || r.status === 'NOT STARTED').length;
  console.log(`\n[pregenerate] review JSON: ${path.relative(process.cwd(), outFile)}`);
  console.log(`[pregenerate] meshes: ${path.relative(process.cwd(), reviewMeshDir)}`);
  if (stop) console.log('[pregenerate] STOPPED: fal balance exhausted. Top up before re-running.');
  else if (failed) console.log(`[pregenerate] ${failed} part(s) missing. Re-run the same command once to try only those.`);
  console.log(`[pregenerate] when happy: npm run pregenerate -- ${objectId} --promote`);
  process.exit(failed ? 2 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
