/**
 * Build the procedural human eye: one GLB per part, anatomically proportioned, sharing one origin
 * (the centre of the eyeball) so the parts line up when assembled. No fal image-to-3D here: it only sees
 * outsides and would invent the inside of an eye. fal is used only for the iris and retina TEXTURES.
 *
 *   npm run build-eye            (re-uses existing fal textures; generates them only if missing)
 *
 * Writes:
 *   public/cache/meshes/eye/<part_id>.glb    (served at /cache/meshes/eye/<part_id>.glb, like other checked meshes)
 *   public/cache/eye/textures/                raw fal images + prepared textures (PNG/JPEG, for slides too)
 *   public/cache/eye.json                     mesh_url filled in for every part
 *
 * Real adult eye, in millimetres (then scaled so the eyeball is 1.0 across):
 *   eyeball ~23-24 mm; cornea 11.5 mm wide, radius of curvature 7.8 mm, 0.55 mm thick centrally;
 *   anterior chamber ~3 mm deep; iris 12 mm across with a 4 mm pupil; lens 9.5 mm x 4 mm, back more curved;
 *   optic disc ~1.5 mm, ~15 degrees nasal of the fovea; optic nerve ~3.5 mm across.
 * This is a RIGHT eye: +z anterior, +y superior, +x nasal.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { Document, NodeIO, type Material, type Texture } from '@gltf-transform/core';
import {
  KHRONOS_EXTENSIONS,
  KHRMaterialsClearcoat,
  KHRMaterialsIOR,
  KHRMaterialsSpecular,
  KHRMaterialsTransmission,
  KHRMaterialsVolume,
} from '@gltf-transform/extensions';
import { dedup, quantize } from '@gltf-transform/functions';
import { CHECKED_DIR } from '../server/lib/cache';
import {
  capArc,
  chaikin,
  finalize,
  lathe,
  merge,
  rod,
  scaleMesh,
  sphereShell,
  tube,
  type Hole,
  type MeshData,
  type Profile,
  type V3,
} from './eye/geometry';
import { ensureTextures } from './eye/textures';
import { prepIris, prepRetina, RETINA_PHI_MAX, retinaUV } from './eye/texture-prep';

const OBJECT_ID = 'eye';
const MESH_DIR = path.join(CHECKED_DIR, 'meshes', OBJECT_ID);
const EYE_DIR = path.join(CHECKED_DIR, OBJECT_ID);
const TEX_DIR = path.join(EYE_DIR, 'textures');
const TEARDOWN = path.join(CHECKED_DIR, `${OBJECT_ID}.json`);

/** mm -> scene units: the sclera's outer diameter (23 mm) becomes 1.0. */
const S = 1 / 23;
const deg = Math.PI / 180;

/* ------------------------------- anatomy (mm) ------------------------------- */

// Sclera, choroid and retina: concentric shells around the eye centre.
const SCLERA = { out: 11.5, in: 10.9, front: 150 * deg }; // front opening = limbus, 11.5 mm across
const CHOROID = { out: 10.88, in: 10.66, front: RETINA_PHI_MAX };
const RETINA = { out: 10.64, in: 10.42, front: RETINA_PHI_MAX }; // ends at the ora serrata

// Optic disc / nerve direction: 15 degrees nasal of the fovea (posterior pole) and ~0.7 degrees above it,
// matching the retina texture, which puts the fovea 0.7 degrees below the disc.
const DISC_PHI = Math.hypot(15, 0.7) * deg;
const DISC_AZ = Math.atan2(0.7, 15);
const DISC_DIR: V3 = [Math.sin(DISC_PHI) * Math.cos(DISC_AZ), Math.sin(DISC_PHI) * Math.sin(DISC_AZ), -Math.cos(DISC_PHI)];
const NERVE_R = 1.75; // 3.5 mm across
const holeAt = (radiusMm: number) => (R: number): Hole[] => [{ dir: DISC_DIR, angle: radiusMm / R }];

