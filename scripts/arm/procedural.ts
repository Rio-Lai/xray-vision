/**
 * Procedural fallback meshes, ONLY for parts fal failed to draw correctly twice (plan rule).
 * Same convention as the normalised fal meshes: y = 0 proximal .. 1 distal, centred on the axis.
 *   npx tsx scripts/arm/procedural.ts   ->  public/cache/arm-hand/phalanx-distal.glb
 */
import fs from 'node:fs';
import { Document, NodeIO } from '@gltf-transform/core';
import { lathe, type Profile } from '../eye/geometry';

/** Distal phalanx: concave wider base, slim waist, flared ungual tuft at the tip, flattened front-to-back. */
function distalPhalanx() {
  const stops: [number, number][] = [
    [0.0, 0.0], [0.0, 0.2], [0.04, 0.23], [0.12, 0.21], [0.3, 0.15], [0.48, 0.12], [0.66, 0.13], [0.8, 0.17], [0.9, 0.18], [0.97, 0.12], [1.0, 0.0],
  ];
  // lathe() revolves [r, z] about z; we want the long axis on y, so build with z = y and swap below
  const prof: Profile = stops.map(([y, r]) => [r, 1 - y]);
  const m = lathe([{ pts: prof }], 40);
  // z (lathe axis) -> y; flatten the bone front-to-back (z) to 70 %
  for (let i = 0; i < m.pos.length; i += 3) {
    const [x, y, z] = [m.pos[i], m.pos[i + 1], m.pos[i + 2]];
    m.pos[i] = x;
    m.pos[i + 1] = 1 - z;
    m.pos[i + 2] = y * 0.7;
    const [nx, ny, nz] = [m.nrm[i], m.nrm[i + 1], m.nrm[i + 2]];
    m.nrm[i] = nx;
    m.nrm[i + 1] = -nz;
    m.nrm[i + 2] = ny;
  }
  return m;
}

const doc = new Document();
const buf = doc.createBuffer();
const m = distalPhalanx();
const prim = doc
  .createPrimitive()
  .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(m.pos)).setBuffer(buf))
  .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(m.nrm)).setBuffer(buf))
  .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint16Array(m.idx)).setBuffer(buf))
  .setMaterial(doc.createMaterial('bone').setBaseColorFactor([0.86, 0.8, 0.67, 1]).setRoughnessFactor(0.55).setMetallicFactor(0));
doc.createScene().addChild(doc.createNode('phalanx-distal').setMesh(doc.createMesh('phalanx-distal').addPrimitive(prim)).setExtras({ mesh_source: 'procedural-fallback' }));
const out = 'public/cache/arm-hand/phalanx-distal.glb';
fs.renameSync(out, '.cache-live/arm-hand/rejected-raw/phalanx-distal.fal-normalised.glb');
fs.writeFileSync(out, await new NodeIO().writeBinary(doc));
const info = JSON.parse(fs.readFileSync('public/cache/arm-hand/meshes.json', 'utf8'));
info['phalanx-distal'] = { ...info['phalanx-distal'], width: 0.46, depth: 0.32, triangles: m.idx.length / 3, bytes: fs.statSync(out).size, flipped: false, mesh_source: 'procedural-fallback' };
fs.writeFileSync('public/cache/arm-hand/meshes.json', JSON.stringify(info, null, 2) + '\n');
console.log(`${out}: ${(fs.statSync(out).size / 1e3).toFixed(0)} KB, ${m.idx.length / 3} triangles (procedural fallback)`);
