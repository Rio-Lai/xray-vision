/**
 * iPhone 17 Pro camera INTERNALS, built in code: the parts under the three lenses on the camera plateau.
 *
 *   npx tsx scripts/iphone/camera-internals.ts
 *   -> public/cache/meshes/iphone-17-pro/{main-camera-lens,main-camera-sensor,ultra-wide-camera,telephoto-camera}.glb
 *
 * Same frame as build-exterior.ts (mm; +x = phone's right edge facing the screen, +y = top, +z = front; the back faces
 * -z; scaled so the phone is 1.0 tall). Lens axes come out of the back (-z). Barrels are cut open (the half facing
 * +x is removed) so the glass inside is visible in the exploded view and the video.
 *
 * Real layout: 48 MP Fusion main camera with sensor-shift OIS (large ~1/1.28" sensor), 48 MP ultra wide, 48 MP 4x
 * telephoto that folds light with a tetraprism so a long focal length fits in a thin phone.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { Document, NodeIO, type Material } from '@gltf-transform/core';
import { KHRONOS_EXTENSIONS, KHRMaterialsClearcoat, KHRMaterialsIOR, KHRMaterialsIridescence, KHRMaterialsTransmission } from '@gltf-transform/extensions';
import { dedup, quantize } from '@gltf-transform/functions';

const H = 150.0, D = 8.75;
const S = 1 / H;
const OUT = path.resolve('public/cache/meshes/iphone-17-pro');
const BACK_Z = -D / 2;
const PLATEAU_BOTTOM = H / 2 - 39;
const Z0 = BACK_Z - 1.9; // plateau outer surface: lenses start here and go inwards (+z)
const CY = (H / 2 + PLATEAU_BOTTOM) / 2;
const MAIN: [number, number] = [22.5, CY + 7.6];
const UW: [number, number] = [22.5, CY - 7.6];
const TELE: [number, number] = [9.3, CY];

/* ------------------------------ materials ------------------------------ */
const lin = (hex: string): [number, number, number, number] => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b, 1];
};
type Mat = (d: Document) => Material;
const pbr = (name: string, hex: string, rough: number, metal: number, clearcoat = 0): Mat => (d) => {
  const m = d.createMaterial(name).setBaseColorFactor(lin(hex)).setRoughnessFactor(rough).setMetallicFactor(metal).setDoubleSided(true);
  if (clearcoat) m.setExtension('KHR_materials_clearcoat', d.createExtension(KHRMaterialsClearcoat).createClearcoat().setClearcoatFactor(clearcoat).setClearcoatRoughnessFactor(0.04));
  return m;
};
const iri = (m: Material, d: Document, f: number, lo = 250, hi = 480) =>
  m.setExtension('KHR_materials_iridescence', d.createExtension(KHRMaterialsIridescence).createIridescence().setIridescenceFactor(f).setIridescenceIOR(1.6).setIridescenceThicknessMinimum(lo).setIridescenceThicknessMaximum(hi));
const lensGlass: Mat = (d) =>
  iri(
    pbr('optical glass element', '#eaf4ff', 0.02, 0)(d)
      .setExtension('KHR_materials_transmission', d.createExtension(KHRMaterialsTransmission).createTransmission().setTransmissionFactor(0.95))
      .setExtension('KHR_materials_ior', d.createExtension(KHRMaterialsIOR).createIOR().setIOR(1.6)),
    d,
    0.45,
  );
const prismGlass: Mat = (d) =>
  iri(
    pbr('tetraprism glass', '#dff2ff', 0.02, 0)(d)
      .setExtension('KHR_materials_transmission', d.createExtension(KHRMaterialsTransmission).createTransmission().setTransmissionFactor(0.92))
      .setExtension('KHR_materials_ior', d.createExtension(KHRMaterialsIOR).createIOR().setIOR(1.75)),
    d,
    0.3,
  );
const irFilter: Mat = (d) =>
  iri(
    pbr('IR-cut filter', '#bfe8ff', 0.02, 0)(d).setExtension('KHR_materials_transmission', d.createExtension(KHRMaterialsTransmission).createTransmission().setTransmissionFactor(0.8)),
    d,
    1.0,
    380,
    700,
  );
