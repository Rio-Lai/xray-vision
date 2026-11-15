/**
 * iPhone 17 Pro (Cosmic Orange) exterior parts, built from Apple's published dimensions so the design is right
 * (fal's image models draw older iPhones). Internal parts come from fal (scripts/iphone/generate.ts).
 *
 *   npx tsx scripts/iphone/build-exterior.ts  ->  public/cache/meshes/iphone-17-pro/{frame,back,display,cameras}.glb
 *
 * Units: millimetres, then scaled so the phone is 1.0 tall. Frame: +x = the phone's right edge when you face the
 * screen (side button, Camera Control), +y = top, +z = front (display); the back faces -z. Seen from the back,
 * +x is on your left, so the cameras sit at +x (top-left of the back). Origin = centre of the phone.
 * Every part keeps this shared frame, so the parts line up when assembled.
 *
 * Reference: iPhone 17 Pro, 150.0 x 71.9 x 8.75 mm, aluminium unibody, full-width camera plateau, Ceramic Shield
 * back window, triple 48 MP Fusion cameras (triangle), flash + LiDAR on the right of the plateau, Camera Control.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { Document, NodeIO, type Material } from '@gltf-transform/core';
import { KHRONOS_EXTENSIONS, KHRMaterialsClearcoat, KHRMaterialsIOR, KHRMaterialsTransmission } from '@gltf-transform/extensions';
import { dedup, quantize } from '@gltf-transform/functions';

const W = 71.9, H = 150.0, D = 8.75;
const R = 10.6; // corner radius of the body
const S = 1 / H;
const OUT = path.resolve('public/cache/meshes/iphone-17-pro');
const BACK_Z = -D / 2; // back surface
const PLATEAU_BOTTOM = H / 2 - 39; // plateau covers the top 39 mm
const PLATEAU_RISE = 1.9;

/** Rounded rectangle with per-corner radii [tl, tr, br, bl], centred at (cx, cy). */
function roundedRect(w: number, h: number, r: number | [number, number, number, number], cx = 0, cy = 0): THREE.Shape {
  const [tl, tr, br, bl] = typeof r === 'number' ? [r, r, r, r] : r;
  const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2;
  const s = new THREE.Shape();
  s.moveTo(x0 + bl, y0);
  s.lineTo(x1 - br, y0);
  s.quadraticCurveTo(x1, y0, x1, y0 + br);
  s.lineTo(x1, y1 - tr);
  s.quadraticCurveTo(x1, y1, x1 - tr, y1);
  s.lineTo(x0 + tl, y1);
  s.quadraticCurveTo(x0, y1, x0, y1 - tl);
  s.lineTo(x0, y0 + bl);
  s.quadraticCurveTo(x0, y0, x0 + bl, y0);
  return s;
}

/** Extrude a shape along z from z0 to z1 with a small bevel. */
function slab(shape: THREE.Shape, z0: number, z1: number, bevel = 0.35, curveSegments = 24): THREE.BufferGeometry {
  const depth = Math.max(0.01, z1 - z0 - 2 * bevel);
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments });
  g.translate(0, 0, z0 + bevel);
  return g;
}

function cylinder(r: number, x: number, y: number, z0: number, z1: number, seg = 48): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, z1 - z0, seg, 1);
  g.rotateX(Math.PI / 2);
  g.translate(x, y, (z0 + z1) / 2);
  return g;
}

/** Side button: a capsule on the left (-x) or right (+x) edge, y from yTop down to yBot. */
function sideButton(side: -1 | 1, yTop: number, yBot: number, depth = 0.6, thick = 3.2): THREE.BufferGeometry {
  const len = yTop - yBot;
  const g = new THREE.CapsuleGeometry(thick / 2, Math.max(0.1, len - thick), 6, 16);
  g.scale(depth / thick, 1, 1);
  g.translate(side * (W / 2 + depth * 0.35), (yTop + yBot) / 2, 0.2);
  return g;
}

interface Prim {
  geo: THREE.BufferGeometry;
  mat: (d: Document) => Material;
}

