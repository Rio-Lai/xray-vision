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
 * its width and height (as the camera sees it; `?fit=even`: one factor, fitted inside, never stretched),
 * and cross-faded in over 0.6 s with a soft shadow. Highlight tints
 * the model accent blue and draws the part's box edge in accent blue around it. A missing or
 * broken model keeps its placeholder (and says why in the debug panel).
 *
 * Stage mode (trackingMode 'stage', the default): the same parts form a real 3D model that lifts
 * out of the object's box (liftOut.ts, #109: an accent outline draws round the box, the model
 * appears exactly over the real object, seen from above as the camera sees it, fully opaque, then
 * rises, tilts to a three-quarter view and grows to the middle of the view on one ease-out curve in
 * ~1 s, its parts separating only as it arrives; a model already loaded is there from the start, a
 * late one cross-fades in place; #125: until it appears, everything it will show is drawn each frame
 * invisibly, and it appears only after one such frame with all its models, so the first frame it is
 * seen on never compiles shaders or uploads textures), where it turns with store.modelYaw /
 * modelPitch (critically damped springs; a very slow idle drift is added by the caller) and is drawn
 * store.modelZoom times its stage size (eased by the same kind of spring, about its middle). Explode
 * lifts the layers apart along the object's own up axis (see stageLayout.ts): at ~0.12 the parts
 * are just apart, at 1 they are spread out with labels. One soft ground shadow sits under it.
 * "Put it away" closes it and glides it back into the object (or its saved pill) in ~0.6 s, fading at the end.
 * Its proportions are the object's own (#120: teardown.dimensions_mm, else the box's clamped; see
 * stageLayout.ts): it appears with the box's proportion and morphs to its own on the lift's curve.
 * meshOnly (a hand on stage): only parts with a real model are drawn and labelled; the others have
 * no good placeholder shape (a tendon is not a box) and stay visible on the live hand overlay.
 *
 * Scene units are viewport pixels, y up, origin at the viewport centre (orthographic camera).
 */
import * as THREE from 'three';
import type { Teardown, TeardownPart } from '../../shared/teardown';
import { FIT_EVEN } from '../camera/frame';
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
import { loadGlbTemplate, rigMaterial } from './glbCache';
import { Lift } from './liftOut';
import { STAGE_MIN_EXPLODE, panPx } from '../stage/modelControl';
import { STAGE_ELEVATION, nearestTurn, springStep, stageAspect, stageDepthScale, stageFit, stageLayout, stageStack } from './stageLayout';
import type { StageLayout } from './stageLayout';
import { inView } from './labels';
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
export const LABEL_SIDE_MAX_PX = 290;
export const LABEL_SIDE_FRAC = 0.2;
export const TOP_MARGIN = 70;
/** Bottom-centre space for the voice pill, captions and status pill. */
export const BOTTOM_MARGIN = 150;
/** Stage: the assembled model's widest extent (any yaw), as a fraction of the view height. */
export const STAGE_SIZE = 0.56;
/** Stage: model units across the object's box (its depth: stageAspect, the object's real proportion). */
const STAGE_UNITS = 600;
/** Stage: the lift waits at most this long for the models still loading (s); the rest cross-fade in place. */
const STAGE_MODEL_WAIT_S = 0.6;
/** Stage springs (rad/s): turning and zooming (store.modelYaw / modelPitch / modelZoom). */
export const STAGE_TURN_OMEGA = 12;
const STAGE_SHADOW_OPACITY = 0.5;

export interface ScreenBox {
  cx: number;
  cy: number;
  w: number;
  h: number;
}

export interface BoxRigOptions {
  /** draw (and label) only the parts that have a real model; no glass placeholders */
  meshOnly?: boolean;
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
  /** Stage mode: draw the model in the middle of the view (box = the object it lifts out of). */
  stage?: StageFrame | null;
}

export interface StageFrame {
  /** target orientation (radians): store.modelYaw / modelPitch plus any idle drift */
  yaw: number;
  pitch: number;
  /** "put it away": glide back into the object (or shrink in place) and fade */
  putAway: boolean;
  /** store.modelZoom: 1 = the normal stage size (ignored while put away) */
  zoom: number;
  /** store.modelPanX / modelPanY: offset from the middle of the view in stage sizes (ignored while put away, #121) */
  panX?: number;
  panY?: number;
  /**
   * Where it lifts out of instead of the object's box, read when the lift starts (a saved model
   * brought back while its object is not in view: its pill). The box still gives its shape.
   */
  startBox?: ScreenBox | null;
}

