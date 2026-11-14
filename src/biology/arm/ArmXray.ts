/**
 * The X-ray arm overlay (plain three.js, like the rest of src/overlay/).
 *
 * World units = overlay pixels, origin at the canvas centre, +z towards the viewer (see frames.ts).
 * Create one, add `.root` to a scene, then call update() every frame with the latest landmarks.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { armGeometry, blendFrames, namedPoint, type ArmGeometry, type Frame } from './frames';
import { limbRadius, placements, SPREAD_FOR_SLIPS, type Anchor, type Placement } from './placement';
import { FINGERS, type ArmFrame, type ArmTeardown, type FingerId, type Keystroke } from './types';

export interface ArmXrayInput {
  frame: ArmFrame | null;
  /** canvas size in px */
  width: number;
  height: number;
  /** 0 = assembled on the arm, 1 = layers fully apart */
  explode: number;
  /** 1-6: that layer full, layers above it (outer) faded, below it dimmed. null = everything */
  layerFocus: number | null;
  /** part id -> glow strength (0..1), e.g. typing role intensities */
  highlight: Map<string, number>;
  /** recent keystrokes (any order); pulses use the newest press/lift per finger */
  keystrokes: Keystroke[];
  /** clock for pulses, same time base as Keystroke.t */
  now: number;
  /** freeze: keep the last placement, ignore new landmarks */
  frozen?: boolean;
  side?: 'right' | 'left';
}

export interface ArmLabel {
  id: string;
  name: string;
  layer: number;
  /** screen px (top-left origin) of the point on the part, and where the label sits */
  at: [number, number];
  label: [number, number];
  visible: boolean;
  glow: number;
}

interface MeshInfo {
  width: number;
  depth: number;
}

interface Instance {
  pl: Placement;
  mesh: THREE.Mesh;
  /** path-bent meshes keep their normalised vertices here */
  base?: { x: Float32Array; y: Float32Array; z: Float32Array; n: Float32Array };
  layer: number;
  /** world point used for this part's label */
  mid: THREE.Vector3;
}

const LAYERS = [1, 2, 3, 4, 5, 6];
const BASE = '/cache/arm-hand/';
const ease = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** Exponential moving average of landmarks, so the overlay does not jitter. */
export class LandmarkSmoother {
  private last: ArmFrame | null = null;
  constructor(private alpha = 0.35) {}
  push(f: ArmFrame | null): ArmFrame | null {
    if (!f || !f.pose || !f.hand) return this.last;
    if (!this.last || !this.last.pose || !this.last.hand) {
      this.last = structuredClone(f);
      return this.last;
    }
    const a = this.alpha;
    const mix = (p: { x: number; y: number; z: number }[], q: { x: number; y: number; z: number }[]) =>
      q.map((v, i) => (p[i] ? { x: p[i].x + (v.x - p[i].x) * a, y: p[i].y + (v.y - p[i].y) * a, z: p[i].z + (v.z - p[i].z) * a } : v));
    this.last = { ...f, pose: mix(this.last.pose!, f.pose), hand: mix(this.last.hand!, f.hand) };
    return this.last;
  }
  reset() {
    this.last = null;
  }
}

export class ArmXray {
  readonly root = new THREE.Group();
  private layerGroups = new Map<number, THREE.Group>();
  private instances: Instance[] = [];
  private partMats = new Map<string, THREE.MeshStandardMaterial[]>();
  private td: ArmTeardown;
  private info: Record<string, MeshInfo> = {};
  private skin: THREE.Mesh;
  private skinSegs = 72;
  private skinSides = 28;
  private slips: { finger: FingerId; kind: 'flex' | 'ext'; mesh: THREE.Mesh }[] = [];
  private smoother = new LandmarkSmoother();
  private geom: ArmGeometry | null = null;
  private layerEase = new Map<number, number>();
  private opacity = new Map<number, number>();
  ready: Promise<void>;

