/**
 * Box anchor (every non-hand teardown, including unknown anchors such as 'face' or 'pose'): one
 * placeholder mesh per teardown part, sized and placed from part.size / part.offset (fractions of
 * the object's on-screen box; offset +y is DOWN, flipped here), cross-faded to a GLB when
 * part.mesh_url arrives.
 *
 * Explode (axis 'z', e.g. the MacBook seen from above): every part starts exactly on its region of
 * the frozen frame. Layer by layer (outermost first, ~1 s in all) the parts tilt back like plates
 * on a table seen from the front and slide into a stack: layer 0 on top, deeper layers below, each
 * layer keeping its own arrangement, spread a little so neighbours (display and keyboard deck)
 * separate. The whole stack moves to the screen centre and scales to fit between the label
 * columns. Axis 'y' stacks without the tilt; axis 'x' stacks left to right.
 * Placeholders are soft frosted glass: low-opacity white with a hint of the part colour and a soft
 * white edge. Highlight = accent blue edge and full opacity; the other parts drop to ~30%.
 *
 * Real models (part.mesh_url): loaded through glbCache (shared, preloaded for the demo laptop),
 * centred, turned to the axis-aligned orientation that best matches the part's box, scaled to fill
 * its width and height (as the camera sees it), and cross-faded in over 0.6 s with a soft shadow. Highlight tints
 * the model accent blue and draws the part's box edge in accent blue around it. A missing or
 * broken model keeps its placeholder (and says why in the debug panel).
 *
 * Scene units are viewport pixels, y up, origin at the viewport centre (orthographic camera).
 */
import * as THREE from 'three';
import type { Teardown, TeardownPart } from '../../shared/teardown';
import { devLog } from '../hud/hudStore';
import { ExplodeAnimator, smoothstep } from './explodeAnimator';
import {
  MODEL_ORIENTATIONS,
  PITCH,
  chooseOrientation,
  explodeLayout,
  orientedSize,
  partDims,
  projectedHalfHeight,
} from './explodeLayout';
import { loadGlbTemplate } from './glbCache';
import type { LabelItem, StackBounds } from './labels';

/** The exploded stack may grow up to this much to fill the screen. */
const MAX_GROW = 1.4;
/** Depth between layers once exploded (px): keeps sorting sane for real models. */
const LAYER_Z = 30;
const WHITE = new THREE.Color('#ffffff');
const ACCENT = new THREE.Color('#4DA3FF');
const NEUTRAL = '#9aa4ae';
/** How much of part.color tints the frosted white placeholder. */
const TINT = 0.32;
const BODY_OPACITY = 0.36;
const EDGE_OPACITY = 0.5;
/** Opacity factor for parts that are not highlighted while something is. */
const DIM_TO = 0.3;
/** Real models: cross-fade time, highlight tint, soft shadow strength. */
const GLB_FADE_S = 0.6;
const GLB_HL_TINT = 0.35;
const SHADOW_OPACITY = 0.45;
const MODEL_MAX_DEPTH = 2;
/** Room kept for the label columns left and right of the stack. */
const LABEL_SIDE_MAX_PX = 290;
const LABEL_SIDE_FRAC = 0.2;
const TOP_MARGIN = 70;
/** Bottom-centre space for the voice pill, captions and status pill. */
const BOTTOM_MARGIN = 150;

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
  /** true while collapsing a rig whose teardown is gone: keep the last box, do not fade out. */
  hold?: boolean;
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
  /** Materials cloned for this rig (the only GPU things it owns of a model). */
  glbMats: GlbMat[];
  shadow: THREE.Mesh;
  shadowMat: THREE.MeshBasicMaterial;
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

interface GlbMat {
  mat: THREE.Material;
  /** opacity the model was made with */
  base: number;
  /** the material's own emissive colour object (tinted on highlight) and its original value */
  emissive: THREE.Color | null;
  emissiveBase: THREE.Color | null;
}