const sensorDie: Mat = (d) => iri(pbr('48 MP image sensor (active area)', '#1b1230', 0.12, 0.6, 1)(d), d, 1.0, 300, 650);
const barrel = pbr('lens barrel (black)', '#0c0c0e', 0.55, 0.2);
const barrelInside = pbr('barrel inside (matte black)', '#040405', 0.9, 0);
const copper = pbr('voice-coil copper winding', '#c56a33', 0.32, 1);
const magnet = pbr('neodymium magnet', '#5c5f66', 0.35, 0.9);
const can = pbr('module housing (steel)', '#8b9097', 0.38, 0.95);
const ceramic = pbr('ceramic sensor package', '#3a3b40', 0.55, 0.1);
const gold = pbr('gold wire-bond frame', '#e0b24f', 0.25, 1);
const pcb = pbr('camera PCB', '#0f2a20', 0.5, 0.1);
const flex = pbr('flex cable (polyimide)', '#c8762a', 0.45, 0.2);

/* ------------------------------ geometry helpers ------------------------------ */
interface Prim {
  geo: THREE.BufferGeometry;
  mat: Mat;
}
/** Surface of revolution about the lens axis at (x, y). pts = [radius, depth] with depth measured inwards (+z) from Z0.
 *  cut = remove the half facing +x (so the inside shows). */
function lathe(pts: [number, number][], x: number, y: number, cut = false, seg = 72): THREE.BufferGeometry {
  // LatheGeometry revolves about +y: vertex = (r sin phi, h, r cos phi). Map h -> +z (inwards), keep the -x half when cut.
  const g = new THREE.LatheGeometry(pts.map(([r, h]) => new THREE.Vector2(Math.max(0.001, r), h)), seg, cut ? Math.PI : 0, cut ? Math.PI : Math.PI * 2);
  g.rotateX(Math.PI / 2); // y -> z
  g.translate(x, y, Z0);
  return g;
}
/** lens element: front surface radius-of-curvature rf, back rb (+ = convex outward), centre thickness t, at depth z */
function element(r: number, z: number, t: number, sagF: number, sagB: number, x: number, y: number): THREE.BufferGeometry {
  const n = 16;
  const pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n; // 0 = axis -> 1 = edge, front face (towards the outside, smaller depth)
    pts.push([u * r, z - sagF * (1 - u * u)]);
  }
  for (let i = n; i >= 0; i--) {
    const u = i / n;
    pts.push([u * r, z + t + sagB * (1 - u * u)]);
  }
  return lathe(pts, x, y, false, 64);
}
function box(w: number, h: number, d: number, cx: number, cy: number, cz: number, r = 0.4): THREE.BufferGeometry {
  const s = new THREE.Shape();
  const x0 = -w / 2, y0 = -h / 2;
  s.moveTo(x0 + r, y0);
  s.lineTo(x0 + w - r, y0); s.quadraticCurveTo(x0 + w, y0, x0 + w, y0 + r);
  s.lineTo(x0 + w, y0 + h - r); s.quadraticCurveTo(x0 + w, y0 + h, x0 + w - r, y0 + h);
  s.lineTo(x0 + r, y0 + h); s.quadraticCurveTo(x0, y0 + h, x0, y0 + h - r);
  s.lineTo(x0, y0 + r); s.quadraticCurveTo(x0, y0, x0 + r, y0);
  const g = new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: false, curveSegments: 6 });
  g.translate(cx, cy, cz - d / 2);
  return g;
}
function torus(R: number, tube: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const g = new THREE.TorusGeometry(R, tube, 16, 72);
  g.translate(x, y, z);
  return g;
}

/* ------------------------------ parts ------------------------------ */

/** 48 MP Fusion main camera: the lens. Cut-open barrel, 7 aspheric elements, VCM autofocus coil + magnets. */
function mainLens(): Prim[] {
  const [x, y] = MAIN;
  const p: Prim[] = [];
  p.push({ geo: lathe([[5.3, 0.3], [5.3, 6.4]], x, y, true), mat: barrel });
  p.push({ geo: lathe([[4.75, 6.4], [4.75, 0.3]], x, y, true), mat: barrelInside });
  p.push({ geo: lathe([[4.75, 0.3], [5.3, 0.3]], x, y, true), mat: barrel });
  p.push({ geo: lathe([[4.75, 6.4], [5.3, 6.4]], x, y, true), mat: barrel });
  // 7 elements: big front group, a thin negative element, then the strongly aspheric rear elements
  const els: [number, number, number, number, number][] = [
    [4.5, 0.7, 0.75, 0.55, 0.05],
    [4.3, 1.75, 0.45, -0.15, 0.25],
    [3.9, 2.55, 0.6, 0.35, 0.1],
    [3.6, 3.4, 0.4, -0.1, 0.3],
    [3.9, 4.15, 0.55, 0.25, -0.2],
    [4.3, 4.95, 0.45, -0.25, 0.35],
    [4.6, 5.75, 0.35, 0.3, -0.3],
  ];
  for (const [r, z, t, f, b] of els) p.push({ geo: element(r, z, t, f, b, x, y), mat: lensGlass });
  // voice-coil motor: copper winding round the barrel, four magnets at the corners of a square frame
  p.push({ geo: torus(5.75, 0.42, x, y, Z0 + 3.0), mat: copper });
  p.push({ geo: torus(5.75, 0.42, x, y, Z0 + 3.9), mat: copper });
  for (const [mx, my] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) p.push({ geo: box(2.0, 2.0, 3.2, x + mx * 5.6, y + my * 5.6, Z0 + 3.4, 0.3), mat: magnet });
  return p;
}