// Cornea: anterior radius 7.8 mm, apex 12.49 mm in front of the centre, meeting the sclera at the limbus.
const LIMBUS_R = Math.sin(SCLERA.front) * SCLERA.out; // 5.75
const LIMBUS_Z = -Math.cos(SCLERA.front) * SCLERA.out; // 9.96
const CORNEA_ANT_R = 7.8;
const CORNEA_ANT_C = LIMBUS_Z - Math.sqrt(CORNEA_ANT_R ** 2 - LIMBUS_R ** 2); // centre of the anterior sphere
const CORNEA_APEX = CORNEA_ANT_C + CORNEA_ANT_R; // ~12.49
const CORNEA_POST_APEX = CORNEA_APEX - 0.55; // 0.55 mm thick centrally
const CORNEA_POST_BASE: [number, number] = [5.3, 9.5]; // thicker (~0.7 mm) at the periphery
const CORNEA_POST_R = ((CORNEA_POST_APEX - CORNEA_POST_BASE[1]) ** 2 + CORNEA_POST_BASE[0] ** 2) / (2 * (CORNEA_POST_APEX - CORNEA_POST_BASE[1]));
const CORNEA_POST_C = CORNEA_POST_APEX - CORNEA_POST_R;

// Lens: 9.5 mm across, 4 mm thick; front radius 9 mm, back radius 5.6 mm (back more curved).
// Front pole ~3.2 mm behind the back of the cornea (anterior chamber depth ~3 mm).
const LENS_ANT_APEX = 8.7;
const LENS_ANT_R = 9;
const LENS_ANT_C = LENS_ANT_APEX - LENS_ANT_R;
const LENS_POST_APEX = LENS_ANT_APEX - 4.0;
const LENS_POST_R = 5.6;
const LENS_POST_C = LENS_POST_APEX + LENS_POST_R;
const LENS_EQ_R = 4.75;
const lensFront = (r: number) => LENS_ANT_C + Math.sqrt(LENS_ANT_R ** 2 - r * r);
const lensBack = (r: number) => LENS_POST_C - Math.sqrt(LENS_POST_R ** 2 - r * r);

// Iris: 12 mm across, 4 mm pupil, resting on the front of the lens, slightly bowed forward at the collarette.
const PUPIL_R = 2.0;
const IRIS_ROOT_R = 6.25;
const irisFront = (r: number) => {
  const t = (r - PUPIL_R) / (IRIS_ROOT_R - PUPIL_R);
  return 8.8 + 0.13 * Math.sin(Math.PI * Math.min(1, t * 1.6)) * (1 - 0.4 * t) - 0.06 * t;
};
const irisBack = (r: number) => 8.565 - 0.1 * ((r - PUPIL_R) / (IRIS_ROOT_R - PUPIL_R));

// Ciliary body: a ring of triangular section lining the sclera from the iris root back to the ora serrata.
const CB_OUT = SCLERA.in - 0.04;
const CB_FRONT_Z = 8.7;
const CB_BACK_Z = -Math.cos(CHOROID.front) * CB_OUT; // meets the front edge of the choroid
const CB_APEX: [number, number] = [5.75, 7.35]; // ciliary processes, ~1 mm from the lens equator

// Vitreous: fills the eye behind the lens, inside the retina.
const VITREOUS_R = RETINA.in - 0.04;

/* ------------------------------- geometry ------------------------------- */

function corneaMesh(): MeshData {
  const ant = capArc(CORNEA_ANT_R, CORNEA_ANT_C, 0, LIMBUS_R, 1, 64);
  const post = capArc(CORNEA_POST_R, CORNEA_POST_C, CORNEA_POST_BASE[0], 0, 1, 64);
  return lathe([{ pts: ant }, { pts: [[LIMBUS_R, LIMBUS_Z], CORNEA_POST_BASE] }, { pts: post }], 128);
}

function aqueousMesh(): MeshData {
  const g = 0.035; // small gap so surfaces never touch (no z-fighting)
  const front = capArc(CORNEA_POST_R - g, CORNEA_POST_C, 0, 5.25, 1, 48);
  const angle: [number, number] = [IRIS_ROOT_R - 0.15, irisFront(IRIS_ROOT_R - 0.15) + g];
  const iris: Profile = [];
  for (let i = 0; i <= 32; i++) {
    const r = IRIS_ROOT_R - 0.15 - ((IRIS_ROOT_R - 0.15 - (PUPIL_R + 0.05)) * i) / 32;
    iris.push([r, irisFront(r) + g]);
  }
  const lens: Profile = [];
  for (let i = 0; i <= 16; i++) {
    const r = (PUPIL_R - 0.05) * (1 - i / 16);
    lens.push([r, lensFront(r) + g]);
  }
  const pupilEdge: Profile = [
    [PUPIL_R + 0.05, irisFront(PUPIL_R + 0.05) + g],
    [PUPIL_R - 0.05, lensFront(PUPIL_R - 0.05) + g],
  ];
  return lathe([{ pts: front }, { pts: [front[front.length - 1], angle] }, { pts: iris }, { pts: pupilEdge }, { pts: lens }], 128);
}

