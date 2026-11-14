/**
 * Box anchor (every non-hand teardown, including unknown anchors such as 'face' or 'pose'): one
 * placeholder mesh per teardown part, sized and placed from part.size / part.offset (fractions of
 * the object's on-screen box; offset +y is DOWN, flipped here), exploded along the teardown axis in
 * layer order, tilted so depth reads, cross-faded to a GLB when part.mesh_url arrives.
 * Placeholders are soft frosted glass: low-opacity white with a hint of the part colour and a soft
 * white edge. Highlight = accent blue edge and full opacity; the other parts drop to ~30%.
 *
 * Scene units are viewport pixels, y up, origin at the viewport centre (orthographic camera).
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Teardown, TeardownPart } from '../../shared/teardown';
import { ExplodeAnimator, smoothstep } from './explodeAnimator';
import type { LabelItem, StackBounds } from './labels';

const PITCH = THREE.MathUtils.degToRad(25);
const YAW = THREE.MathUtils.degToRad(-14);
const WHITE = new THREE.Color('#ffffff');
const ACCENT = new THREE.Color('#4DA3FF');
const NEUTRAL = '#9aa4ae';
/** How much of part.color tints the frosted white placeholder. */
const TINT = 0.32;
const BODY_OPACITY = 0.36;
const EDGE_OPACITY = 0.5;
/** Opacity factor for parts that are not highlighted while something is. */
const DIM_TO = 0.3;
const SPREAD_X_W = 1.2; // total spread = 1.2 x object width
const LABEL_SIDE_PX = 230; // room kept for labels left and right
const TOP_MARGIN = 70;
const BOTTOM_MARGIN = 140;

export interface ScreenBox {
  cx: number;
  cy: number;
  w: number;
  h: number;
}

export interface BoxFrameInput {
  now: number;
  dt: number;
  vw: number;
  vh: number;
  /** target object box in viewport px, or null if the object is not visible */
  box: ScreenBox | null;
  explodeTarget: number;
  highlighted: Set<string>;
}

interface PartRig {
  part: TeardownPart;
  index: number;
  pivot: THREE.Group;
  tilt: THREE.Group;
  body: THREE.Mesh;
  edges: THREE.LineSegments;
  bodyMat: THREE.MeshStandardMaterial;
  edgeMat: THREE.LineBasicMaterial;
  baseColor: THREE.Color;
  horizontalAxis: boolean;
  glbHolder: THREE.Group;
  glb: THREE.Object3D | null;
  glbMats: { mat: THREE.Material; base: number }[];
  glbNorm: THREE.Vector3;
  glbFade: number;
  glbUrl: string | null;
  loadingUrl: string | null;
  failedUrl: string | null;
  hl: number;
  dim: number;
  vis: number;
  /** current px half extents (for fitting / labels) */
  hw: number;
  hh: number;
}

function safeColor(css: string): THREE.Color {
  const c = new THREE.Color(NEUTRAL);
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(css.trim())) c.set(css.trim());
  return c;
}

function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((o: THREE.Object3D) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.geometry?.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        if (!m) continue;
        for (const v of Object.values(m as unknown as Record<string, unknown>)) {
          if (v instanceof THREE.Texture) v.dispose();
        }
        m.dispose();
      }
    }
  });
}

const loader = new GLTFLoader();

export class BoxRig {
  readonly root = new THREE.Group();
  private parts: PartRig[] = [];
  private anim = new ExplodeAnimator();
  private display: ScreenBox | null = null;
  private lostFor = 0;
  private presence = 1;
  private disposed = false;
  private axis: Teardown['explode_axis'];
  private sharedGeos: THREE.BufferGeometry[] = [];

  constructor(td: Teardown, scene: THREE.Scene) {
    this.axis = td.explode_axis;
    this.anim.setLayers(td.parts.map((p) => p.layer));
    td.parts.forEach((part, index) => this.parts.push(this.buildPart(part, index)));
    scene.add(this.root);
  }