  constructor(td: ArmTeardown) {
    this.td = td;
    for (const l of LAYERS) {
      const g = new THREE.Group();
      g.name = `layer-${l}`;
      g.renderOrder = 10 - l;
      this.layerGroups.set(l, g);
      this.root.add(g);
      this.layerEase.set(l, 0);
      this.opacity.set(l, 1);
    }
    // Skin: a translucent sleeve built in code (layer 1).
    const skinColor = new THREE.Color(this.part('skin')?.color ?? '#e3b896');
    const skinMat = new THREE.MeshPhysicalMaterial({
      color: skinColor, roughness: 0.55, transparent: true, opacity: 0.32, depthWrite: false,
      side: THREE.DoubleSide, sheen: 0.6, sheenColor: new THREE.Color('#ffd9c0'), emissive: skinColor, emissiveIntensity: 0,
    });
    this.partMats.set('skin', [skinMat]);
    const sg = new THREE.BufferGeometry();
    const nv = (this.skinSegs + 1) * (this.skinSides + 1);
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nv * 3), 3));
    const idx: number[] = [];
    for (let i = 0; i < this.skinSegs; i++)
      for (let j = 0; j < this.skinSides; j++) {
        const a = i * (this.skinSides + 1) + j;
        const b = a + this.skinSides + 1;
        idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    sg.setIndex(idx);
    this.skin = new THREE.Mesh(sg, skinMat);
    this.skin.frustumCulled = false;
    this.skin.renderOrder = 50;
    this.layerGroups.get(1)!.add(this.skin);
    this.ready = this.load();
  }

  private part(id: string) {
    return this.td.parts.find((p) => p.id === id);
  }

  private async load() {
    this.info = await fetch(`${BASE}meshes.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
    const loader = new GLTFLoader();
    const pls = placements();
    const wanted = [...new Set(pls.map((p) => p.mesh))];
    const geoms = new Map<string, { geo: THREE.BufferGeometry; map: THREE.Texture | null }>();
    await Promise.all(
      wanted.map(async (id) => {
        try {
          const gltf = await loader.loadAsync(`${BASE}${id}.glb`);
          let found: THREE.Mesh | null = null;
          gltf.scene.traverse((o) => {
            if (!found && (o as THREE.Mesh).isMesh) found = o as THREE.Mesh;
          });
          if (!found) return;
          const m = found as THREE.Mesh;
          m.updateWorldMatrix(true, false);
          const geo = m.geometry.clone().applyMatrix4(m.matrixWorld);
          // quantized attributes -> plain floats so we can deform them
          for (const name of ['position', 'normal', 'uv']) {
            const a = geo.getAttribute(name) as THREE.BufferAttribute | undefined;
            if (a && !(a.array instanceof Float32Array)) {
              const f = new Float32Array(a.count * a.itemSize);
              for (let i = 0; i < a.count; i++) for (let k = 0; k < a.itemSize; k++) f[i * a.itemSize + k] = a.getComponent(i, k);
              geo.setAttribute(name, new THREE.BufferAttribute(f, a.itemSize));
            }
          }
          if (!geo.getAttribute('normal')) geo.computeVertexNormals();
          const src = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshStandardMaterial;
          geoms.set(id, { geo, map: src?.map ?? null });
          if (!this.info[id]) {
            geo.computeBoundingBox();
            const bb = geo.boundingBox!;
            this.info[id] = { width: bb.max.x - bb.min.x, depth: bb.max.z - bb.min.z };
          }
        } catch (err) {
          console.warn(`[arm] mesh ${id} failed to load`, err);
        }
      }),
    );
    for (const pl of pls) {
      const g = geoms.get(pl.mesh);
      const part = this.part(pl.part);
      if (!g || !part) continue;
      const mat = this.material(part.id, part.color, g.map, part.layer);
      const bent = pl.path.length > 2;
      const geo = bent ? g.geo.clone() : g.geo;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.name = `${pl.part}:${pl.key || pl.mesh}`;
      mesh.userData.partId = pl.part;
      const inst: Instance = { pl, mesh, layer: part.layer, mid: new THREE.Vector3() };
      if (bent) {
        const pos = geo.getAttribute('position') as THREE.BufferAttribute;
        const nor = geo.getAttribute('normal') as THREE.BufferAttribute;
        const n = pos.count;
        inst.base = { x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n), n: new Float32Array(nor.array as Float32Array) };
        for (let i = 0; i < n; i++) {
          inst.base.x[i] = pos.getX(i);
          inst.base.y[i] = pos.getY(i);
          inst.base.z[i] = pos.getZ(i);
        }
        mesh.matrixAutoUpdate = true;
      }
      this.instances.push(inst);
      this.layerGroups.get(part.layer)!.add(mesh);
    }
    // Keystroke slips: thin glowing strands over the flexor (palm side) and extensor (back) bundles, one per finger.
    for (const f of FINGERS)
      for (const kind of ['flex', 'ext'] as const) {
        const color = kind === 'flex' ? '#fff1c9' : '#ffd6a8';
        const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
        const mesh = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 10, 1, false).translate(0, 0.5, 0), mat);
        mesh.matrixAutoUpdate = false;
        mesh.frustumCulled = false;
        mesh.renderOrder = 40;
        this.slips.push({ finger: f, kind, mesh });
        this.layerGroups.get(2)!.add(mesh);
      }
  }

  private material(partId: string, color: string, map: THREE.Texture | null, layer: number): THREE.MeshStandardMaterial {
    const list = this.partMats.get(partId) ?? [];
    const existing = list.find((m) => m.map === map);
    if (existing) return existing;
    const c = new THREE.Color(color);
    // Tint fal's texture with the part colour so each layer reads as one family, whatever colours fal used.
    const tint = new THREE.Color('#ffffff').lerp(c, map ? 0.55 : 1);
    const m = new THREE.MeshStandardMaterial({
      color: tint,
      map: map ?? null,
      roughness: layer === 6 ? 0.55 : layer === 4 ? 0.35 : 0.5,
      metalness: 0,
      emissive: c.clone(),
      emissiveIntensity: 0,
      transparent: true,
      opacity: 1,
    });
    if (map) map.colorSpace = THREE.SRGBColorSpace;
    list.push(m);
    this.partMats.set(partId, list);
    return m;
  }

  /** Anchor -> world point + its frame and limb radius. */
  private anchor(g: ArmGeometry, a: Anchor): { pos: THREE.Vector3; frame: Frame } {
    const base = namedPoint(g, a.p);
    const fname = a.f ?? (a.p.startsWith('hand') || a.p === 'pose.wrist' ? 'hand' : 'upper');
    let frame: Frame;
    let t = 0;
    if (fname === 'upper') frame = g.upper;
    else if (fname === 'hand') frame = g.hand;
    else {
      const m = a.p.match(/elbow>wrist@([\d.]+)/);
      t = m ? Number(m[1]) : a.p === 'pose.wrist' ? 1 : 0;
      frame = blendFrames(g.elbowFrame, g.hand, t, g.elbowFrame.axis);
    }
    const R = limbRadius(fname, t, g.upperLen, g.handLen);
    const pos = base.add(frame.anterior.clone().multiplyScalar((a.a ?? 0) * R)).add(frame.lateral.clone().multiplyScalar((a.l ?? 0) * R));
    return { pos, frame };
  }

  private sideDir(frame: Frame, along: Placement['xAlong'], y: THREE.Vector3): THREE.Vector3 {
    const d = (along === 'anterior' ? frame.anterior : along === 'axis' ? frame.axis : frame.lateral).clone();
    d.sub(y.clone().multiplyScalar(d.dot(y)));
    if (d.lengthSq() < 1e-6) d.copy(frame.anterior).sub(y.clone().multiplyScalar(frame.anterior.dot(y)));
    return d.normalize();
  }

  private sideScale(pl: Placement, L: number, g: ArmGeometry): number {
    const info = this.info[pl.mesh];
    if (!pl.girth || !info) return L;
    return (pl.girth * g.upperLen) / Math.max(1e-3, info.width, info.depth);
  }

  /** Place a mesh rigidly between two anchors. */
  private placeRigid(inst: Instance, g: ArmGeometry) {
    const [A, B] = inst.pl.path.map((a) => this.anchor(g, a));
    const Yv = B.pos.clone().sub(A.pos);
    const L = Math.max(1e-3, Yv.length());
    const Y = Yv.clone().divideScalar(L);
    const X = this.sideDir(A.frame, inst.pl.xAlong, Y);
    const Z = new THREE.Vector3().crossVectors(X, Y).normalize();
    const s = this.sideScale(inst.pl, L, g);
    inst.mesh.matrix.makeBasis(X.multiplyScalar(s), Y.multiplyScalar(L), Z.multiplyScalar(s)).setPosition(A.pos);
    inst.mesh.matrixWorldNeedsUpdate = true;
    inst.mid.copy(A.pos).lerp(B.pos, 0.5);
  }

  /** Bend a mesh along a smooth path through 3+ anchors; `slide` moves it along the path (tendon pulse). */
  private placeBent(inst: Instance, g: ArmGeometry, slide: number) {
    const anchors = inst.pl.path.map((a) => this.anchor(g, a));
    const curve = new THREE.CatmullRomCurve3(anchors.map((a) => a.pos), false, 'centripetal');
    const N = 64;
    const pts = curve.getSpacedPoints(N);
    const total = curve.getLength();
    // frames along the path: tangent + side direction interpolated from the anchors, then orthogonalised
    const tans: THREE.Vector3[] = [];
    const xs: THREE.Vector3[] = [];
    const zs: THREE.Vector3[] = [];
    for (let i = 0; i <= N; i++) {
      const u = i / N;
      const T = curve.getTangentAt(u).normalize();
      const k = u * (anchors.length - 1);
      const i0 = Math.min(anchors.length - 2, Math.floor(k));
      const fa = anchors[i0].frame;
      const fb = anchors[i0 + 1].frame;
      const pick = (f: Frame) => (inst.pl.xAlong === 'anterior' ? f.anterior : f.lateral);
      const X = pick(fa).clone().lerp(pick(fb), k - i0);
      X.sub(T.clone().multiplyScalar(X.dot(T))).normalize();
      tans.push(T);
      xs.push(X);
      zs.push(new THREE.Vector3().crossVectors(X, T).normalize());
    }
    const s = this.sideScale(inst.pl, total, g);
    const b = inst.base!;
    const pos = inst.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const nor = inst.mesh.geometry.getAttribute('normal') as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const narr = nor.array as Float32Array;
    const slideU = slide / total;
    for (let i = 0; i < pos.count; i++) {
      const u = THREE.MathUtils.clamp(b.y[i] - slideU, 0, 1) * N;
      const j = Math.min(N - 1, Math.floor(u));
      const f = u - j;
      const P = pts[j], Q = pts[j + 1];
      const X = xs[j], Z = zs[j], T = tans[j];
      const px = P.x + (Q.x - P.x) * f, py = P.y + (Q.y - P.y) * f, pz = P.z + (Q.z - P.z) * f;
      const x = b.x[i] * s, z = b.z[i] * s;
      arr[i * 3] = px + X.x * x + Z.x * z;
      arr[i * 3 + 1] = py + X.y * x + Z.y * z;
      arr[i * 3 + 2] = pz + X.z * x + Z.z * z;
      const nx = b.n[i * 3], ny = b.n[i * 3 + 1], nz = b.n[i * 3 + 2];
      narr[i * 3] = X.x * nx + T.x * ny + Z.x * nz;
      narr[i * 3 + 1] = X.y * nx + T.y * ny + Z.y * nz;
      narr[i * 3 + 2] = X.z * nx + T.z * ny + Z.z * nz;
    }
    pos.needsUpdate = true;
    nor.needsUpdate = true;
    inst.mesh.geometry.computeBoundingSphere();
    inst.mid.copy(curve.getPointAt(0.45));
  }

  /** Skin sleeve: shoulder -> elbow -> wrist -> hand, radius from the limb sizes. */
  private placeSkin(g: ArmGeometry) {
    const path = [g.p.shoulder, g.p.elbow, g.p.wrist, g.p.hand[9].clone().lerp(g.p.hand[0], 0.1), g.p.hand[12]];
    const curve = new THREE.CatmullRomCurve3(path, false, 'centripetal');
    const radii = (u: number) => {
      // arc-length-ish radius profile: shoulder, mid arm, elbow, mid forearm, wrist, palm, fingertips
      const Lu = g.upperLen;
      const stops: [number, number][] = [[0, 0.2 * Lu], [0.22, 0.17 * Lu], [0.4, 0.14 * Lu], [0.55, 0.13 * Lu], [0.72, 0.085 * Lu], [0.82, 0.1 * Lu], [1, 0.05 * Lu]];
      for (let i = 1; i < stops.length; i++)
        if (u <= stops[i][0]) {
          const [u0, r0] = stops[i - 1];
          const [u1, r1] = stops[i];
          return r0 + ((r1 - r0) * (u - u0)) / (u1 - u0);
        }
      return stops[stops.length - 1][1];
    };
    const pos = this.skin.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    for (let i = 0; i <= this.skinSegs; i++) {
      const u = i / this.skinSegs;
      const P = curve.getPointAt(u);
      const T = curve.getTangentAt(u).normalize();
      const lateral = (u < 0.72 ? g.upper.lateral : g.hand.lateral).clone();
      lateral.sub(T.clone().multiplyScalar(lateral.dot(T))).normalize();
      const ant = new THREE.Vector3().crossVectors(T, lateral).normalize();
      const r = radii(u);
      // the hand is flat: squash front-to-back
      const flat = u > 0.74 ? 0.45 : 1;
      for (let j = 0; j <= this.skinSides; j++) {
        const a = (j / this.skinSides) * Math.PI * 2;
        const k = (i * (this.skinSides + 1) + j) * 3;
        const ox = Math.cos(a) * r;
        const oy = Math.sin(a) * r * flat;
        arr[k] = P.x + lateral.x * ox + ant.x * oy;
        arr[k + 1] = P.y + lateral.y * ox + ant.y * oy;
        arr[k + 2] = P.z + lateral.z * ox + ant.z * oy;
      }
    }
    pos.needsUpdate = true;
    this.skin.geometry.computeVertexNormals();
  }

  private placeSlip(slip: (typeof this.slips)[number], g: ArmGeometry) {
    const sgn = slip.kind === 'flex' ? 1 : -1;
    const l = SPREAD_FOR_SLIPS[slip.finger];
    const A = this.anchor(g, { p: 'pose.elbow>wrist@0.12', f: 'fore', a: 0.85 * sgn, l: l * 0.8 - 0.15 * sgn }).pos;
    const B = this.anchor(g, { p: 'pose.elbow>wrist@0.92', f: 'fore', a: 0.9 * sgn, l: l * 0.7 }).pos;
    const Yv = B.clone().sub(A);
    const L = Yv.length();
    const Y = Yv.clone().normalize();
    const X = new THREE.Vector3(0, 0, 1).cross(Y).normalize();
    if (X.lengthSq() < 1e-6) X.set(1, 0, 0);
    const Z = new THREE.Vector3().crossVectors(X, Y).normalize();
    const r = 0.012 * g.upperLen;
    slip.mesh.matrix.makeBasis(X.multiplyScalar(r), Y.multiplyScalar(L), Z.multiplyScalar(r)).setPosition(A);
    slip.mesh.matrixWorldNeedsUpdate = true;
  }

  update(input: ArmXrayInput): ArmLabel[] {
    if (!input.frozen) {
      const f = this.smoother.push(input.frame);
      const g = f ? armGeometry(f, input.width, input.height, input.side ?? 'right') : null;
      if (g) this.geom = g;
    }
    const g = this.geom;
    this.root.visible = !!g;
    if (!g) return [];

    // ---- keystroke pulses: newest press / lift per finger
    const press = new Map<FingerId, number>();
    const lift = new Map<FingerId, number>();
    for (const k of input.keystrokes) {
      const m = k.kind === 'press' ? press : lift;
      if ((m.get(k.finger) ?? -Infinity) < k.t) m.set(k.finger, k.t);
    }
    const flash = (t: number | undefined, ms: number) => (t === undefined ? 0 : Math.max(0, Math.exp(-Math.max(0, input.now - t) / ms) * (input.now >= t ? 1 : 0)));
    // tendon slide: ~5 mm towards the elbow and back over ~150 ms (5 mm ~ 2% of a ~25 cm forearm)
    const slideOf = (f: FingerId) => {
      const t = press.get(f);
      if (t === undefined) return 0;
      const d = input.now - t;
      if (d < 0 || d > 150) return 0;
      return 0.02 * g.foreLen * Math.sin((Math.PI * d) / 150);
    };

    for (const inst of this.instances) {
      if (inst.base) {
        const slide = inst.pl.part === 'flexor-tendons' && inst.pl.finger ? slideOf(inst.pl.finger) : 0;
        this.placeBent(inst, g, slide);
      } else this.placeRigid(inst, g);
    }
    this.placeSkin(g);
    for (const s of this.slips) this.placeSlip(s, g);

    // ---- explode: outer layers move towards the viewer (and a little up-left so they separate on screen),
    // staggered (outer first) and eased. Bones (layer 6) stay on the real arm.
    const spread = 0.62 * g.upperLen;
    const screenDir = new THREE.Vector3(-0.42, 0.9, 0).normalize();
    for (const l of LAYERS) {
      const start = (l - 1) * 0.07;
      const target = ease(THREE.MathUtils.clamp((input.explode - start) / (1 - 0.35), 0, 1));
      const cur = this.layerEase.get(l)! + (target - this.layerEase.get(l)!) * 0.14;
      this.layerEase.set(l, cur);
      const k = ((6 - l) / 5) * cur;
      this.layerGroups.get(l)!.position.copy(screenDir.clone().multiplyScalar(spread * k)).add(new THREE.Vector3(0, 0, spread * 1.2 * k));
    }

    // ---- focus: that layer full, outer layers ~10%, deeper layers dimmed
    for (const l of LAYERS) {
      const want = input.layerFocus == null ? (l === 1 ? 1 : 1) : l === input.layerFocus ? 1 : l < input.layerFocus ? 0.1 : 0.32;
      this.opacity.set(l, this.opacity.get(l)! + (want - this.opacity.get(l)!) * 0.15);
    }

    // ---- materials: opacity per layer, glow per part, keystroke flashes
    const pulse = 0.85 + 0.15 * Math.sin(input.now * 0.006);
    const flexFlash = Math.max(0, ...FINGERS.map((f) => flash(press.get(f), 160)));
    const extFlash = Math.max(0, ...FINGERS.map((f) => flash(lift.get(f), 160)));
    for (const part of this.td.parts) {
      const mats = this.partMats.get(part.id);
      if (!mats) continue;
      const op = this.opacity.get(part.layer)!;
      let glow = (input.highlight.get(part.id) ?? 0) * 0.75 * pulse;
      if (part.id === 'forearm-flexors') glow += 0.35 * flexFlash;
      if (part.id === 'forearm-extensors') glow += 0.22 * extFlash;
      for (const m of mats) {
        const baseOp = part.id === 'skin' ? 0.32 : 1;
        m.opacity = baseOp * op;
        m.transparent = m.opacity < 0.999 || part.id === 'skin';
        m.depthWrite = m.opacity > 0.5 && part.id !== 'skin';
        m.emissiveIntensity = glow;
      }
    }
    const fl = this.opacity.get(2)!;
    for (const s of this.slips) {
      const f = s.kind === 'flex' ? flash(press.get(s.finger), 140) : 0.6 * flash(lift.get(s.finger), 140);
      (s.mesh.material as THREE.MeshBasicMaterial).opacity = Math.min(1, f) * 0.95 * fl;
      s.mesh.visible = f > 0.01;
    }

    // ---- labels: one per part, on its first instance, plus the layer's explode offset
    const labels: ArmLabel[] = [];
    const seen = new Set<string>();
    const halfW = input.width / 2;
    const halfH = input.height / 2;
    for (const inst of this.instances) {
      if (seen.has(inst.pl.part)) continue;
      seen.add(inst.pl.part);
      const part = this.part(inst.pl.part)!;
      const p = inst.mid.clone().add(this.layerGroups.get(part.layer)!.position);
      labels.push(this.label(part.id, part.name, part.layer, p, halfW, halfH, input));
    }
    const skinPart = this.part('skin');
    if (skinPart) {
      const p = g.p.elbow.clone().lerp(g.p.wrist, 0.35).add(g.upper.lateral.clone().multiplyScalar(0.16 * g.upperLen)).add(this.layerGroups.get(1)!.position);
      labels.push(this.label('skin', skinPart.name, 1, p, halfW, halfH, input));
    }
    return labels;
  }

  private label(id: string, name: string, layer: number, p: THREE.Vector3, halfW: number, halfH: number, input: ArmXrayInput): ArmLabel {
    // approximate projection (the view's perspective camera maps z=0 1:1 to pixels; z>0 grows slightly)
    const persp = this.perspective(p.z);
    const sx = halfW + p.x * persp;
    const sy = halfH - p.y * persp;
    const glow = input.highlight.get(id) ?? 0;
    const visible = (input.layerFocus == null ? input.explode > 0.6 : layer === input.layerFocus) || glow > 0.3;
    const out = id === 'skin' ? 1 : 1;
    return { id, name, layer, at: [sx, sy], label: [sx + 70 * out, sy - 34], visible, glow };
  }

  /** Set by the view so labels match its camera. */
  perspective: (z: number) => number = () => 1;

  dispose() {
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose());
      }
    });
  }
}