/** 48 MP Fusion main camera: the sensor on its sensor-shift OIS stage, IR filter, PCB and flex to the logic board. */
function mainSensor(): Prim[] {
  const [x, y] = MAIN;
  const p: Prim[] = [];
  const zf = Z0 + 6.9; // focal plane
  p.push({ geo: box(10.8, 8.6, 0.3, x, y, zf - 0.55, 0.3), mat: irFilter });
  p.push({ geo: box(9.8, 7.4, 0.12, x, y, zf, 0.1), mat: sensorDie });
  p.push({ geo: box(11.2, 8.8, 0.08, x, y, zf + 0.08, 0.2), mat: gold });
  p.push({ geo: box(12.2, 10.0, 0.6, x, y, zf + 0.4, 0.4), mat: ceramic });
  // sensor-shift stage: square frame with four flat copper coils and magnets that move the sensor to cancel shake
  p.push({ geo: box(14.4, 14.4, 0.5, x, y, zf + 1.0, 0.8), mat: can });
  for (const [cx, cy] of [[5.4, 0], [-5.4, 0], [0, 5.4], [0, -5.4]]) {
    const ring = new THREE.RingGeometry(0.9, 1.7, 40);
    ring.translate(x + cx, y + cy, zf + 0.72);
    p.push({ geo: ring, mat: copper });
    p.push({ geo: box(1.6, 1.6, 0.6, x + cx * 1.12, y + cy * 1.12, zf + 1.5, 0.2), mat: magnet });
  }
  p.push({ geo: box(14.0, 14.0, 0.5, x, y, zf + 1.6, 0.6), mat: pcb });
  // flex cable to the logic board (on the other side of the plateau, -x)
  p.push({ geo: box(16, 4.2, 0.12, x - 14, y - 1, zf + 1.9, 0.6), mat: flex });
  return p;
}

/** 48 MP ultra wide: compact cut-open barrel (6 elements), IR filter, sensor, PCB. */
function ultraWide(): Prim[] {
  const [x, y] = UW;
  const p: Prim[] = [];
  p.push({ geo: lathe([[4.6, 0.3], [4.6, 4.9]], x, y, true), mat: barrel });
  p.push({ geo: lathe([[4.1, 4.9], [4.1, 0.3]], x, y, true), mat: barrelInside });
  p.push({ geo: lathe([[4.1, 0.3], [4.6, 0.3]], x, y, true), mat: barrel });
  const els: [number, number, number, number, number][] = [
    [3.9, 0.65, 0.6, 0.7, -0.3], // strongly curved front element for the wide field
    [3.2, 1.6, 0.4, -0.2, 0.2],
    [2.9, 2.3, 0.45, 0.25, 0.05],
    [2.9, 3.0, 0.35, -0.1, 0.25],
    [3.3, 3.6, 0.4, 0.2, -0.2],
    [3.7, 4.3, 0.3, 0.25, -0.25],
  ];
  for (const [r, z, t, f, b] of els) p.push({ geo: element(r, z, t, f, b, x, y), mat: lensGlass });
  const zf = Z0 + 5.6;
  p.push({ geo: box(8.0, 6.4, 0.3, x, y, zf - 0.45, 0.3), mat: irFilter });
  p.push({ geo: box(7.0, 5.3, 0.12, x, y, zf, 0.1), mat: sensorDie });
  p.push({ geo: box(8.4, 6.6, 0.08, x, y, zf + 0.08, 0.2), mat: gold });
  p.push({ geo: box(10.0, 10.0, 0.6, x, y, zf + 0.45, 0.4), mat: ceramic });
  p.push({ geo: box(11.0, 11.0, 0.5, x, y, zf + 1.0, 0.5), mat: pcb });
  p.push({ geo: box(14, 3.6, 0.12, x - 13, y + 1, zf + 1.3, 0.5), mat: flex });
  return p;
}