interface StageState {
  layout: StageLayout;
  /** the lift-out / put-away timeline (liftOut.ts) */
  lift: Lift;
  /** time spent waiting for models before the lift (s) */
  waited: number;
  /** BoxRig.attachSerial when the last invisible frame was drawn (#125): all of them were drawn by then */
  drawnSerial: number;
  /** it lifts out of a saved pill: the start point does not follow the object */
  fromPill: boolean;
  /** the turn it starts with on the object (a whole number of turns: as the camera sees it) */
  yaw0: number;
  yaw: number;
  yawV: number;
  pitch: number;
  pitchV: number;
  zoom: number;
  zoomV: number;
  /** pan (stage sizes), eased like the turn and the zoom */
  panX: number;
  panXV: number;
  panY: number;
  panYV: number;
  /** where the model lifts out of / returns to (viewport px): the object's latest box */
  from: ScreenBox;
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
  /** the material's own depth write (off while it is drawn invisibly) */
  depthWrite: boolean;
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
  /** Stage only (identity otherwise): the view tilt (x) and the turn about the object's up axis (z). */
  private readonly tiltG = new THREE.Group();
  private readonly spinG = new THREE.Group();
  private stage: StageState | null = null;
  private stageActive = false;
  private groundShadow: THREE.Mesh | null = null;
  private groundMat: THREE.MeshBasicMaterial | null = null;
  private parts: PartRig[] = [];
  private anim = new ExplodeAnimator();
  private display: ScreenBox | null = null;
  private lostFor = 0;
  private presence = 1;
  private disposed = false;
  /** counts models attached (#125), and whether this frame draws the unshown model invisibly */
  private attachSerial = 0;
  private priming = false;
  /** reused by outline() */
  private readonly outlineOut = { box: { cx: 0, cy: 0, w: 0, h: 0 }, drawn: 0, opacity: 0 };
  private axis: Teardown['explode_axis'];
  /** the object's real [width, depth, height] in mm (stage proportions), if the parts list has it */
  private readonly dims: readonly [number, number, number] | null;
  private readonly meshOnly: boolean;
  private readonly planeGeo = new THREE.PlaneGeometry(1, 1);

  constructor(td: Teardown, scene: THREE.Scene, opts: BoxRigOptions = {}) {
    this.axis = td.explode_axis;
    this.dims = td.dimensions_mm ?? null;
    this.meshOnly = opts.meshOnly === true;
    this.anim.setLayers(td.parts.map((p) => p.layer));
    this.root.add(this.tiltG);
    this.tiltG.add(this.spinG);
    td.parts.forEach((part, index) => this.parts.push(this.buildPart(part, index)));
    const tex = shadowTexture();
    if (tex) {
      this.groundMat = new THREE.MeshBasicMaterial({ map: tex, color: 0xffffff, transparent: true, opacity: 0, depthWrite: false });
      this.groundShadow = new THREE.Mesh(this.planeGeo, this.groundMat);
      this.groundShadow.renderOrder = 1;
      this.groundShadow.visible = false;
      this.spinG.add(this.groundShadow);
    }
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
    this.spinG.add(pivot);
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
    const B = this.stageActive && this.stage ? { w: this.stage.layout.W, h: this.stage.layout.H } : this.display ?? { w: 600, h: 400 };
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
        const c = rigMaterial(m); // as the warm-up compiled it (glbCache.ts)
        const em = (c as unknown as { emissive?: unknown }).emissive;
        const emissive = em instanceof THREE.Color ? em : null;
        mats.push({ mat: c, base: m.opacity ?? 1, emissive, emissiveBase: emissive ? emissive.clone() : null, depthWrite: c.depthWrite });
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
    this.attachSerial += 1;
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
    if (input.stage) return this.updateStage(input, input.stage);
    return this.updateScreen(input);
  }

  /** Stage: true once "put it away" has finished (the caller disposes the rig). */
  stageDone(): boolean {
    return !!this.stage && this.stage.lift.done;
  }

