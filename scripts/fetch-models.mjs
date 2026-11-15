#!/usr/bin/env node
/**
 * Downloads the MediaPipe models into public/models/ and copies the tasks-vision wasm files into
 * public/models/wasm/ so the demo works offline (no CDN, no storage.googleapis.com at demo time).
 *
 *   node scripts/fetch-models.mjs          # skip files that already exist
 *   node scripts/fetch-models.mjs --force  # re-download everything
 *
 * Node 18+ (uses global fetch).
 */
import { access, copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'models');
const wasmOut = join(outDir, 'wasm');
const force = process.argv.includes('--force');
const FALLBACK_VERSION = '0.10.14';

const MODELS = [
  {
    file: 'efficientdet_lite0.tflite',
    url: 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite',
  },
  {
    // sharper object labels (#110); the app falls back to Lite0 above without it
    file: 'efficientdet_lite2.tflite',
    url: 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite2/float16/1/efficientdet_lite2.tflite',
  },
  {
    file: 'hand_landmarker.task',
    url: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  },
  {
    // eyes for "analyse the eye" (#94): face landmarks with irises, blendshapes, head pose
    file: 'face_landmarker.task',
    url: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  },
];

const WASM_FILES = [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  'vision_wasm_nosimd_internal.js',
  'vision_wasm_nosimd_internal.wasm',
];

async function exists(p) {
  try {
    await access(p);
    const s = await stat(p);
    return s.size > 0;
  } catch {
    return false;
  }
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buf);
  return buf.length;
}

function mb(n) {
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function main() {
  await mkdir(wasmOut, { recursive: true });
  let failed = 0;

  for (const m of MODELS) {
    const dest = join(outDir, m.file);
    if (!force && (await exists(dest))) {
      console.log(`ok    ${m.file} (already there)`);
      continue;
    }
    try {
      const n = await download(m.url, dest);
      console.log(`got   ${m.file} ${mb(n)}`);
    } catch (e) {
      failed++;
      console.error(`FAIL  ${m.file}: ${e instanceof Error ? e.message : e}`);
    }
  }

  // wasm: copy from the installed package (exact version match), else download from jsDelivr.
  const pkgDir = join(root, 'node_modules', '@mediapipe', 'tasks-vision');
  let version = FALLBACK_VERSION;
  let copied = false;
  try {
    const pkg = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8'));
    version = pkg.version || version;
    const files = await readdir(join(pkgDir, 'wasm'));
    for (const f of files) await copyFile(join(pkgDir, 'wasm', f), join(wasmOut, f));
    copied = true;
    console.log(`ok    wasm copied from node_modules (tasks-vision ${version}, ${files.length} files)`);
  } catch {
    console.log('info  node_modules/@mediapipe/tasks-vision not found, downloading wasm from jsDelivr');
  }
  if (!copied) {
    for (const f of WASM_FILES) {
      const dest = join(wasmOut, f);
      if (!force && (await exists(dest))) {
        console.log(`ok    wasm/${f} (already there)`);
        continue;
      }
      try {
        const n = await download(`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${version}/wasm/${f}`, dest);
        console.log(`got   wasm/${f} ${mb(n)}`);
      } catch (e) {
        failed++;
        console.error(`FAIL  wasm/${f}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
  await writeFile(join(wasmOut, 'VERSION'), `${version}\n`);

  if (failed) {
    console.error(`\n${failed} file(s) failed. The app falls back to the CDN / storage.googleapis.com when online.`);
    process.exit(1);
  }
  console.log(`\nDone. Models in ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