function irisMeshes(): { front: MeshData; back: MeshData } {
  const n = 48;
  const front: Profile = [];
  for (let i = 0; i <= n; i++) {
    const r = PUPIL_R + ((IRIS_ROOT_R - PUPIL_R) * i) / n;
    front.push([r, irisFront(r)]);
  }
  const back: Profile = [];
  for (let i = 0; i <= n; i++) {
    const r = IRIS_ROOT_R - ((IRIS_ROOT_R - PUPIL_R) * i) / n;
    back.push([r, irisBack(r)]);
  }
  // Outline goes pupil -> root along the front, down the root, root -> pupil along the back, up the pupil rim.
  const outline = [front, [front[n], back[0]] as Profile, back, [back[n], front[0]] as Profile];
  const all = lathe(outline.map((pts, k) => ({ pts, v: k === 0 ? (r: number) => (r - PUPIL_R) / (IRIS_ROOT_R - PUPIL_R) : undefined })), 192);
  // Split: the textured front surface (segment 0) vs the dark pigmented back and rims.
  const per = (pts: Profile) => pts.length * 193;
  const frontCount = per(front);
  const pick = (keepFront: boolean): MeshData => {
    const idx = [];
    for (let t = 0; t < all.idx.length; t += 3) {
      const isFront = all.idx[t] < frontCount && all.idx[t + 1] < frontCount && all.idx[t + 2] < frontCount;
      if (isFront === keepFront) idx.push(all.idx[t], all.idx[t + 1], all.idx[t + 2]);
    }
    return { ...all, idx };
  };
  return { front: pick(true), back: pick(false) };
}

function lensMesh(): MeshData {
  const pts: Profile = [];
  const n = 28;
  for (let i = 0; i <= n; i++) {
    const r = (LENS_EQ_R * i) / n;
    pts.push([r, lensFront(r)]);
  }
  for (let i = 1; i <= n; i++) {
    const r = LENS_EQ_R * (1 - i / n);
    pts.push([r, lensBack(r)]);
  }
  return lathe([{ pts: chaikin(pts, 2) }], 128); // rounded equator
}

function ciliaryMeshes(): { body: MeshData; zonules: MeshData } {
  const arc: Profile = [];
  const zs = [CB_FRONT_Z, CB_BACK_Z];
  for (let i = 0; i <= 24; i++) {
    const z = zs[0] + ((zs[1] - zs[0]) * i) / 24;
    arc.push([Math.sqrt(CB_OUT ** 2 - z * z), z]);
  }
  const back = arc[arc.length - 1];
  const front = arc[0];
  // Ciliary processes: ~70 radial folds on the inner surface, as a gentle ripple.
  const body = lathe([{ pts: arc }, { pts: [back, CB_APEX] }, { pts: [CB_APEX, [front[0] - 0.2, front[1]]] }, { pts: [[front[0] - 0.2, front[1]], front] }], 280);
  for (let i = 0; i < body.pos.length; i += 3) {
    const [x, y, z] = [body.pos[i], body.pos[i + 1], body.pos[i + 2]];
    const r = Math.hypot(x, y);
    if (r > CB_OUT - 0.15 || r < 1) continue; // only the inner (process) side
    const th = Math.atan2(y, x);
    const k = 1 - 0.18 * (0.5 + 0.5 * Math.cos(70 * th));
    const nr = CB_APEX[0] + (r - CB_APEX[0]) * 1; // keep apex radius; ripple pushes outwards
    body.pos[i] = (x / r) * (nr + (1 - k) * 0.6);
    body.pos[i + 1] = (y / r) * (nr + (1 - k) * 0.6);
    body.pos[i + 2] = z;
  }
  // Zonular fibres: from the ciliary processes to the lens capsule just in front of, at and behind the equator.
  const fibres: MeshData[] = [];
  const N = 96;
  const targets: [number, number][] = [
    [4.35, lensFront(4.35) - 0.02],
    [LENS_EQ_R - 0.08, (lensFront(LENS_EQ_R - 0.3) + lensBack(LENS_EQ_R - 0.3)) / 2],
    [4.35, lensBack(4.35) + 0.02],
  ];
  for (let j = 0; j < N; j++) {
    const th = ((j + 0.5) / N) * Math.PI * 2;
    const c = Math.cos(th);
    const s = Math.sin(th);
    targets.forEach(([tr, tz], k) => {
      const sr = CB_APEX[0] + 0.55;
      const sz = CB_APEX[1] - 0.15 + 0.15 * (k - 1);
      fibres.push(rod([sr * c, sr * s, sz], [tr * c, tr * s, tz], 0.03, 4));
    });
  }
  return { body: finalize(body), zonules: merge(...fibres) };
}