  /** Stage: the object's outline to draw this frame (viewport px; reused object), or null. */
  outline(): { box: ScreenBox; drawn: number; opacity: number } | null {
    const st = this.stage;
    if (!st || !this.stageActive || st.lift.outlineOpacity < 0.01) return null;
    const o = this.outlineOut;
    o.box.cx = st.from.cx;
    o.box.cy = st.from.cy;
    o.box.w = st.from.w;
    o.box.h = st.from.h;
    o.drawn = st.lift.outlineDrawn;
    o.opacity = st.lift.outlineOpacity;
    return o;
  }

  /** Stage: up in the middle of the view (the HUD shows the title then). */
  arrived(): boolean {
    return !!this.stage && this.stageActive && this.stage.lift.arrived;
  }

  /**
   * Materials, highlight, model fit and draw order of one part (both modes).
   * `partShadow`: the per-model soft shadow (screen modes); stage mode has one ground shadow instead.
   */
  private stylePart(
    rig: PartRig,
    vis: number,
    w: number,
    h: number,
    d: number,
    order: number,
    dt: number,
    anyHl: boolean,
    isHl: boolean,
    kHl: number,
    partShadow: boolean,
  ): void {
    rig.hl += ((isHl ? 1 : 0) - rig.hl) * kHl;
    rig.dim += ((anyHl && !isHl ? 1 : 0) - rig.dim) * kHl;
    rig.vis = this.meshOnly && !rig.glb ? 0 : vis;
    const dimF = 1 - (1 - DIM_TO) * rig.dim;
    if (rig.glb) rig.glbFade = Math.min(1, rig.glbFade + dt / GLB_FADE_S);
    const gf = rig.glbFade;
    const glass = this.meshOnly ? 0 : 1 - gf;

    // Frosted glass; highlighted = (nearly) full opacity with an accent-blue edge. No pulsing.
    // With a real model the glass fades out and the edge stays only as the highlight outline.
    rig.bodyMat.opacity = rig.vis * (BODY_OPACITY + (0.92 - BODY_OPACITY) * rig.hl) * dimF * glass;
    rig.bodyMat.emissive.copy(rig.baseColor).lerp(ACCENT, 0.45 * rig.hl);
    rig.bodyMat.emissiveIntensity = 0.12 + 0.3 * rig.hl;
    rig.edgeMat.color.copy(WHITE).lerp(ACCENT, rig.hl);
    rig.edgeMat.opacity = rig.vis * dimF * (glass * (EDGE_OPACITY + (1 - EDGE_OPACITY) * rig.hl) + gf * rig.hl);
    rig.tilt.scale.setScalar(1 + 0.03 * rig.hl);
    // Not shown yet: drawn anyway (at opacity 0, no depth), so it is compiled and uploaded before it shows.
    rig.tilt.visible = rig.vis > 0.004 || (this.priming && !(this.meshOnly && !rig.glb));

    if (rig.glb) {
      // Fill the part's box like the placeholder does: the box is the part as the camera sees it
      // (foreshortened), so all full-width parts line up. Depth follows the smaller scale, but a
      // model is never more than MODEL_MAX_DEPTH x as thick as its placeholder (no spill into
      // the next layer when a generated "hinge" is really a plate).
      // ?fit=even (#98): one factor, the largest that keeps the model inside that same envelope
      // (width, height, MODEL_MAX_DEPTH x depth); centred because the model is centred on its box.
      const sx = w / Math.max(1e-6, rig.glbNorm.x);
      const sy = h / Math.max(1e-6, rig.glbNorm.y);
      const sz = Math.min(sx, sy, (MODEL_MAX_DEPTH * d) / Math.max(1e-6, rig.glbNorm.z));
      if (FIT_EVEN) rig.glbHolder.scale.setScalar(sz);
      else rig.glbHolder.scale.set(sx, sy, sz);
      for (const gm of rig.glbMats) {
        gm.mat.opacity = gm.base * rig.vis * gf * dimF;
        gm.mat.colorWrite = !this.priming;
        gm.mat.depthWrite = this.priming ? false : gm.depthWrite;
        if (gm.emissive && gm.emissiveBase) gm.emissive.copy(gm.emissiveBase).lerp(ACCENT, GLB_HL_TINT * rig.hl);
      }
      // Soft shadow just behind the model, slightly low, so it lifts off the dimmed frame.
      rig.shadow.visible = partShadow && rig.shadowMat.map !== null;
      rig.shadow.position.set(0, -0.06 * h, -MODEL_MAX_DEPTH * d / 2 - 2);
      if (FIT_EVEN) rig.shadow.scale.set(rig.glbNorm.x * sz * 1.15, rig.glbNorm.y * sz * 1.25, 1);
      else rig.shadow.scale.set(w * 1.15, h * 1.25, 1);
      rig.shadowMat.opacity = partShadow ? SHADOW_OPACITY * rig.vis * gf * dimF : 0;
    }

    rig.shadow.renderOrder = order - 1;
    rig.body.renderOrder = order;
    rig.edges.renderOrder = order + 1;
    if (rig.glb)
      rig.glb.traverse((o: THREE.Object3D) => {
        o.renderOrder = order + 2;
      });
  }