let shadowTex: THREE.CanvasTexture | null = null;
/** A soft round shadow (one shared 128 px texture). */
function shadowTexture(): THREE.CanvasTexture | null {
  if (shadowTex) return shadowTex;
  try {
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 128;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
    g.addColorStop(0, 'rgba(0,0,0,0.75)');
    g.addColorStop(0.55, 'rgba(0,0,0,0.35)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    shadowTex = new THREE.CanvasTexture(c);
    return shadowTex;
  } catch {
    return null;
  }
}

export class BoxRig {
  readonly root = new THREE.Group();
  private parts: PartRig[] = [];
  private anim = new ExplodeAnimator();
  private display: ScreenBox | null = null;
  private lostFor = 0;
  private presence = 1;
  private disposed = false;
  private axis: Teardown['explode_axis'];
  private readonly planeGeo = new THREE.PlaneGeometry(1, 1);

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
        geo = new THREE.SphereGeometry(0.5, 24, 16);
        edgeSrc = geo; // smooth: no edge lines (a wire icosahedron reads as sci-fi)
        break;
      }
      default:
        geo = new THREE.BoxGeometry(1, 1, 1);
        edgeSrc = geo;
    }
    const edgeGeo = new THREE.EdgesGeometry(edgeSrc, 25);
    const baseColor = WHITE.clone().lerp(safeColor(part.color), TINT);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: baseColor.clone(),
      emissive: baseColor.clone(),
      emissiveIntensity: 0.12,
      roughness: 0.45,
      metalness: 0,
      envMapIntensity: 0.8,
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
    const shadowMat = new THREE.MeshBasicMaterial({
      map: shadowTexture(),
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const shadow = new THREE.Mesh(this.planeGeo, shadowMat);
    shadow.visible = false;
    tilt.userData.partId = part.id;
    tilt.add(shadow, body, edges, glbHolder);
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
      shadow,
      shadowMat,
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
      loadGlbTemplate(url).then(
        (tpl) => {
          if (this.disposed || rig.loadingUrl !== url) return;
          rig.loadingUrl = null;
          try {
            this.attachGlb(rig, tpl, url);
          } catch (err) {
            // A broken model must never break the exploded view: keep the placeholder.
            console.warn(`[overlay] model for ${rig.part.id} could not be attached, keeping placeholder`, err);
            devLog(`Model for ${rig.part.id} could not be shown: ${err instanceof Error ? err.message : String(err)}`, 'warn');
            rig.failedUrl = url;
            this.clearGlb(rig);
          }
        },
        (err: unknown) => {
          console.warn(`[overlay] model for ${rig.part.id} failed to load, keeping placeholder`, err);
          devLog(`Model for ${rig.part.id} failed to load (${url}): ${err instanceof Error ? err.message : String(err)}`, 'warn');
          if (rig.loadingUrl === url) rig.loadingUrl = null;
          rig.failedUrl = url;
        },
      );
    }
  }

  /** Remove a rig's model. Geometry and textures belong to the shared template: only our materials go. */
  private clearGlb(rig: PartRig): void {
    if (rig.glb) rig.glbHolder.remove(rig.glb);
    for (const gm of rig.glbMats) gm.mat.dispose();
    rig.glb = null;
    rig.glbMats = [];
    rig.glbFade = 0;
    rig.glbUrl = null;
    rig.shadow.visible = false;
  }

  private attachGlb(rig: PartRig, tpl: THREE.Object3D, url: string): void {
    const obj = tpl.clone(true);
    obj.updateMatrixWorld(true);
    const bbox = new THREE.Box3().setFromObject(obj);
    if (bbox.isEmpty()) throw new Error('the model is empty');
    const size = bbox.getSize(new THREE.Vector3());
    const centre = bbox.getCenter(new THREE.Vector3());
    if (![size.x, size.y, size.z, centre.x, centre.y, centre.z].every(Number.isFinite)) throw new Error('the model has no finite size');
    obj.position.sub(centre);
    // Turn it so its box best matches the part's box (e.g. a battery modelled lying flat).
    const B = this.display ?? { cx: 0, cy: 0, w: 600, h: 400 };
    const dims = partDims(rig.part, Math.max(20, B.w), Math.max(20, B.h));
    const modelSize: [number, number, number] = [size.x, size.y, size.z];
    const o = MODEL_ORIENTATIONS[chooseOrientation(modelSize, [dims.w, dims.h, dims.d])];
    const r = orientedSize(modelSize, o);
    const norm = Math.max(r[0], r[1], 1e-6);
    const basis = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(o.cols[0][0], o.cols[0][1], o.cols[0][2]),
      new THREE.Vector3(o.cols[1][0], o.cols[1][1], o.cols[1][2]),
      new THREE.Vector3(o.cols[2][0], o.cols[2][1], o.cols[2][2]),
    );
    const wrapper = new THREE.Group();
    wrapper.add(obj);
    wrapper.quaternion.setFromRotationMatrix(basis);
    wrapper.scale.setScalar(1 / norm);
    // Own materials (the template's stay untouched), faded in from 0.
    const mats: GlbMat[] = [];
    obj.traverse((child: THREE.Object3D) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const src = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const cloned = src.map((m) => {
        const c = m.clone();
        const em = (c as unknown as { emissive?: unknown }).emissive;
        const emissive = em instanceof THREE.Color ? em : null;
        mats.push({ mat: c, base: m.opacity ?? 1, emissive, emissiveBase: emissive ? emissive.clone() : null });
        c.transparent = true;
        c.opacity = 0;
        return c;
      });
      mesh.material = Array.isArray(mesh.material) ? cloned : cloned[0];
      mesh.frustumCulled = false;
    });
    this.clearGlb(rig);
    rig.glb = wrapper;
    rig.glbMats = mats;
    rig.glbNorm.set(r[0] / norm, r[1] / norm, r[2] / norm);
    rig.glbFade = 0;
    rig.glbUrl = url;
    rig.glbHolder.add(wrapper);
    rig.shadow.visible = rig.shadowMat.map !== null;
    devLog(`Model for ${rig.part.id}: ${o.name}`);
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

    // Target box: smooth toward it; hold the last one when lost, fade after 1 s (not while collapsing).
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
      if (!input.hold) this.lostFor += dt;
      if (!this.display) this.display = { cx: vw / 2, cy: vh * 0.47, w: vw * 0.4, h: vw * 0.27 };
    }
    const presTarget = this.lostFor < 1 ? 1 : Math.max(0, 1 - (this.lostFor - 1) / 0.4);
    this.presence += (presTarget - this.presence) * (1 - Math.exp(-dt * 10));
    const p = this.presence;

    const B = this.display;
    const W = Math.max(20, B.w);
    const H = Math.max(20, B.h);
    const tiltFull = this.axis === 'z' ? PITCH : 0;
    const side = Math.min(LABEL_SIDE_MAX_PX, vw * LABEL_SIDE_FRAC);
    const availW = Math.max(100, vw - 2 * side);
    const availH = Math.max(100, vh - TOP_MARGIN - BOTTOM_MARGIN);
    const { poses, extent } = explodeLayout(
      this.parts.map((r) => r.part),
      (layer) => this.anim.rankOf(layer),
      this.anim.layerCount,
      this.axis,
      W,
      H,
      availW / availH,
    );
    const anyHl = input.highlighted.size > 0;
    const kHl = 1 - Math.exp(-dt * 10);
    const maxE = Math.min(1, this.anim.max());

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    this.parts.forEach((rig, i) => {
      const part = rig.part;
      const pose = poses[i];
      const e = this.anim.get(part.layer);
      const t = Math.min(1, e);
      const { w, h, d } = pose;
      rig.body.scale.set(w, h, d);
      rig.edges.scale.copy(rig.body.scale);

      const x = pose.ax + (pose.ex - pose.ax) * e;
      const y = pose.ay + (pose.ey - pose.ay) * e;
      const z = -this.anim.rankOf(part.layer) * LAYER_Z * t + rig.index * 0.5;
      rig.pivot.position.set(x, y, z);
      const tilt = tiltFull * t;
      rig.tilt.rotation.set(-tilt, 0, 0); // negative: the top edge goes away, the front edge shows
      rig.hw = w / 2;
      rig.hh = projectedHalfHeight(h, d, tilt, pose.round);
      minX = Math.min(minX, x - rig.hw);
      maxX = Math.max(maxX, x + rig.hw);
      minY = Math.min(minY, y - rig.hh);
      maxY = Math.max(maxY, y + rig.hh);

      const isHl = input.highlighted.has(part.id);
      rig.hl += ((isHl ? 1 : 0) - rig.hl) * kHl;
      rig.dim += ((anyHl && !isHl ? 1 : 0) - rig.dim) * kHl;
      const appear = smoothstep(0.02, 0.25, e);
      rig.vis = p * appear;
      const dimF = 1 - (1 - DIM_TO) * rig.dim;
      if (rig.glb) rig.glbFade = Math.min(1, rig.glbFade + dt / GLB_FADE_S);
      const gf = rig.glbFade;

      // Frosted glass; highlighted = (nearly) full opacity with an accent-blue edge. No pulsing.
      // With a real model the glass fades out and the edge stays only as the highlight outline.
      rig.bodyMat.opacity = rig.vis * (BODY_OPACITY + (0.92 - BODY_OPACITY) * rig.hl) * dimF * (1 - gf);
      rig.bodyMat.emissive.copy(rig.baseColor).lerp(ACCENT, 0.45 * rig.hl);
      rig.bodyMat.emissiveIntensity = 0.12 + 0.3 * rig.hl;
      rig.edgeMat.color.copy(WHITE).lerp(ACCENT, rig.hl);
      rig.edgeMat.opacity = rig.vis * dimF * ((1 - gf) * (EDGE_OPACITY + (1 - EDGE_OPACITY) * rig.hl) + gf * rig.hl);
      rig.tilt.scale.setScalar(1 + 0.03 * rig.hl);
      rig.tilt.visible = rig.vis > 0.004;

      if (rig.glb) {
        // Fill the part's box like the placeholder does: the box is the part as the camera sees it
        // (foreshortened), so all full-width parts line up. Depth follows the smaller scale, but a
        // model is never more than MODEL_MAX_DEPTH x as thick as its placeholder (no spill into
        // the next layer when a generated "hinge" is really a plate).
        const sx = w / Math.max(1e-6, rig.glbNorm.x);
        const sy = h / Math.max(1e-6, rig.glbNorm.y);
        const sz = Math.min(sx, sy, (MODEL_MAX_DEPTH * d) / Math.max(1e-6, rig.glbNorm.z));
        rig.glbHolder.scale.set(sx, sy, sz);
        for (const gm of rig.glbMats) {
          gm.mat.opacity = gm.base * rig.vis * gf * dimF;
          if (gm.emissive && gm.emissiveBase) gm.emissive.copy(gm.emissiveBase).lerp(ACCENT, GLB_HL_TINT * rig.hl);
        }
        // Soft shadow just behind the model, slightly low, so it lifts off the dimmed frame.
        rig.shadow.position.set(0, -0.06 * h, -MODEL_MAX_DEPTH * d / 2 - 2);
        rig.shadow.scale.set(w * 1.15, h * 1.25, 1);
        rig.shadowMat.opacity = SHADOW_OPACITY * rig.vis * gf * dimF;
      }

      const order = 10 + (this.anim.layerCount - this.anim.rankOf(part.layer)) * 4;
      rig.shadow.renderOrder = order - 1;
      rig.body.renderOrder = order;
      rig.edges.renderOrder = order + 1;
      if (rig.glb) rig.glb.traverse((o: THREE.Object3D) => {
          o.renderOrder = order + 2;
        });
    });
    if (!Number.isFinite(minX)) {
      minX = -W / 2;
      maxX = W / 2;
      minY = -H / 2;
      maxY = H / 2;
    }

    // Root: on the object when assembled; exploded, centred between the label columns and scaled
    // so the whole stack fits between the title (top) and the voice area (bottom).
    const rx = B.cx - vw / 2;
    const ry = vh / 2 - B.cy;
    const bw = Math.max(1, extent.maxX - extent.minX);
    const bh = Math.max(1, extent.maxY - extent.minY);
    const fit = Math.max(0.25, Math.min(MAX_GROW, availW / bw, availH / bh));
    const goalX = 0 - fit * ((extent.minX + extent.maxX) / 2);
    const goalY = vh / 2 - TOP_MARGIN - availH / 2 - fit * ((extent.minY + extent.maxY) / 2);
    const s = 1 + (fit - 1) * maxE;
    this.root.position.set(rx + (goalX - rx) * maxE, ry + (goalY - ry) * maxE, 0);
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
      rig.shadowMat.dispose();
      this.clearGlb(rig);
    }
    this.planeGeo.dispose();
    this.parts = [];
  }
}