function vitreousMesh(): MeshData {
  const g = 0.04;
  const front: Profile = [];
  for (let i = 0; i <= 24; i++) {
    const r = (4.5 * i) / 24;
    front.push([r, lensBack(r) - g]);
  }
  const rimPhi = RETINA.front;
  const rim: [number, number] = [Math.sin(rimPhi) * VITREOUS_R, -Math.cos(rimPhi) * VITREOUS_R];
  const mid: Profile = chaikin([front[front.length - 1], [5.6, 6.75], [7.6, 5.95], rim], 2);
  const back: Profile = [];
  for (let i = 0; i <= 64; i++) {
    const phi = rimPhi * (1 - i / 64);
    back.push([Math.sin(phi) * VITREOUS_R, -Math.cos(phi) * VITREOUS_R]);
  }
  return lathe([{ pts: front }, { pts: mid }, { pts: back }], 128);
}

function nerveMesh(): MeshData {
  const p0 = DISC_DIR.map((v) => v * (SCLERA.in + 0.05)) as V3;
  const p1 = DISC_DIR.map((v) => v * 14) as V3;
  // Leaves posteriorly and medially (nasally), curving gently towards the optic canal.
  const p2: V3 = [p1[0] + 1.3, p1[1] + 0.15, p1[2] - 3.6];
  const p3: V3 = [p2[0] + 2.4, p2[1] + 0.3, p2[2] - 4.2];
  return tube([p0, p1, p2, p3], NERVE_R, 64, 40, true);
}

/* ------------------------------- glTF output ------------------------------- */

interface Prim {
  mesh: MeshData;
  material: (doc: Document) => Material;
  /** optional per-vertex colour (linear RGB) */
  color?: (x: number, y: number, z: number, i: number) => [number, number, number];
}

const srgb = (hex: string): [number, number, number, number] => {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return [lin((n >> 16) & 255), lin((n >> 8) & 255), lin(n & 255), 1];
};

function basic(doc: Document, name: string, hex: string, rough: number): Material {
  return doc.createMaterial(name).setBaseColorFactor(srgb(hex)).setMetallicFactor(0).setRoughnessFactor(rough);
}

/**
 * Clear materials. thicknessMm > 0 gives a refracting volume (cornea, lens). The watery humours use
 * thicknessMm = 0 (thin-walled): a 20 mm refracting ball would act like a crystal ball and show ghost
 * images of the inside of the eye, which is not what the eye looks like.
 */
function glass(doc: Document, name: string, o: { hex: string; rough: number; ior: number; thicknessMm: number; atten?: [number, number, number]; attenMm?: number; transmission?: number; clearcoat?: number; specular?: number }): Material {
  const m = basic(doc, name, o.hex, o.rough);
  const tr = doc.createExtension(KHRMaterialsTransmission).createTransmission().setTransmissionFactor(o.transmission ?? 1);
  const ior = doc.createExtension(KHRMaterialsIOR).createIOR().setIOR(o.ior);
  m.setExtension('KHR_materials_transmission', tr).setExtension('KHR_materials_ior', ior);
  if (o.thicknessMm > 0) {
    const vol = doc.createExtension(KHRMaterialsVolume).createVolume().setThicknessFactor(o.thicknessMm * S);
    if (o.atten) vol.setAttenuationColor(o.atten).setAttenuationDistance((o.attenMm ?? 50) * S);
    m.setExtension('KHR_materials_volume', vol);
  }
  if (o.specular !== undefined) {
    m.setExtension('KHR_materials_specular', doc.createExtension(KHRMaterialsSpecular).createSpecular().setSpecularFactor(o.specular));
  }
  if (o.clearcoat) {
    const cc = doc.createExtension(KHRMaterialsClearcoat).createClearcoat().setClearcoatFactor(o.clearcoat).setClearcoatRoughnessFactor(0.03);
    m.setExtension('KHR_materials_clearcoat', cc);
  }
  return m;
}

