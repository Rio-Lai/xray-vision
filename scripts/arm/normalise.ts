/**
 * Normalise raw fal meshes so ArmXray can place each one between two landmarks:
 *   long axis (principal axis of the vertices) -> +Y, running exactly y = 0 (proximal) to y = 1 (distal),
 *   centred on the axis, sideways proportions kept (uniform scale), simplified, < 2 MB.
 *
 *   npx tsx scripts/arm/normalise.ts [ids...] [--in <dir>] [--out <dir>] [--tag .v31]
 *
 * In:  .cache-live/arm-hand/raw/<id><tag>.glb   Out: public/cache/arm-hand/<id>.glb (+ meshes.json with sizes)
 * Proximal end: from MeshSpec.wideEnd (which end is wider), or FLIP below for parts checked by eye.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { NodeIO, type Document, type Primitive } from '@gltf-transform/core';
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions';
import { clearNodeTransform, dedup, prune, quantize, simplify, textureCompress, transformPrimitive, weld } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import { SPECS, type MeshSpec } from './specs';

/**
 * Parts with no reliable wide-end rule, checked by eye on the parts sheet.
 * true = after the automatic orientation (wide end proximal), flip end-to-end.
 */
export const FLIP: Record<string, boolean> = {
  // belly is the wide end but the measured spread was a near tie; checked by eye: tendon must be distal
  interosseous: true,
};

const MAX_BYTES = 1.9e6;

/**
 * Triangle budget per mesh. Meshes bent along a path every frame (tendons, nerves, arteries) and meshes
 * repeated per finger are kept light so the overlay stays at 60 fps.
 */
function triangleBudget(spec: MeshSpec): number {
  if (spec.tissue === 'tendon') return 3000;
  if (spec.tissue === 'nerve') return 6000;
  if (spec.tissue === 'vessel') return 9000;
  if (['metacarpal', 'phalanx-proximal', 'phalanx-middle', 'phalanx-distal', 'interosseous'].includes(spec.id)) return 6000;
  return 30000;
}

type V3 = [number, number, number];

function positionsOf(doc: Document): Float32Array[] {
  const out: Float32Array[] = [];
  for (const mesh of doc.getRoot().listMeshes())
    for (const prim of mesh.listPrimitives()) {
      const a = prim.getAttribute('POSITION');
      if (a) out.push(a.getArray() as Float32Array);
    }
  return out;
}

function trianglesOf(doc: Document): number {
  let t = 0;
  for (const mesh of doc.getRoot().listMeshes())
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      t += (idx ? idx.getCount() : (prim.getAttribute('POSITION')?.getCount() ?? 0)) / 3;
    }
  return Math.round(t);
}

/** Principal axes (eigenvectors of the covariance, largest first) by power iteration + deflation. */
function principalAxes(arrays: Float32Array[]): { mean: V3; axes: [V3, V3, V3] } {
  let n = 0;
  const mean: V3 = [0, 0, 0];
  for (const a of arrays)
    for (let i = 0; i < a.length; i += 3) {
      mean[0] += a[i];
      mean[1] += a[i + 1];
      mean[2] += a[i + 2];
      n++;
    }
  mean.forEach((_, k) => (mean[k] /= n));
  const C = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const a of arrays)
    for (let i = 0; i < a.length; i += 3) {
      const d = [a[i] - mean[0], a[i + 1] - mean[1], a[i + 2] - mean[2]];
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[r * 3 + c] += d[r] * d[c];
    }
  const mul = (M: number[], v: V3): V3 => [M[0] * v[0] + M[1] * v[1] + M[2] * v[2], M[3] * v[0] + M[4] * v[1] + M[5] * v[2], M[6] * v[0] + M[7] * v[1] + M[8] * v[2]];
  const norm = (v: V3): V3 => {
    const l = Math.hypot(...v) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const eig = (M: number[], seed: V3): { v: V3; l: number } => {
    let v = norm(seed);
    for (let i = 0; i < 200; i++) v = norm(mul(M, v));
    return { v, l: dot(v, mul(M, v)) };
  };
  const e1 = eig(C, [1, 0.3, 0.2]);
  const C2 = C.map((x, i) => x - e1.l * e1.v[Math.floor(i / 3)] * e1.v[i % 3]);
  let e2 = eig(C2, [0.2, 1, 0.3]).v;
  e2 = norm([e2[0] - dot(e2, e1.v) * e1.v[0], e2[1] - dot(e2, e1.v) * e1.v[1], e2[2] - dot(e2, e1.v) * e1.v[2]]);
  const e3: V3 = [e1.v[1] * e2[2] - e1.v[2] * e2[1], e1.v[2] * e2[0] - e1.v[0] * e2[2], e1.v[0] * e2[1] - e1.v[1] * e2[0]];
  return { mean, axes: [e1.v, e2, e3] };
}

