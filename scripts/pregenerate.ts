/**
 * Generate every part mesh for one teardown, for a human to review.
 *
 *   npm run pregenerate -- <object_id> [--force]
 *
 * Reads public/cache/<object_id>.json (or .cache-live/<object_id>.json), runs the fal
 * pipeline for each part without a mesh (all parts with --force), downloads each GLB to
 * .cache-live/review/meshes/<object_id>/<part_id>.glb and writes
 * .cache-live/review/<object_id>.json with mesh_url = /cache/meshes/<object_id>/<part_id>.glb.
 * Nothing under public/ is touched. See docs/KASH.md for how to promote the results.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import type { Teardown } from '../shared/teardown';
import { partPrompt } from '../shared/prompts';
import { LIVE_DIR, readCheckedTeardown, readLiveTeardown, safeId, writeJson, writeMeshEntry } from '../server/lib/cache';
import { generateMesh } from '../server/lib/fal';
import { hasFal } from '../server/lib/env';

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const idArg = args.find((a) => !a.startsWith('--'));
  if (!idArg) {
    console.error('usage: npm run pregenerate -- <object_id> [--force]');
    process.exit(1);
  }
  if (!hasFal()) {
    console.error('FAL_KEY is not set (or MOCK=1). Add it to .env first.');
    process.exit(1);
  }

  const objectId = safeId(idArg);
  const source: Teardown | null = readCheckedTeardown(objectId) ?? readLiveTeardown(objectId);
  if (!source) {
    console.error(`No teardown found for ${objectId} in public/cache/ or .cache-live/.`);
    process.exit(1);
  }

  const reviewDir = path.join(LIVE_DIR, 'review');
  const meshDir = path.join(reviewDir, 'meshes', objectId);
  fs.mkdirSync(meshDir, { recursive: true });
  const outFile = path.join(reviewDir, `${objectId}.json`);
  const imagesFile = path.join(reviewDir, `${objectId}.images.json`);

  const td: Teardown = structuredClone(source);
  const images: Record<string, string> = {};
  const queue = td.parts.filter((p) => force || !p.mesh_url);
  console.log(`[pregenerate] ${objectId}: ${queue.length} of ${td.parts.length} parts to generate`);

  const worker = async () => {
    while (queue.length > 0) {
      const part = queue.shift()!;
      const started = Date.now();
      try {
        const entry = await generateMesh(partPrompt(td, part));
        const r = await fetch(entry.mesh_url);
        if (!r.ok) throw new Error(`download ${r.status}`);
        fs.writeFileSync(path.join(meshDir, `${part.id}.glb`), Buffer.from(await r.arrayBuffer()));
        writeMeshEntry(`${objectId}/${part.id}`, entry);
        part.mesh_url = `/cache/meshes/${objectId}/${part.id}.glb`;
        images[part.id] = entry.image_url;
        writeJson(outFile, td);
        writeJson(imagesFile, images);
        console.log(`[pregenerate] ok   ${part.id} (${Math.round((Date.now() - started) / 1000)} s)`);
      } catch (err) {
        console.error(`[pregenerate] FAIL ${part.id}:`, err instanceof Error ? err.message : err);
      }
    }
  };
  await Promise.all([worker(), worker()]);

  writeJson(outFile, td);
  console.log(`[pregenerate] wrote ${path.relative(process.cwd(), outFile)}`);
  console.log(`[pregenerate] meshes in ${path.relative(process.cwd(), meshDir)}`);
  console.log('[pregenerate] review them, then copy good GLBs into public/cache/meshes/' + objectId + '/');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