function texture(doc: Document, name: string, file: string): Texture {
  return doc.createTexture(name).setImage(fs.readFileSync(file)).setMimeType(file.endsWith('.png') ? 'image/png' : 'image/jpeg');
}

async function writePart(partId: string, prims: Prim[]): Promise<{ file: string; bytes: number; tris: number }> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const mesh = doc.createMesh(partId);
  let tris = 0;
  for (const p of prims) {
    const m = scaleMesh(p.mesh, S);
    const vcount = m.pos.length / 3;
    const prim = doc
      .createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(m.pos)).setBuffer(buffer))
      .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(m.nrm)).setBuffer(buffer))
      .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(m.uv)).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(vcount > 65535 ? new Uint32Array(m.idx) : new Uint16Array(m.idx)).setBuffer(buffer))
      .setMaterial(p.material(doc));
    if (p.color) {
      const col = new Float32Array(vcount * 3);
      for (let i = 0; i < vcount; i++) col.set(p.color(p.mesh.pos[i * 3], p.mesh.pos[i * 3 + 1], p.mesh.pos[i * 3 + 2], i), i * 3);
      prim.setAttribute('COLOR_0', doc.createAccessor().setType('VEC3').setArray(col).setBuffer(buffer));
    }
    mesh.addPrimitive(prim);
    tris += m.idx.length / 3;
  }
  const node = doc.createNode(partId).setMesh(mesh).setExtras({ object_id: OBJECT_ID, part_id: partId, units: 'eyeball diameter = 1', frame: '+z anterior, +y superior, +x nasal (right eye)' });
  doc.createScene(OBJECT_ID).addChild(node);
  await doc.transform(dedup(), quantize({ quantizeNormal: 10, quantizeTexcoord: 14, quantizePosition: 16 }));
  const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS);
  const glb = await io.writeBinary(doc);
  const file = path.join(MESH_DIR, `${partId}.glb`);
  fs.writeFileSync(file, glb);
  return { file, bytes: glb.byteLength, tris };
}

/* ------------------------------- main ------------------------------- */