/** Column-major 4x4 for gltf-transform from a row-major 3x3 R and translation t: p' = s * R (p - c) + t */
function affine(R: number[], s: number, c: V3, t: V3): number[] {
  const m = (r: number, k: number) => s * R[r * 3 + k];
  const tr = [0, 1, 2].map((r) => t[r] - (m(r, 0) * c[0] + m(r, 1) * c[1] + m(r, 2) * c[2]));
  return [m(0, 0), m(1, 0), m(2, 0), 0, m(0, 1), m(1, 1), m(2, 1), 0, m(0, 2), m(1, 2), m(2, 2), 0, tr[0], tr[1], tr[2], 1];
}

function forEachPrim(doc: Document, fn: (p: Primitive) => void) {
  for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) fn(prim);
}

export interface NormalisedInfo {
  id: string;
  part_id: string;
  /** sideways size relative to length 1: x = second principal axis, z = third */
  width: number;
  depth: number;
  triangles: number;
  bytes: number;
  flipped: boolean;
  /** cross-section spread near y=0 vs y=1 (proximal vs distal), for checking the orientation rule */
  spread: [number, number];
}

export async function normaliseOne(spec: MeshSpec, inFile: string, outFile: string): Promise<NormalisedInfo> {
  const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS);
  await MeshoptSimplifier.ready;
  let targetTris = triangleBudget(spec);
  for (let attempt = 0; attempt < 4; attempt++) {
    const doc = await io.read(inFile);
    // Bake node transforms into the vertices so everything shares one space.
    for (const node of doc.getRoot().listNodes()) if (node.getMesh()) clearNodeTransform(node);
    const tris0 = trianglesOf(doc);
    await doc.transform(dedup(), weld());
    if (tris0 > targetTris) await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio: targetTris / tris0, error: 0.002, lockBorder: false }));

    // 1. Principal axes: long axis -> +Y, second -> +X, third -> +Z.
    const { mean, axes } = principalAxes(positionsOf(doc));
    const [a1, a2, a3] = axes;
    const R = [...a2, ...a1, ...a3]; // rows: x' = a2.p, y' = a1.p, z' = a3.p
    // 2. Extent along the axes.
    const lo: V3 = [Infinity, Infinity, Infinity];
    const hi: V3 = [-Infinity, -Infinity, -Infinity];
    for (const a of positionsOf(doc))
      for (let i = 0; i < a.length; i += 3) {
        const d: V3 = [a[i] - mean[0], a[i + 1] - mean[1], a[i + 2] - mean[2]];
        for (let r = 0; r < 3; r++) {
          const v = R[r * 3] * d[0] + R[r * 3 + 1] * d[1] + R[r * 3 + 2] * d[2];
          lo[r] = Math.min(lo[r], v);
          hi[r] = Math.max(hi[r], v);
        }
      }
    const len = hi[1] - lo[1];
    const s = 1 / len;
    // Centre on the axis (bbox centre sideways), y from lo -> 0.
    const centreRot: V3 = [(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2];
    // c in original space such that R(c - mean) = centreRot  =>  c = mean + R^T centreRot
    const c: V3 = [0, 1, 2].map((k) => mean[k] + R[k] * centreRot[0] + R[3 + k] * centreRot[1] + R[6 + k] * centreRot[2]) as V3;
    forEachPrim(doc, (p) => transformPrimitive(p, affine(R, s, c, [0, 0, 0]) as never));

    // 3. Which end is wider? (mean sideways distance of vertices in the end 15% of each side)
    const spread: [number, number] = [0, 0];
    const cnt = [0, 0];
    for (const a of positionsOf(doc))
      for (let i = 0; i < a.length; i += 3) {
        const r = Math.hypot(a[i], a[i + 2]);
        if (a[i + 1] < 0.15) {
          spread[0] += r;
          cnt[0]++;
        } else if (a[i + 1] > 0.85) {
          spread[1] += r;
          cnt[1]++;
        }
      }
    spread[0] /= cnt[0] || 1;
    spread[1] /= cnt[1] || 1;
    const wideAtTop = spread[1] > spread[0];
    let flip = spec.wideEnd === 'distal' ? !wideAtTop : wideAtTop; // 'manual' starts as wide = proximal
    if (FLIP[spec.id]) flip = !flip;
    if (flip) {
      // Rotate 180 degrees about Z through y = 0.5: (x, y, z) -> (-x, 1 - y, z)
      forEachPrim(doc, (p) => transformPrimitive(p, [-1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 1] as never));
    }

    // 4. Textures smaller, geometry quantised.
    await doc.transform(prune(), textureCompress({ encoder: sharp, targetFormat: 'jpeg', resize: [1024, 1024], quality: 82 }), quantize());
    for (const node of doc.getRoot().listNodes()) node.setName(spec.id);
    const glb = await io.writeBinary(doc);
    if (glb.byteLength > MAX_BYTES && attempt < 3) {
      targetTris = Math.round(targetTris * 0.6);
      continue;
    }
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, glb);
    return {
      id: spec.id,
      part_id: spec.part_id,
      width: (hi[0] - lo[0]) * s,
      depth: (hi[2] - lo[2]) * s,
      triangles: trianglesOf(doc),
      bytes: glb.byteLength,
      flipped: flip,
      spread: [Math.round(spread[0] * 1000) / 1000, Math.round(spread[1] * 1000) / 1000],
    };
  }
  throw new Error(`could not get ${spec.id} under ${MAX_BYTES} bytes`);
}