  /** Freeze / follow: the parts sit over the object on screen, then fly into the stack. */
  private updateScreen(input: BoxFrameInput): { labels: LabelItem[]; bounds: StackBounds } {
    const { now, dt, vw, vh } = input;
    this.priming = false;
    this.anim.update(now, dt, input.explodeTarget);
    if (this.stageActive) {
      // Switched away from stage mode (hidden M key): back to the flat screen layout.
      this.stageActive = false;
      this.tiltG.rotation.set(0, 0, 0);
      this.spinG.rotation.set(0, 0, 0);
      this.spinG.scale.set(1, 1, 1);
      if (this.groundShadow) this.groundShadow.visible = false;
    }

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

      const order = 10 + (this.anim.layerCount - this.anim.rankOf(part.layer)) * 4;
      this.stylePart(rig, p * smoothstep(0.02, 0.25, e), w, h, d, order, dt, anyHl, input.highlighted.has(part.id), kHl, true);
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

  /** Stage: the model lifts out of the object, floats in the middle of the view and turns. */
  private updateStage(input: BoxFrameInput, sf: StageFrame): { labels: LabelItem[]; bounds: StackBounds } {
    const { now, dt, vw, vh } = input;
    this.stageActive = true;

    if (!this.stage) {
      const box = input.box ?? { cx: vw / 2, cy: vh * 0.47, w: vw * 0.3, h: vw * 0.3 * 0.68 };
      const from = sf.startBox ?? box;
      // The object's own proportions (#120), not the detector's box (squashed by the camera angle).
      const parts = this.parts.map((r) => r.part);
      const rankOf = (layer: number) => this.anim.rankOf(layer);
      const W = STAGE_UNITS;
      const H = STAGE_UNITS * stageAspect(parts, this.dims, box.h / Math.max(1, box.w));
      const laid = stageLayout(parts, rankOf, this.anim.layerCount, W, H);
      const depthScale = stageDepthScale(laid, parts, this.dims);
      const layout = depthScale === 1 ? laid : stageLayout(parts, rankOf, this.anim.layerCount, W, H, depthScale);
      // Start facing the camera exactly as the real object does (a whole number of turns).
      const yaw0 = nearestTurn(sf.yaw);
      const fromPill = !!sf.startBox;
      this.stage = { layout, lift: new Lift(), waited: 0, drawnSerial: -1, fromPill, yaw0, yaw: yaw0, yawV: 0, pitch: 0, pitchV: 0, zoom: 1, zoomV: 0, panX: 0, panXV: 0, panY: 0, panYV: 0, from: { cx: from.cx, cy: from.cy, w: from.w, h: from.h } };
    }
    const st = this.stage;
    // The lift (liftOut.ts): it appears once the models that are loading have arrived (or after
    // STAGE_MODEL_WAIT_S; later ones cross-fade in place). Models there before it appears show at once.
    let loading = false;
    for (const rig of this.parts) if (rig.loadingUrl !== null) loading = true;
    if (!st.lift.shown) st.waited += dt;
    // #125: and only once a frame has been drawn (invisibly) with every model attached so far, so the
    // first frame it shows on is never the one that compiles their shaders (the wait counts clamped
    // steps: a long compile frame keeps the outline up instead of using up the wait).
    const drawn = st.drawnSerial === this.attachSerial;
    st.lift.update(dt, !sf.putAway, (!loading && drawn) || st.waited >= STAGE_MODEL_WAIT_S);
    if (!st.lift.shown) for (const rig of this.parts) if (rig.glb) rig.glbFade = 1;
    this.priming = !st.lift.shown;
    if (this.priming) st.drawnSerial = this.attachSerial;
    // Explode: at most the analysed amount until it has arrived (shown only from the last third of
    // the rise, through spreadK), then what was asked ("explode it" opens once it is up).
    const asked = sf.putAway ? 0 : input.explodeTarget;
    this.anim.update(now, dt, st.lift.arrived ? asked : Math.min(asked, STAGE_MIN_EXPLODE));
    if (input.box && (sf.putAway || (st.lift.follow && !st.fromPill))) {
      // Follow the real object for the first third of the lift, and all the way back when put away.
      const k = 1 - Math.exp(-dt * 12);
      st.from.cx += (input.box.cx - st.from.cx) * k;
      st.from.cy += (input.box.cy - st.from.cy) * k;
      st.from.w += (input.box.w - st.from.w) * k;
      st.from.h += (input.box.h - st.from.h) * k;
    }
    // L: 0 on the object, 1 in the middle of the view (a little past it at the overshoot).
    const L = st.lift.pos;
    const L01 = Math.min(1, Math.max(0, L));
    // The parts separate only as it arrives, and close as it is put away.
    const spreadK = st.lift.spreadK;
    [st.yaw, st.yawV] = springStep(st.yaw, st.yawV, sf.putAway ? nearestTurn(st.yaw) : sf.yaw, STAGE_TURN_OMEGA, dt);
    [st.pitch, st.pitchV] = springStep(st.pitch, st.pitchV, sf.putAway ? 0 : sf.pitch, STAGE_TURN_OMEGA, dt);
    [st.zoom, st.zoomV] = springStep(st.zoom, st.zoomV, sf.putAway || !Number.isFinite(sf.zoom) ? 1 : sf.zoom, STAGE_TURN_OMEGA, dt);
    const panGoalX = sf.putAway ? 0 : sf.panX ?? 0;
    const panGoalY = sf.putAway ? 0 : sf.panY ?? 0;
    [st.panX, st.panXV] = springStep(st.panX, st.panXV, Number.isFinite(panGoalX) ? panGoalX : 0, STAGE_TURN_OMEGA, dt);
    [st.panY, st.panYV] = springStep(st.panY, st.panYV, Number.isFinite(panGoalY) ? panGoalY : 0, STAGE_TURN_OMEGA, dt);
    const p = st.lift.opacity;

    const lay = st.layout;
    const n = lay.ranks;
    const eByRank: number[] = new Array(n).fill(0);
    for (const rig of this.parts) eByRank[this.anim.rankOf(rig.part.layer)] = this.anim.get(rig.part.layer) * spreadK;
    const stack = stageStack(lay, (r) => eByRank[r] ?? 0);

    // Orientation: top-down (as the camera sees the object) on the object, three-quarter view on stage.
    const elevation = STAGE_ELEVATION + st.pitch;
    this.tiltG.rotation.set(-(Math.PI / 2 - elevation) * L, 0, 0);
    // the turn also travels on the lift's curve: on the object it is the object's own
    this.spinG.rotation.set(0, 0, st.yaw0 + (st.yaw - st.yaw0) * L01);
    // On the object it has the box's proportion (as today: exactly over it), morphing to its own on
    // the same curve (#120); a saved pill's round thumb gives no shape, so from there it keeps its own.
    const fromAspect = Math.min(3, Math.max(0.2, st.from.h / Math.max(1, st.from.w)));
    const ky0 = st.fromPill ? 1 : fromAspect / (lay.H / lay.W);
    this.spinG.scale.set(1, ky0 + (1 - ky0) * L01, 1);
    // Seen from below (pitched far up), the deepest layer is the nearest: draw it last.
    const fromAbove = Math.sin(elevation * L01 + (Math.PI / 2) * (1 - L01)) >= 0;

    const anyHl = input.highlighted.size > 0;
    const kHl = 1 - Math.exp(-dt * 10);
    this.parts.forEach((rig, i) => {
      const sp = lay.parts[i];
      const e = Math.min(1, this.anim.get(rig.part.layer)) * spreadK;
      rig.body.scale.set(sp.w, sp.h, sp.d);
      rig.edges.scale.copy(rig.body.scale);
      rig.pivot.position.set(sp.ax + (sp.px - sp.ax) * e, sp.ay + (sp.py - sp.ay) * e, stack.z[i]);
      rig.tilt.rotation.set(0, 0, 0);
      rig.hw = sp.w / 2;
      rig.hh = sp.h / 2;
      const rank = sp.rank;
      const order = 10 + (fromAbove ? n - rank : rank + 1) * 4;
      this.stylePart(rig, p, sp.w, sp.h, sp.d, order, dt, anyHl, input.highlighted.has(rig.part.id), kHl, false);
    });

    // One soft shadow on the "ground" under the model (not while it still sits on the real object).
    if (this.groundShadow && this.groundMat) {
      this.groundShadow.visible = p * L01 > 0.01 || this.priming;
      this.groundShadow.position.set(0, -0.04 * lay.H, stack.bottom - 6);
      this.groundShadow.scale.set(lay.W * 1.25, lay.H * 1.35, 1);
      this.groundMat.opacity = STAGE_SHADOW_OPACITY * p * smoothstep(0.3, 1, L01);
    }

    // Size and place: on the object's box at L = 0; on stage, fitted (whatever the yaw) between
    // the label columns, the title and the voice area, about half the view height when assembled.
    const side = Math.min(LABEL_SIDE_MAX_PX, vw * LABEL_SIDE_FRAC);
    const availW = Math.max(100, vw - 2 * side);
    const availH = Math.max(100, vh - TOP_MARGIN - BOTTOM_MARGIN);
    const R = lay.radius;
    const sizeCap = Math.min(STAGE_SIZE * vh, availW) / (2 * R);
    // Zoomed (store.modelZoom), the model grows about its middle and may leave the view.
    const sStage = Math.min(sizeCap, stageFit(R, stack.top - stack.bottom, STAGE_ELEVATION, availW, availH)) * Math.max(0.05, st.zoom);
    const s0 = Math.max(0.05, st.from.w / lay.W);
    const s = s0 + (sStage - s0) * L;
    // Panned (store.modelPanX / modelPanY, #121): the stage point moves; the lift starts and ends on the object.
    const cx = st.from.cx + (vw / 2 + panPx(st.panX, vh) - st.from.cx) * L;
    const cy = st.from.cy + (TOP_MARGIN + availH / 2 + panPx(st.panY, vh) - st.from.cy) * L;
    this.root.position.set(cx - vw / 2, vh / 2 - cy, 0);
    this.root.scale.setScalar(s);
    this.root.updateMatrixWorld(true);

    // Labels (fade in above ~0.5; hidden when the part is off screen, zoomed in) and the model's
    // on-screen bounds (for the label columns).
    const labels: LabelItem[] = [];
    const v = new THREE.Vector3();
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const rig of this.parts) {
      const e = this.anim.get(rig.part.layer) * spreadK;
      const hidden = this.meshOnly && !rig.glb;
      if (hidden) continue; // not drawn on stage: no label, not in the bounds
      const m = rig.pivot.matrixWorld;
      const sc = rig.body.scale;
      for (let c = 0; c < 8; c++) {
        v.set(((c & 1) - 0.5) * sc.x, (((c >> 1) & 1) - 0.5) * sc.y, (((c >> 2) & 1) - 0.5) * sc.z).applyMatrix4(m);
        minX = Math.min(minX, v.x);
        maxX = Math.max(maxX, v.x);
        minY = Math.min(minY, v.y);
        maxY = Math.max(maxY, v.y);
      }
      rig.pivot.getWorldPosition(v);
      const ax = v.x + vw / 2;
      const ay = vh / 2 - v.y;
      labels.push({
        id: rig.part.id,
        text: rig.part.name,
        ax,
        ay,
        opacity: p * st.lift.labels * smoothstep(0.5, 0.85, e) * (rig.dim > 0.5 ? 0.55 : 1) * inView(ax, ay, vw, vh),
        highlighted: rig.hl > 0.5,
      });
    }
    if (!Number.isFinite(minX)) {
      minX = maxX = this.root.position.x;
      minY = maxY = this.root.position.y;
    }
    const bounds: StackBounds = { left: minX + vw / 2, right: maxX + vw / 2, top: vh / 2 - maxY, bottom: vh / 2 - minY };
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
    this.groundMat?.dispose();
    this.planeGeo.dispose();
    this.parts = [];
  }
}