async function main() {
  fs.mkdirSync(MESH_DIR, { recursive: true });
  const meta = await ensureTextures(TEX_DIR);

  console.log('[eye] preparing textures');
  const iris = await prepIris(path.join(TEX_DIR, 'iris.raw.png'));
  fs.writeFileSync(path.join(TEX_DIR, 'iris.uv.jpg'), iris.strip);
  fs.writeFileSync(path.join(TEX_DIR, 'iris.png'), iris.slide);
  const retina = await prepRetina(path.join(TEX_DIR, 'retina.raw.png'));
  fs.writeFileSync(path.join(TEX_DIR, 'retina.uv.jpg'), retina.uv);
  fs.writeFileSync(path.join(TEX_DIR, 'retina.png'), retina.slide);

  const irisM = irisMeshes();
  const cil = ciliaryMeshes();

  const parts: Record<string, Prim[]> = {
    cornea: [{ mesh: corneaMesh(), material: (d) => glass(d, 'cornea', { hex: '#f4fbff', rough: 0.02, ior: 1.376, thicknessMm: 0.6, clearcoat: 1 }) }],
    aqueous: [{ mesh: aqueousMesh(), material: (d) => glass(d, 'aqueous humour', { hex: '#f6fcff', rough: 0.08, ior: 1.336, thicknessMm: 0, specular: 0.25 }) }],
    iris: [
      { mesh: irisM.front, material: (d) => basic(d, 'iris (anterior stroma)', '#ffffff', 0.62).setBaseColorTexture(texture(d, 'iris', path.join(TEX_DIR, 'iris.uv.jpg'))) },
      { mesh: irisM.back, material: (d) => basic(d, 'iris (posterior pigment epithelium)', '#2a1610', 0.7) },
    ],
    lens: [{ mesh: lensMesh(), material: (d) => glass(d, 'crystalline lens', { hex: '#fff1cf', rough: 0.1, ior: 1.41, thicknessMm: 4, atten: [1, 0.9, 0.68], attenMm: 14, transmission: 0.95 }) }],
    'ciliary-body': [
      { mesh: cil.body, material: (d) => basic(d, 'ciliary body', '#5a2420', 0.55) },
      { mesh: cil.zonules, material: (d) => basic(d, 'zonular fibres', '#efe9dc', 0.4) },
    ],
    vitreous: [{ mesh: vitreousMesh(), material: (d) => glass(d, 'vitreous humour', { hex: '#eef8f2', rough: 0.3, ior: 1.336, thicknessMm: 0, specular: 0.2 }) }],
    retina: [
      {
        mesh: sphereShell({ Rout: RETINA.out, Rin: RETINA.in, phiMax: RETINA.front, holes: holeAt(0.78), uv: retinaUV, rings: 110, radial: 180 }),
        material: (d) => basic(d, 'retina', '#ffffff', 0.45).setBaseColorTexture(texture(d, 'retina fundus', path.join(TEX_DIR, 'retina.uv.jpg'))),
      },
    ],
    choroid: [{ mesh: sphereShell({ Rout: CHOROID.out, Rin: CHOROID.in, phiMax: CHOROID.front, holes: holeAt(1.0), rings: 64, radial: 128 }), material: (d) => basic(d, 'choroid', '#4a1512', 0.5) }],
    sclera: [
      {
        mesh: sphereShell({ Rout: SCLERA.out, Rin: SCLERA.in, phiMax: SCLERA.front, holes: (R) => [{ dir: DISC_DIR, angle: (NERVE_R + 0.08) / R }], rings: 96, radial: 160 }),
        material: (d) => {
          const m = basic(d, 'sclera', '#f3eee4', 0.38);
          m.setExtension('KHR_materials_clearcoat', d.createExtension(KHRMaterialsClearcoat).createClearcoat().setClearcoatFactor(0.25).setClearcoatRoughnessFactor(0.2));
          return m;
        },
      },
    ],
    'optic-nerve': [
      {
        mesh: nerveMesh(),
        material: (d) => basic(d, 'optic nerve', '#ffffff', 0.6),
        // Vertex colours: cream sheath, and at the front end the optic disc - pale pink rim, whiter central cup.
        color: (x, y, z) => {
          const p: V3 = [x, y, z];
          const along = p[0] * DISC_DIR[0] + p[1] * DISC_DIR[1] + p[2] * DISC_DIR[2];
          const lateral = Math.sqrt(Math.max(0, x * x + y * y + z * z - along * along));
          const cream = srgb('#e8d9a8');
          if (along > SCLERA.in) {
            const t = Math.min(1, lateral / NERVE_R);
            const cup = srgb('#fff4e6');
            const rim = srgb('#f2b8a0');
            const k = Math.min(1, Math.max(0, (t - 0.25) / 0.45));
            return [0, 1, 2].map((c) => cup[c] * (1 - k) + rim[c] * k) as [number, number, number];
          }
          return [cream[0], cream[1], cream[2]];
        },
      },
    ],
  };

  const td = JSON.parse(fs.readFileSync(TEARDOWN, 'utf8'));
  for (const part of td.parts as { id: string; mesh_url: string | null }[]) {
    const prims = parts[part.id];
    if (!prims) throw new Error(`no geometry for part ${part.id}`);
    const out = await writePart(part.id, prims);
    part.mesh_url = `/cache/meshes/${OBJECT_ID}/${part.id}.glb`;
    console.log(`[eye] ${part.id.padEnd(12)} ${(out.bytes / 1024).toFixed(0).padStart(6)} KB  ${out.tris} triangles`);
  }
  td.textures = {
    note: 'fal 2D textures; meshes are procedural (scripts/build-eye.ts)',
    iris: { model: meta.iris?.model, request_id: meta.iris?.request_id },
    retina: { model: meta.retina?.model, request_id: meta.retina?.request_id },
  };
  fs.writeFileSync(TEARDOWN, JSON.stringify(td, null, 2) + '\n');
  console.log(`[eye] mesh_url set for ${td.parts.length} parts in ${path.relative(process.cwd(), TEARDOWN)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