async function main() {
  const args = process.argv.slice(2);
  const val = (f: string) => {
    const i = args.indexOf(f);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const inDir = path.resolve(val('--in') ?? '.cache-live/arm-hand/raw');
  const outDir = path.resolve(val('--out') ?? 'public/cache/arm-hand');
  const tag = val('--tag') ?? '';
  const flagVals = new Set(['--in', '--out', '--tag'].map(val).filter(Boolean) as string[]);
  const ids = args.filter((a) => !a.startsWith('--') && !flagVals.has(a));
  const specs = ids.length ? SPECS.filter((s) => ids.includes(s.id)) : SPECS;
  const infoFile = path.join(outDir, 'meshes.json');
  const info: Record<string, NormalisedInfo> = fs.existsSync(infoFile) ? JSON.parse(fs.readFileSync(infoFile, 'utf8')) : {};
  for (const spec of specs) {
    const inFile = path.join(inDir, `${spec.id}${tag}.glb`);
    if (!fs.existsSync(inFile)) {
      console.log(`[norm] skip ${spec.id}${tag}: no raw mesh yet`);
      continue;
    }
    const outFile = path.join(outDir, `${spec.id}${tag}.glb`);
    const r = await normaliseOne(spec, inFile, outFile);
    info[spec.id + tag] = r;
    console.log(
      `[norm] ${(spec.id + tag).padEnd(22)} ${(r.bytes / 1e6).toFixed(2)} MB  ${String(r.triangles).padStart(6)} tris  w ${r.width.toFixed(2)} d ${r.depth.toFixed(2)}  spread P/D ${r.spread.join('/')}${r.flipped ? '  (flipped)' : ''}`,
    );
  }
  fs.writeFileSync(infoFile, JSON.stringify(info, null, 2) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