/** 4x telephoto: short entry lens, tetraprism that folds the light sideways (towards -y), horizontal lens group, sensor. */
function telephoto(): Prim[] {
  const [x, y] = TELE;
  const p: Prim[] = [];
  p.push({ geo: lathe([[3.9, 0.3], [3.9, 2.3]], x, y, true), mat: barrel });
  p.push({ geo: lathe([[3.4, 2.3], [3.4, 0.3]], x, y, true), mat: barrelInside });
  p.push({ geo: element(3.2, 0.7, 0.55, 0.45, 0.05, x, y), mat: lensGlass });
  p.push({ geo: element(3.0, 1.6, 0.4, -0.1, 0.2, x, y), mat: lensGlass });
  // tetraprism: a glass block whose cross-section (in the y-z plane) is a trapezoid; light enters along +z,
  // bounces four times inside it and leaves along -y
  const s = new THREE.Shape();
  s.moveTo(-3.6, 0);
  s.lineTo(3.6, 0);
  s.lineTo(2.2, 3.8);
  s.lineTo(-5.4, 3.8);
  s.closePath();
  const prism = new THREE.ExtrudeGeometry(s, { depth: 7.2, bevelEnabled: true, bevelThickness: 0.15, bevelSize: 0.15, bevelSegments: 2 });
  // shape x -> phone y, shape y -> depth (+z), extrude -> phone x
  prism.rotateY(Math.PI / 2); // extrude axis (z) -> x
  prism.rotateX(Math.PI / 2); // shape y -> z
  prism.translate(x - 3.6, y, Z0 + 2.6);
  p.push({ geo: prism, mat: prismGlass });
  // horizontal lens group along -y, in a cut-open barrel (open towards +x)
  const axisZ = Z0 + 4.5;
  const hz = (g: THREE.BufferGeometry) => g; // helper for readability
  const hBarrel = new THREE.CylinderGeometry(2.9, 2.9, 12, 48, 1, true, 0, Math.PI);
  hBarrel.rotateY(Math.PI); // keep the -x half
  hBarrel.translate(x, y - 11.5, axisZ);
  p.push({ geo: hz(hBarrel), mat: barrel });
  for (let i = 0; i < 4; i++) {
    const g = new THREE.CylinderGeometry(2.5 - i * 0.12, 2.5 - i * 0.12, 0.45, 48);
    g.translate(x, y - 7.5 - i * 2.6, axisZ);
    p.push({ geo: g, mat: lensGlass });
  }
  p.push({ geo: torus(3.3, 0.35, x, 0, 0).rotateX(Math.PI / 2).translate(0, y - 12, axisZ), mat: copper });
  // sensor standing on its side at the end of the group, facing +y
  const sens = box(5.8, 4.4, 0.12, x, 0, 0, 0.1).rotateX(Math.PI / 2).translate(0, y - 18.3, axisZ);
  p.push({ geo: sens, mat: sensorDie });
  p.push({ geo: box(8.0, 6.4, 0.6, x, 0, 0, 0.3).rotateX(Math.PI / 2).translate(0, y - 18.9, axisZ), mat: ceramic });
  p.push({ geo: box(9.0, 7.4, 0.5, x, 0, 0, 0.3).rotateX(Math.PI / 2).translate(0, y - 19.5, axisZ), mat: pcb });
  p.push({ geo: box(10, 3.2, 0.12, x - 6, y - 19.8, axisZ + 2.2, 0.5), mat: flex });
  return p;
}

/* ------------------------------ write ------------------------------ */
async function write(id: string, prims: Prim[]) {
  const doc = new Document();
  const buf = doc.createBuffer();
  const mesh = doc.createMesh(id);
  for (const p of prims) {
    let g = p.geo.index ? p.geo.toNonIndexed() : p.geo;
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    g = g.clone();
    g.scale(S, S, S);
    const prim = doc
      .createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(g.getAttribute('position').array)).setBuffer(buf))
      .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(g.getAttribute('normal').array)).setBuffer(buf))
      .setMaterial(p.mat(doc));
    mesh.addPrimitive(prim);
  }
  doc.createScene().addChild(doc.createNode(id).setMesh(mesh).setExtras({ object_id: 'iphone-17-pro', part_id: id, mesh_source: 'procedural', units: 'phone height = 1' }));
  await doc.transform(dedup(), quantize());
  const glb = await new NodeIO().registerExtensions(KHRONOS_EXTENSIONS).writeBinary(doc);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${id}.glb`), glb);
  console.log(`[camera] ${id.padEnd(19)} ${(glb.byteLength / 1024).toFixed(0)} KB`);
}

await write('main-camera-lens', mainLens());
await write('main-camera-sensor', mainSensor());
await write('ultra-wide-camera', ultraWide());
await write('telephoto-camera', telephoto());
