/**
 * Fit the raw fal internal meshes into their real place inside the iPhone 17 Pro (same frame as build-exterior.ts:
 * mm, +x = phone's right edge facing the screen, +y = top, +z = front; then scaled so the phone is 1.0 tall).
 *
 *   npx tsx scripts/iphone/fit.ts [ids...]   .cache-live/iphone/raw/<id>.glb -> public/cache/meshes/iphone-17-pro/<id>.glb
 *
 * Each mesh: principal axes -> (long axis, second, thinnest), simplified to < 1 MB, then stretched to its slot's box
 * (long axis along the slot's long side, thinnest axis = phone depth) and centred on the slot.
 */
import fs from 'node:fs';
import path from 'node:path';
import { NodeIO, type Primitive } from '@gltf-transform/core';
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions';
import { clearNodeTransform, dequantize, quantize, transformPrimitive } from '@gltf-transform/functions';
import { normaliseOne } from '../arm/normalise';

const S = 1 / 150;
type Slot = { c: [number, number, number]; s: [number, number, number]; long: 'x' | 'y'; flipFace?: boolean; flipEnds?: boolean };
/** Positions inside the 17 Pro (mm): centre and size along x, y, z. */
export const SLOTS: Record<string, Slot> = {
  'face-id': { c: [0, 66.5, 1.6], s: [22, 6, 2.4], long: 'x' },
  'logic-board': { c: [-14.5, 52, -0.3], s: [33, 27, 1.6], long: 'x' }, // beside the cameras, under the other half of the plateau
  'vapour-chamber': { c: [0, 22, 2.4], s: [58, 62, 0.5], long: 'y' },
  battery: { c: [0, -20, -0.7], s: [60, 75, 3.9], long: 'y' },
  'taptic-engine': { c: [-17, -62.5, -0.6], s: [27, 8.5, 3.4], long: 'x' },
  'usb-c': { c: [0, -70.5, 0.2], s: [12, 5, 3.2], long: 'x' },
  speaker: { c: [19, -64, -0.6], s: [18, 9, 3.4], long: 'x' },
};

const RAW = path.resolve('.cache-live/iphone/raw');
const NORM = path.resolve('.cache-live/iphone/norm');
const OUT = path.resolve('public/cache/meshes/iphone-17-pro');

function forEachPrim(doc: import('@gltf-transform/core').Document, fn: (p: Primitive) => void) {
  for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) fn(p);
}

async function fit(id: string) {
  const slot = SLOTS[id];
  fs.mkdirSync(NORM, { recursive: true });
  // 1. principal axes: long -> +Y (0..1), second -> X, thinnest -> Z
  await normaliseOne({ id, part_id: id, tissue: 'bone', what: id, looks: '', wideEnd: 'manual' } as never, path.join(RAW, `${id}.glb`), path.join(NORM, `${id}.glb`));
  const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS);
  const doc = await io.read(path.join(NORM, `${id}.glb`));
  // the normalised file is quantized: its scale/offset live on the node. Bake them back into the vertices first.
  await doc.transform(dequantize());
  for (const n of doc.getRoot().listNodes()) if (n.getMesh()) clearNodeTransform(n);
  // 1b. square it up: rotate about Z (the thin axis) to the angle with the smallest in-plane bounding box, so a
  //     flex cable sticking out doesn't leave a rectangular part tilted
  {
    const pts: number[] = [];
    forEachPrim(doc, (p) => {
      const a = p.getAttribute('POSITION')!;
      const v = [0, 0, 0];
      const step = Math.max(1, Math.floor(a.getCount() / 4000));
      for (let i = 0; i < a.getCount(); i += step) {
        a.getElement(i, v);
        pts.push(v[0], v[1]);
      }
    });
    let best = 0, bestArea = Infinity;
    for (let deg = -45; deg <= 45; deg += 0.5) {
      const r = (deg * Math.PI) / 180, c = Math.cos(r), sn = Math.sin(r);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let i = 0; i < pts.length; i += 2) {
        const x = c * pts[i] - sn * pts[i + 1], y = sn * pts[i] + c * pts[i + 1];
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      const area = (x1 - x0) * (y1 - y0);
      if (area < bestArea) { bestArea = area; best = r; }
    }
    const c = Math.cos(best), sn = Math.sin(best);
    forEachPrim(doc, (p) => transformPrimitive(p, [c, sn, 0, 0, -sn, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as never));
  }
  // 2. extents of the normalised mesh
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  forEachPrim(doc, (p) => {
    const a = p.getAttribute('POSITION')!;
    const v = [0, 0, 0];
    for (let i = 0; i < a.getCount(); i++) {
      a.getElement(i, v);
      for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[k]); hi[k] = Math.max(hi[k], v[k]); }
    }
  });
  const ext = [0, 1, 2].map((k) => Math.max(1e-6, hi[k] - lo[k]));
  const mid = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2);
  // 3. map normalised axes to the slot: Y (long) -> slot long axis, X (second) -> the other in-plane axis, Z -> depth
  const [sx, sy, sz] = slot.s.map((v) => v * S);
  const fz = slot.flipFace ? -1 : 1;
  const fe = slot.flipEnds ? -1 : 1;
  // column-major 4x4: columns are where the normalised x, y, z axes go
  let colX: number[], colY: number[];
  if (slot.long === 'x') {
    colY = [(fe * sx) / ext[1], 0, 0];
    colX = [0, sy / ext[0], 0];
  } else {
    colY = [0, (fe * sy) / ext[1], 0];
    colX = [sx / ext[0], 0, 0];
  }
  const colZ = [0, 0, (fz * sz) / ext[2]];
  // translation: move the normalised centre to the slot centre
  const c = slot.c.map((v) => v * S);
  const t = [0, 1, 2].map((r) => c[r] - (colX[r] * mid[0] + colY[r] * mid[1] + colZ[r] * mid[2]));
  const M = [...colX, 0, ...colY, 0, ...colZ, 0, ...t, 1];
  forEachPrim(doc, (p) => transformPrimitive(p, M as never));
  for (const n of doc.getRoot().listNodes()) n.setName(id).setExtras({ object_id: 'iphone-17-pro', part_id: id, mesh_source: 'fal' });
  await doc.transform(quantize());
  fs.mkdirSync(OUT, { recursive: true });
  const glb = await io.writeBinary(doc);
  fs.writeFileSync(path.join(OUT, `${id}.glb`), glb);
  console.log(`[fit] ${id.padEnd(15)} ${(glb.byteLength / 1e6).toFixed(2)} MB`);
}

const ids = process.argv.slice(2);
for (const id of ids.length ? ids : Object.keys(SLOTS)) await fit(id);