  private buildPart(part: TeardownPart, index: number): PartRig {
    const horizontalAxis = part.size[0] >= part.size[1] * 0.7;
    let geo: THREE.BufferGeometry;
    let edgeSrc: THREE.BufferGeometry;
    switch (part.shape) {
      case 'cylinder':
      case 'tube': {
        geo = new THREE.CylinderGeometry(0.5, 0.5, 1, part.shape === 'tube' ? 12 : 24);
        if (horizontalAxis) geo.rotateZ(Math.PI / 2);
        edgeSrc = geo;
        break;
      }
      case 'sphere': {
        geo = new THREE.SphereGeometry(0.5, 20, 14);
        edgeSrc = new THREE.IcosahedronGeometry(0.5, 1);
        this.sharedGeos.push(edgeSrc);
        break;
      }
      default:
        geo = new THREE.BoxGeometry(1, 1, 1);
        edgeSrc = geo;
    }
    const edgeGeo = new THREE.EdgesGeometry(edgeSrc, part.shape === 'sphere' ? 1 : 25);
    const baseColor = WHITE.clone().lerp(safeColor(part.color), TINT);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: baseColor.clone(),
      emissive: baseColor.clone(),
      emissiveIntensity: 0.12,
      roughness: 0.45,
      metalness: 0,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.FrontSide,
    });
    const edgeMat = new THREE.LineBasicMaterial({ color: WHITE.clone(), transparent: true, opacity: 0, depthWrite: false });
    const body = new THREE.Mesh(geo, bodyMat);
    const edges = new THREE.LineSegments(edgeGeo, edgeMat);
    const pivot = new THREE.Group();
    const tilt = new THREE.Group();
    const glbHolder = new THREE.Group();
    tilt.userData.partId = part.id;
    tilt.add(body, edges, glbHolder);
    pivot.add(tilt);
    this.root.add(pivot);
    return {
      part,
      index,
      pivot,
      tilt,
      body,
      edges,
      bodyMat,
      edgeMat,
      baseColor,
      horizontalAxis,
      glbHolder,
      glb: null,
      glbMats: [],
      glbNorm: new THREE.Vector3(1, 1, 1),
      glbFade: 0,
      glbUrl: null,
      loadingUrl: null,
      failedUrl: null,
      hl: 0,
      dim: 0,
      vis: 0,
      hw: 0,
      hh: 0,
    };
  }

  /** Call when the teardown object changes but its parts are the same (mesh_url arrived). */
  syncMeshes(td: Teardown): void {
    for (const rig of this.parts) {
      const url = td.parts.find((p) => p.id === rig.part.id)?.mesh_url ?? null;
      if (!url || url === rig.glbUrl || url === rig.loadingUrl || url === rig.failedUrl) continue;
      rig.loadingUrl = url;
      loader.load(
        url,
        (gltf) => {
          if (this.disposed || rig.loadingUrl !== url) {
            disposeObject(gltf.scene);
            return;
          }
          rig.loadingUrl = null;
          try {
            this.attachGlb(rig, gltf.scene, url);
          } catch (err) {
            // A broken model must never break the exploded view: keep the placeholder.
            console.warn(`[overlay] GLB for ${rig.part.id} could not be attached, keeping placeholder`, err);
            rig.failedUrl = url;
            rig.glb = null;
            rig.glbMats = [];
            rig.glbFade = 0;
            rig.glbHolder.clear();
            disposeObject(gltf.scene);
          }
        },
        undefined,
        (err) => {
          console.warn(`[overlay] GLB for ${rig.part.id} failed, keeping placeholder`, err);
          if (rig.loadingUrl === url) rig.loadingUrl = null;
          rig.failedUrl = url;
        },
      );
    }
  }

  private attachGlb(rig: PartRig, obj: THREE.Object3D, url: string): void {
    const bbox = new THREE.Box3().setFromObject(obj);
    if (bbox.isEmpty()) {
      rig.failedUrl = url;
      disposeObject(obj);
      return;
    }
    const size = bbox.getSize(new THREE.Vector3());
    const centre = bbox.getCenter(new THREE.Vector3());
    const norm = Math.max(size.x, size.y, 1e-6);
    obj.position.sub(centre);
    const wrapper = new THREE.Group();
    wrapper.add(obj);
    wrapper.scale.setScalar(1 / norm);
    const mats: { mat: THREE.Material; base: number }[] = [];
    obj.traverse((o: THREE.Object3D) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const src = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const cloned = src.map((m) => {
        const c = m.clone();
        c.transparent = true;
        mats.push({ mat: c, base: m.opacity ?? 1 });
        c.opacity = 0;
        return c;
      });
      mesh.material = Array.isArray(mesh.material) ? cloned : cloned[0];
      mesh.frustumCulled = false;
      for (const m of src) m.dispose();
    });
    if (rig.glb) {
      rig.glbHolder.remove(rig.glb);
      disposeObject(rig.glb);
    }
    rig.glb = wrapper;
    rig.glbMats = mats;
    rig.glbNorm.set(size.x / norm, size.y / norm, size.z / norm);
    rig.glbFade = 0;
    rig.glbUrl = url;
    rig.glbHolder.add(wrapper);
  }

  /** Tilt groups for raycasting (userData.partId). */
  pickables(): THREE.Object3D[] {
    return this.parts.filter((p) => p.vis > 0.3).map((p) => p.tilt);
  }

  explodeLevel(): number {
    return this.anim.max();
  }

  update(input: BoxFrameInput): { labels: LabelItem[]; bounds: StackBounds } {
    const { now, dt, vw, vh } = input;
    this.anim.update(now, dt, input.explodeTarget);

    // Target box: smooth toward it; hold the last one when lost, fade after 1 s.
    if (input.box) {
      this.lostFor = 0;
      if (!this.display) this.display = { ...input.box };
      else {
        const k = 1 - Math.exp(-dt * 12);
        this.display.cx += (input.box.cx - this.display.cx) * k;
        this.display.cy += (input.box.cy - this.display.cy) * k;
        this.display.w += (input.box.w - this.display.w) * k;
        this.display.h += (input.box.h - this.display.h) * k;
      }
    } else {
      this.lostFor += dt;
      if (!this.display) this.display = { cx: vw / 2, cy: vh * 0.47, w: vw * 0.4, h: vw * 0.27 };
    }
    const presTarget = this.lostFor < 1 ? 1 : Math.max(0, 1 - (this.lostFor - 1) / 0.4);
    this.presence += (presTarget - this.presence) * (1 - Math.exp(-dt * 10));
    const p = this.presence;

    const B = this.display;
    const W = Math.max(20, B.w);
    const H = Math.max(20, B.h);
    let dir = new THREE.Vector2(0.3, 1);
    if (this.axis === 'y') dir = new THREE.Vector2(0, 1);
    if (this.axis === 'x') dir = new THREE.Vector2(1, 0.15);
    dir.normalize();
    const spread = SPREAD_X_W * W;
    const anyHl = input.highlighted.size > 0;
    const kHl = 1 - Math.exp(-dt * 10);
    const maxE = this.anim.max();

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const rig of this.parts) {
      const part = rig.part;
      const e = this.anim.get(part.layer);
      const t = this.anim.outerness(part.layer);
      const w = Math.max(2, part.size[0] * W);
      const h = Math.max(2, part.size[1] * H);
      let d: number;
      if (part.shape === 'board') d = Math.max(2, Math.min(part.size[2] * W, 0.035 * W));
      else if (part.shape === 'box') d = Math.max(4, part.size[2] * W);
      else d = Math.min(w, h);
      // Cylinder/tube: the circular cross-section uses the short side.
      if ((part.shape === 'cylinder' || part.shape === 'tube') && rig.horizontalAxis) rig.body.scale.set(w, h, Math.min(h, d));
      else if (part.shape === 'cylinder' || part.shape === 'tube') rig.body.scale.set(w, h, Math.min(w, d));
      else rig.body.scale.set(w, h, d);
      rig.edges.scale.copy(rig.body.scale);

      const along = (t - 0.4) * spread * e;
      const x = part.offset[0] * W + dir.x * along;
      const y = -part.offset[1] * H + dir.y * along; // offset +y is down in image convention
      const z = e * t * 300 + rig.index * 0.5;
      rig.pivot.position.set(x, y, z);
      rig.tilt.rotation.set(PITCH * e, YAW * e, 0);
      rig.hw = w / 2;
      rig.hh = h / 2;
      minX = Math.min(minX, x - w / 2);
      maxX = Math.max(maxX, x + w / 2);
      minY = Math.min(minY, y - h / 2);
      maxY = Math.max(maxY, y + h / 2);

      const isHl = input.highlighted.has(part.id);
      rig.hl += ((isHl ? 1 : 0) - rig.hl) * kHl;
      rig.dim += ((anyHl && !isHl ? 1 : 0) - rig.dim) * kHl;
      const appear = smoothstep(0.03, 0.3, e);
      rig.vis = p * appear;
      const dimF = 1 - (1 - DIM_TO) * rig.dim;
      if (rig.glb) rig.glbFade = Math.min(1, rig.glbFade + dt / 0.6);

      // Frosted glass; highlighted = (nearly) full opacity with an accent-blue edge. No pulsing.
      rig.bodyMat.opacity = rig.vis * (BODY_OPACITY + (0.92 - BODY_OPACITY) * rig.hl) * dimF * (1 - 0.85 * rig.glbFade);
      rig.bodyMat.emissive.copy(rig.baseColor).lerp(ACCENT, 0.45 * rig.hl);
      rig.bodyMat.emissiveIntensity = 0.12 + 0.3 * rig.hl;
      rig.edgeMat.color.copy(WHITE).lerp(ACCENT, rig.hl);
      rig.edgeMat.opacity = rig.vis * (EDGE_OPACITY + (1 - EDGE_OPACITY) * rig.hl) * dimF * (1 - 0.6 * rig.glbFade);
      rig.tilt.scale.setScalar(1 + 0.03 * rig.hl);
      rig.tilt.visible = rig.vis > 0.004;

      if (rig.glb) {
        const fit = Math.min(w / Math.max(1e-6, rig.glbNorm.x), h / Math.max(1e-6, rig.glbNorm.y));
        rig.glbHolder.scale.setScalar(fit);
        for (const gm of rig.glbMats) gm.mat.opacity = gm.base * rig.vis * rig.glbFade * dimF;
      }

      const order = 10 + (this.anim.layerCount - this.anim.rankOf(part.layer)) * 4;
      rig.body.renderOrder = order;
      rig.edges.renderOrder = order + 1;
      if (rig.glb) rig.glb.traverse((o: THREE.Object3D) => {
          o.renderOrder = order + 2;
        });
    }
    if (!Number.isFinite(minX)) {
      minX = -W / 2;
      maxX = W / 2;
      minY = -H / 2;
      maxY = H / 2;
    }

    // Place the root on the object; when exploded, shrink and shift so the stack fits the view.
    const rx = B.cx - vw / 2;
    const ry = vh / 2 - B.cy;
    const availW = Math.max(100, vw - 2 * LABEL_SIDE_PX);
    const availH = Math.max(100, vh - TOP_MARGIN - BOTTOM_MARGIN);
    const fitScale = Math.min(1, availW / Math.max(1, maxX - minX), availH / Math.max(1, maxY - minY));
    const s = 1 + (fitScale - 1) * Math.min(1, maxE);
    let sx = 0;
    let sy = 0;
    const left = rx + s * minX;
    const right = rx + s * maxX;
    const bottom = ry + s * minY;
    const top = ry + s * maxY;
    const limL = -vw / 2 + LABEL_SIDE_PX;
    const limR = vw / 2 - LABEL_SIDE_PX;
    const limT = vh / 2 - TOP_MARGIN;
    const limB = -vh / 2 + BOTTOM_MARGIN;
    if (right - left <= limR - limL) {
      if (left < limL) sx = limL - left;
      else if (right > limR) sx = limR - right;
    } else sx = (limL + limR) / 2 - (left + right) / 2;
    if (top - bottom <= limT - limB) {
      if (top > limT) sy = limT - top;
      else if (bottom < limB) sy = limB - bottom;
    } else sy = (limT + limB) / 2 - (top + bottom) / 2;
    const em = Math.min(1, maxE);
    this.root.position.set(rx + sx * em, ry + sy * em, 0);
    this.root.scale.setScalar(s);
    this.root.updateMatrixWorld(true);

    // Labels: part centres in viewport px.
    const labels: LabelItem[] = [];
    const v = new THREE.Vector3();
    for (const rig of this.parts) {
      const e = this.anim.get(rig.part.layer);
      rig.pivot.getWorldPosition(v);
      labels.push({
        id: rig.part.id,
        text: rig.part.name,
        ax: v.x + vw / 2,
        ay: vh / 2 - v.y,
        opacity: p * smoothstep(0.35, 0.8, e) * (rig.dim > 0.5 ? 0.55 : 1),
        highlighted: rig.hl > 0.5,
      });
    }
    const px = this.root.position.x;
    const py = this.root.position.y;
    const bounds: StackBounds = {
      left: px + s * minX + vw / 2,
      right: px + s * maxX + vw / 2,
      top: vh / 2 - (py + s * maxY),
      bottom: vh / 2 - (py + s * minY),
    };
    return { labels, bounds };
  }

  dispose(): void {
    this.disposed = true;
    this.root.removeFromParent();
    for (const rig of this.parts) {
      rig.body.geometry.dispose();
      rig.edges.geometry.dispose();
      rig.bodyMat.dispose();
      rig.edgeMat.dispose();
      if (rig.glb) disposeObject(rig.glb);
    }
    for (const g of this.sharedGeos) g.dispose();
    this.parts = [];
  }
}