const lin = (hex: string): [number, number, number, number] => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b, 1];
};
const pbr = (d: Document, name: string, hex: string, rough: number, metal: number, clearcoat = 0) => {
  const m = d.createMaterial(name).setBaseColorFactor(lin(hex)).setRoughnessFactor(rough).setMetallicFactor(metal);
  if (clearcoat) m.setExtension('KHR_materials_clearcoat', d.createExtension(KHRMaterialsClearcoat).createClearcoat().setClearcoatFactor(clearcoat).setClearcoatRoughnessFactor(0.05));
  return m;
};
const glass = (d: Document, name: string, hex: string, rough: number) =>
  pbr(d, name, hex, rough, 0)
    .setExtension('KHR_materials_transmission', d.createExtension(KHRMaterialsTransmission).createTransmission().setTransmissionFactor(0.6))
    .setExtension('KHR_materials_ior', d.createExtension(KHRMaterialsIOR).createIOR().setIOR(1.77));

// Cosmic Orange anodised aluminium (satin), a slightly lighter frosted glass window, dark sapphire lenses.
const ORANGE = '#e8611f';
const ORANGE_GLASS = '#e46a2c';
const aluminium = (d: Document) => pbr(d, 'Cosmic Orange aluminium', ORANGE, 0.42, 0.85, 0.15);
const darkAlu = (d: Document) => pbr(d, 'anodised dark ring', '#b8461a', 0.35, 0.9);
const black = (d: Document) => pbr(d, 'black', '#0b0b0d', 0.4, 0.1);

async function write(id: string, prims: Prim[]) {
  const doc = new Document();
  const buf = doc.createBuffer();
  const mesh = doc.createMesh(id);
  for (const p of prims) {
    let g = p.geo.index ? p.geo.toNonIndexed() : p.geo;
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    g = g.clone();
    g.scale(S, S, S);
    const pos = g.getAttribute('position').array as Float32Array;
    const nor = g.getAttribute('normal').array as Float32Array;
    const uvA = g.getAttribute('uv');
    const prim = doc
      .createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(pos)).setBuffer(buf))
      .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(nor)).setBuffer(buf))
      .setMaterial(p.mat(doc));
    if (uvA) prim.setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(uvA.array as Float32Array)).setBuffer(buf));
    mesh.addPrimitive(prim);
  }
  doc.createScene().addChild(doc.createNode(id).setMesh(mesh).setExtras({ object_id: 'iphone-17-pro', part_id: id, units: 'phone height = 1', mesh_source: 'procedural' }));
  await doc.transform(dedup(), quantize());
  const glb = await new NodeIO().registerExtensions(KHRONOS_EXTENSIONS).writeBinary(doc);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${id}.glb`), glb);
  console.log(`[iphone] ${id.padEnd(9)} ${(glb.byteLength / 1024).toFixed(0)} KB`);
}

/* ------------------------------ parts ------------------------------ */

// 1. Aluminium unibody: side walls + back plate (with the window cut out) + the full-width camera plateau.
function frame(): Prim[] {
  const wall = 1.1;
  const ring = roundedRect(W, H, R);
  ring.holes.push(roundedRect(W - 2 * wall, H - 2 * wall, R - wall));
  const walls = slab(ring, BACK_Z, D / 2 - 0.9, 0.45);
  // back plate: everything except the glass window (window = below the plateau, inset 4.5 mm from the edges)
  const plate = roundedRect(W - 0.6, H - 0.6, R - 0.3);
  plate.holes.push(windowShape());
  const back = slab(plate, BACK_Z, BACK_Z + 0.9, 0.2);
  // plateau: full width across the top, rounded at the phone's top corners, softly rounded lower corners
  const plat = roundedRect(W - 0.2, H / 2 - PLATEAU_BOTTOM, [R - 0.1, R - 0.1, 5.5, 5.5], 0, (H / 2 + PLATEAU_BOTTOM) / 2);
  const plateau = slab(plat, BACK_Z - PLATEAU_RISE, BACK_Z + 0.2, 0.7);
  // buttons: Action + volume on the phone's left edge (-x); side button + Camera Control on the right edge (+x)
  const buttons = [
    sideButton(-1, 49, 41), // Action button
    sideButton(-1, 34, 24), // volume up
    sideButton(-1, 20, 10), // volume down
    sideButton(1, 38, 22), // side button
  ];
  // Camera Control: flush sapphire button, lower on the phone's right edge
  const camCtl = new THREE.CapsuleGeometry(1.5, 15, 6, 16);
  camCtl.scale(0.35, 1, 1);
  camCtl.translate(W / 2 + 0.15, -24, 0.2);
  // USB-C port and speaker / mic holes on the bottom edge
  const usb = new THREE.CapsuleGeometry(1.35, 6.2, 6, 16);
  usb.rotateZ(Math.PI / 2);
  usb.scale(1, 1, 1);
  usb.rotateX(Math.PI / 2);
  usb.translate(0, -H / 2 - 0.05, 0.2);
  const holes: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 6; i++) {
    for (const side of [-1, 1]) {
      const h = new THREE.CylinderGeometry(0.55, 0.55, 0.5, 12);
      h.translate(side * (9.5 + i * 2.2), -H / 2 - 0.05, 0.2);
      holes.push(h);
    }
  }
  return [
    { geo: walls, mat: aluminium },
    { geo: back, mat: aluminium },
    { geo: plateau, mat: aluminium },
    ...buttons.map((g) => ({ geo: g, mat: aluminium })),
    { geo: camCtl, mat: (d: Document) => pbr(d, 'Camera Control sapphire', '#c9522a', 0.15, 0.4, 0.8) },
    { geo: usb, mat: black },
    ...holes.map((g) => ({ geo: g, mat: black })),
  ];
}

function windowShape(): THREE.Shape {
  const top = PLATEAU_BOTTOM - 3.0;
  const bottom = -H / 2 + 4.5;
  const w = W - 9;
  return roundedRect(w, top - bottom, [3.5, 3.5, R - 4.2, R - 4.2], 0, (top + bottom) / 2);
}

/**
 * Apple logo outline, ~1.25 units tall (body + leaf), built from curves. Drawn as seen from the BACK of the phone
 * (bite on the viewer's right), and from the back the viewer's right is -x in this frame, so x is mirrored.
 */
function appleLogo(heightMm: number, cx: number, cy: number): THREE.Shape[] {
  const k = heightMm / 1.28;
  const P = (x: number, y: number): [number, number] => [cx - x * k, cy + (y - 0.05) * k];
  const body = new THREE.Shape();
  body.moveTo(...P(0, 0.28));
  body.bezierCurveTo(...P(0.1, 0.37), ...P(0.31, 0.4), ...P(0.405, 0.18));
  // the bite: a concave arc (centre (0.55, 0.03), radius 0.21), sampled so it can be mirrored
  for (let a = 2.35; a <= 3.93 + 1e-6; a += 0.0395) body.lineTo(...P(0.55 + 0.21 * Math.cos(a), 0.03 + 0.21 * Math.sin(a)));
  body.bezierCurveTo(...P(0.41, -0.36), ...P(0.29, -0.56), ...P(0.16, -0.59));
  body.bezierCurveTo(...P(0.08, -0.61), ...P(0.05, -0.54), ...P(0, -0.54));
  body.bezierCurveTo(...P(-0.05, -0.54), ...P(-0.09, -0.61), ...P(-0.17, -0.6));
  body.bezierCurveTo(...P(-0.33, -0.56), ...P(-0.47, -0.27), ...P(-0.46, -0.02));
  body.bezierCurveTo(...P(-0.45, 0.25), ...P(-0.31, 0.38), ...P(-0.18, 0.37));
  body.bezierCurveTo(...P(-0.08, 0.36), ...P(-0.04, 0.31), ...P(0, 0.28));
  const leaf = new THREE.Shape();
  leaf.moveTo(...P(0.02, 0.41));
  leaf.quadraticCurveTo(...P(-0.01, 0.63), ...P(0.23, 0.69));
  leaf.quadraticCurveTo(...P(0.25, 0.47), ...P(0.02, 0.41));
  // mirroring reverses the winding; ExtrudeGeometry needs consistent winding, so reverse back
  return [body, leaf].map((sh) => {
    const pts = sh.getPoints(24).reverse();
    return new THREE.Shape(pts);
  });
}

// 2. Ceramic Shield back window (frosted, colour-matched, wireless charging passes through it)
function back(): Prim[] {
  const win = slab(windowShape(), BACK_Z - 0.05, BACK_Z + 0.85, 0.25);
  // faint MagSafe ring etched into the glass
  const ring = new THREE.Shape();
  ring.absarc(0, -13, 23, 0, Math.PI * 2, false);
  const hole = new THREE.Path();
  hole.absarc(0, -13, 22.4, 0, Math.PI * 2, true);
  ring.holes.push(hole);
  const magsafe = slab(ring, BACK_Z - 0.09, BACK_Z - 0.04, 0, 64);
  // polished Apple logo, centred in the MagSafe ring, a hair proud of the frosted glass
  const logo = appleLogo(13, 0, -13).map((sh) => slab(sh, BACK_Z - 0.16, BACK_Z - 0.04, 0.02, 12));
  return [
    { geo: win, mat: (d) => pbr(d, 'Ceramic Shield back (frosted orange)', ORANGE_GLASS, 0.6, 0.15, 0.35) },
    ...logo.map((g) => ({ geo: g, mat: (d: Document) => pbr(d, 'Apple logo (polished)', '#f08a4b', 0.12, 0.55, 1) })),
    { geo: magsafe, mat: (d) => pbr(d, 'MagSafe ring', '#d7672f', 0.35, 0.2) },
  ];
}

// 3. Front: Ceramic Shield 2 glass over the 6.3" OLED, with the Dynamic Island
function display(): Prim[] {
  const glassTop = slab(roundedRect(W - 1.4, H - 1.4, R - 0.7), D / 2 - 1.3, D / 2, 0.45);
  const screen = slab(roundedRect(W - 4.6, H - 4.6, R - 2.4), D / 2 - 1.36, D / 2 - 1.3, 0);
  const island = new THREE.CapsuleGeometry(3.3, 13.5, 8, 24);
  island.rotateZ(Math.PI / 2);
  island.scale(1, 1, 0.08);
  island.translate(0, H / 2 - 11.5, D / 2 + 0.02);
  return [
    { geo: screen, mat: (d) => pbr(d, 'OLED panel', '#06070a', 0.25, 0.2) },
    { geo: glassTop, mat: (d) => pbr(d, 'Ceramic Shield 2 front glass', '#08090c', 0.06, 0.0, 1) },
    { geo: island, mat: black },
  ];
}

// 4. Triple camera module on the plateau + flash, LiDAR, mic (seen from the back: lenses top-left in a triangle)
function cameras(): Prim[] {
  const z0 = BACK_Z - PLATEAU_RISE; // plateau surface
  const cy = (H / 2 + PLATEAU_BOTTOM) / 2;
  const lenses: [number, number][] = [
    [22.5, cy + 7.6], // main (48 MP Fusion), outer column
    [22.5, cy - 7.6], // ultra wide
    [9.3, cy], // telephoto (tetraprism), towards the middle
  ];
  const prims: Prim[] = [];
  for (const [x, y] of lenses) {
    prims.push({ geo: cylinder(7.3, x, y, z0 - 1.6, z0 + 0.1), mat: darkAlu }); // anodised ring
    prims.push({ geo: cylinder(6.1, x, y, z0 - 1.75, z0 - 1.5), mat: (d) => pbr(d, 'sapphire lens cover', '#0d1220', 0.05, 0.3, 1) });
    prims.push({ geo: cylinder(3.2, x, y, z0 - 1.8, z0 - 1.74), mat: (d) => pbr(d, 'lens element', '#14203f', 0.05, 0.5, 1) });
  }
  prims.push({ geo: cylinder(3.0, -23.5, cy + 7.5, z0 - 0.4, z0 + 0.1), mat: (d) => pbr(d, 'True Tone flash', '#f3e6c8', 0.2, 0.1, 0.6) });
  prims.push({ geo: cylinder(3.0, -23.5, cy - 7.5, z0 - 0.4, z0 + 0.1), mat: (d) => pbr(d, 'LiDAR scanner', '#121214', 0.15, 0.2, 0.8) });
  prims.push({ geo: cylinder(0.6, -14.5, cy, z0 - 0.05, z0 + 0.1), mat: black }); // microphone
  return prims;
}

await write('frame', frame());
await write('back', back());
await write('display', display());
await write('cameras', cameras());
