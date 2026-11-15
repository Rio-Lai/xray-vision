/**
 * Kash's eye as the floating model (#94): his ten procedural GLBs (public/cache/meshes/eye/, built
 * by scripts/build-eye.ts) drawn the way his preview (scripts/eye/preview.html) draws them, in a
 * small renderer of its own beside ArmStage.tsx, driven every frame from the app store.
 *
 *  - Shared frame: the GLBs share one origin (the eyeball's centre; +z anterior, +y superior, +x
 *    nasal of a right eye; eyeball 1 unit across). They are loaded in their own coordinates under one
 *    group and never stretched per part (the box rig would); the whole eye is scaled uniformly to the
 *    stage size by the camera, so every part keeps its true proportion.
 *  - Explode (store.explodeAmount; 0.12, the "analyse" amount, = assembled, 1 = fully apart): each
 *    part slides along the visual axis (z) by (5 - layer) * 0.3 eyeball widths, his preview's spacing:
 *    the cornea forwards, the optic nerve backwards, the vitreous stays. As it opens, the view turns
 *    from his "assembled" camera to his "exploded" one, and the upper half is cut away (his cutaway,
 *    a clipping plane sliding down from above the eye), so the inside shows. A step or a highlighted
 *    part brings the cutaway in too, on the assembled eye, so the path of light can be seen.
 *  - His materials are kept (transparent cornea, lens and humours; textured iris and retina): only
 *    clipping, a highlight tint, dimming of the other parts while something is highlighted, and his
 *    darkening of the eye's lining while it is closed (so the pupil looks black) are added, on copies.
 *  - It lifts out of the eye it came from (facing the wearer, as the real eye does; a left eye is
 *    mirrored, so the optic nerve leaves on the nasal side), glides to the middle of the view and
 *    turns to his three-quarter view; modelYaw / modelPitch (hands, mouse, voice) and the idle drift
 *    turn it; "put it away" glides it back into the eye and fades it (as the box rig and the arm do).
 *  - Part labels are the Blowfish pills (labels.ts) on each part once it is apart, and on the parts of
 *    a step or a highlight; the overlay asks `eyeStage.pickAt` which part a click is on.
 *  - It is mounted from the start and draws nothing until the eye opens: a few seconds after the
 *    page loads it builds the eye from /cache/eye.json (the models are preloaded) and compiles its
 *    shaders once in every variant it will need (the cutaway's double sides, the dimmed parts), so
 *    "analyse the eye" opens it at once, with no stutter while it opens.
 */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { useStore } from '../state/store';
import type { AppState } from '../state/store';
import { boxToView, errorText, getCoverMap } from '../camera/frame';
import { live } from '../detect/live';
import { devLog, setStatus } from '../hud/hudStore';
import { isEyeTeardown } from '../stage/eyeTeardown';
import { sentenceCase } from '../stage/armTeardown';
import { STAGE_MIN_EXPLODE, modelControl } from '../stage/modelControl';
import { smoothstep } from './explodeAnimator';
import { BOTTOM_MARGIN, LABEL_SIDE_FRAC, LABEL_SIDE_MAX_PX, STAGE_LIFT_OMEGA, STAGE_SIZE, TOP_MARGIN } from './boxRig';
import type { ScreenBox } from './boxRig';
import { loadGlbTemplate } from './glbCache';
import { LabelLayer } from './labels';
import type { LabelItem } from './labels';
import { springStep } from './stageLayout';

/** His preview's explode: each layer moves this many eyeball widths per layer away from the middle one. */
const SPACING = 0.3;
/** His preview's two cameras (eye frame), as views of the model: assembled, and exploded. */
const VIEW_ASSEMBLED = { eye: new THREE.Vector3(0.95, 0.55, 2.1), target: new THREE.Vector3(0.02, 0, 0.1) };
const VIEW_EXPLODED = { eye: new THREE.Vector3(2.6, 2.6, 2.2), target: new THREE.Vector3(0, -0.1, 0) };
/** Cut plane height (eye frame y) with nothing cut away; 0 = his cutaway, the upper half removed. */
const CUT_NONE = 0.62;
/** Parts that line the inside: darkened while the eye is closed, as in his preview. */
const LINING = new Set(['retina', 'choroid', 'ciliary-body']);
const LINING_DARK = 0.015;
/** Fit: the stage disc may be exceeded by this much (the exploded eye lies diagonally). */
const SPHERE_SLACK = 1.35;
/** Idle drift, as for the box model and the arm. */
const IDLE_MS = 4000;
const IDLE_SPIN = 0.1;
const TURN_OMEGA = 12;
/** The eye waits this long at most for its models before it lifts (they are preloaded). */
const MAX_WAIT_MS = 1500;
/** The eye is built and its shaders compiled this long after the page starts (after the laptop's models). */
const INIT_DELAY_MS = 4000;
/** Kash's parts list, read for the part ids, layers and model URLs. */
const EYE_JSON = '/cache/eye.json';
/** Labels for every part fade in between these normalised explode amounts. */
const LABEL_FROM = 0.35;
const LABEL_FULL = 0.75;
/** Picking needs the eye open or cut away at least this much. */
const PICK_MIN = 0.3;
const ACCENT = new THREE.Color('#4DA3FF');
const HL_TINT = 0.35;
const DIM_TO = 0.3;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** For the overlay: ticked every frame, and which part is at a viewport point (null when the eye is not up). */
export const eyeStage: { tick: (now: number) => void; pickAt: (x: number, y: number) => string | null } = {
  tick: () => undefined,
  pickAt: () => null,
};

/** Rotation that shows the model as a camera at `eye` looking at `target` sees it (y up). */
function viewQuat(v: { eye: THREE.Vector3; target: THREE.Vector3 }): THREE.Quaternion {
  const m = new THREE.Matrix4().lookAt(v.eye, v.target, new THREE.Vector3(0, 1, 0));
  return new THREE.Quaternion().setFromRotationMatrix(m).invert();
}
const Q_ASSEMBLED = viewQuat(VIEW_ASSEMBLED);
const Q_EXPLODED = viewQuat(VIEW_EXPLODED);
const Q_IDENTITY = new THREE.Quaternion();

interface Bounds {
  min: THREE.Vector3;
  max: THREE.Vector3;
  centre: THREE.Vector3;
  radius: number;
}

/** Bounds of a model in its own (the eye's) frame, from its vertices, by URL: the GLBs are shared and never change. */
const boundsCache = new Map<string, Bounds>();

function modelBounds(url: string, obj: THREE.Object3D): Bounds {
  const hit = boundsCache.get(url);
  if (hit) return hit;
  obj.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  const meshes: THREE.Mesh[] = [];
  obj.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
  });
  for (const m of meshes) {
    const pos = m.geometry.getAttribute('position');
    if (!pos) continue;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      min.min(v);
      max.max(v);
    }
  }
  if (!Number.isFinite(min.x)) {
    min.set(-0.1, -0.1, -0.1);
    max.set(0.1, 0.1, 0.1);
  }
  const centre = min.clone().add(max).multiplyScalar(0.5);
  let r2 = 0;
  for (const m of meshes) {
    const pos = m.geometry.getAttribute('position');
    if (!pos) continue;
    for (let i = 0; i < pos.count; i++) r2 = Math.max(r2, v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld).distanceToSquared(centre));
  }
  const b = { min, max, centre, radius: Math.max(0.01, Math.sqrt(r2)) };
  boundsCache.set(url, b);
  return b;
}

interface EyeMat {
  mat: THREE.MeshStandardMaterial;
  baseColor: THREE.Color;
  baseEmissive: THREE.Color;
  baseEnv: number;
  baseOpacity: number;
  baseSide: THREE.Side;
  transmissive: boolean;
  dimmed: boolean;
}

/** What the stage needs of a part from his parts list. */
interface PartSpec {
  id: string;
  layer: number;
  url: string;
}

function partSpecs(parts: unknown): PartSpec[] {
  if (!Array.isArray(parts)) return [];
  const out: PartSpec[] = [];
  for (const p of parts as { id?: unknown; layer?: unknown; mesh_url?: unknown }[]) {
    if (typeof p.id === 'string' && typeof p.layer === 'number' && typeof p.mesh_url === 'string' && p.mesh_url.length > 0) {
      out.push({ id: p.id, layer: p.layer, url: p.mesh_url });
    }
  }
  return out;
}

interface EyePart {
  id: string;
  layer: number;
  holder: THREE.Group;
  bounds: Bounds;
  /** label point in the eye frame: on the part, in the half that the cutaway keeps */
  anchor: THREE.Vector3;
  mats: EyeMat[];
  lining: boolean;
  hl: number;
  dim: number;
}

class EyeStageCtl {
  private host: HTMLDivElement | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private envTex: THREE.Texture | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 40);
  /** turn (orientation) > mirror (a left eye) > offset (-pivot) > one holder per part (its explode slide) */
  private readonly turn = new THREE.Group();
  private readonly mirror = new THREE.Group();
  private readonly offset = new THREE.Group();
  private parts: EyePart[] = [];
  private labels: LabelLayer | null = null;
  private readonly cutWorld = new THREE.Plane(new THREE.Vector3(0, -1, 0), CUT_NONE);
  private readonly cutLocal = new THREE.Plane(new THREE.Vector3(0, -1, 0), CUT_NONE);
  private cutSides = false;
  /** building has started / finished (all models settled) */
  private loading = false;
  private settled = false;
  private initTimer: ReturnType<typeof setTimeout> | null = null;
  /** an open has started (for MAX_WAIT_MS), the eye was open last frame, something is on the canvas */
  private sessionAt = 0;
  private wasOn = false;
  private drawn = false;
  private lastNow = 0;
  private vw = 0;
  private vh = 0;
  private dpr = 1;
  // glide (as BoxRig.updateStage / ArmStage)
  private lift = 0;
  private liftV = 0;
  private presence = 0;
  private from: ScreenBox | null = null;
  private objectId: string | null = null;
  // view
  private yaw = 0;
  private yawV = 0;
  private pitch = 0;
  private pitchV = 0;
  private drift = 0;
  private lastInput = 0;
  private seen = { yaw: 0, pitch: 0, explode: 0, step: null as number | null, hl: null as string | null };
  private eShown = 0;
  private cut = 0;
  private ppu = 1;
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();

  constructor() {
    this.scene.add(this.turn);
    this.turn.add(this.mirror);
    this.mirror.add(this.offset);
    this.camera.position.set(0, 0, 20);
    // His preview's lights, fixed to the view as his "assembled" camera sees them: a key high and to
    // the side (so the pupil reads black, not red), a cool rim from behind, and a studio environment
    // for the reflections (attach). His (-2.2, 4.2, 1.6) and (-3, 1, -2) in that camera's frame:
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(-2.66, 3.92, 1.53);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x9fc4ff, 1.2);
    rim.position.set(-1.91, 1.7, -2.72);
    this.scene.add(rim);
  }

  attach(host: HTMLDivElement, labelHost: HTMLDivElement): void {
    this.host = host;
    this.lastInput = performance.now();
    try {
      const r = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
      r.setClearColor(0x000000, 0);
      r.toneMapping = THREE.ACESFilmicToneMapping;
      r.toneMappingExposure = 1.05;
      r.localClippingEnabled = true;
      Object.assign(r.domElement.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', opacity: '0' });
      host.appendChild(r.domElement);
      this.renderer = r;
      try {
        const pmrem = new THREE.PMREMGenerator(r);
        this.envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
        this.scene.environment = this.envTex;
        pmrem.dispose();
      } catch (e) {
        devLog(`Eye: no environment light: ${errorText(e)}`, 'warn');
      }
      setStatus('eye-webgl', null);
    } catch (e) {
      setStatus('eye-webgl', 'error', `WebGL unavailable, the eye cannot be drawn: ${errorText(e)}`);
    }
    this.labels = new LabelLayer(labelHost);
    this.initTimer = setTimeout(() => {
      this.initTimer = null;
      void this.init();
    }, INIT_DELAY_MS);
    eyeStage.tick = this.tick;
    eyeStage.pickAt = this.pickAt;
  }

  detach(): void {
    if (this.initTimer) clearTimeout(this.initTimer);
    this.initTimer = null;
    eyeStage.tick = () => undefined;
    eyeStage.pickAt = () => null;
    this.labels?.dispose();
    this.labels = null;
    for (const p of this.parts) for (const m of p.mats) m.mat.dispose(); // copies; geometry and textures stay cached
    this.parts = [];
    this.offset.clear();
    this.envTex?.dispose();
    this.envTex = null;
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.forceContextLoss();
      this.renderer.domElement.remove();
      this.renderer = null;
    }
    this.host = null;
  }

  /**
   * Build the eye once: from the parts list on stage if it is the eye, else from his file. Then
   * compile the shaders. Runs a few seconds after the page starts, or at once if the eye is asked for first.
   */
  private async init(fromStore?: unknown): Promise<void> {
    if (this.loading || !this.host) return;
    this.loading = true;
    let specs = partSpecs(fromStore);
    if (specs.length === 0) {
      try {
        const r = await fetch(EYE_JSON);
        if (r.ok && !(r.headers.get('content-type') ?? '').includes('text/html')) specs = partSpecs(((await r.json()) as { parts?: unknown }).parts);
      } catch (e) {
        devLog(`Eye: ${EYE_JSON} did not load (${errorText(e)})`, 'warn');
      }
    }
    if (specs.length === 0) {
      // Try again when the eye is opened (its parts list will be in the store then).
      this.loading = false;
      return;
    }
    await this.load(specs);
    if (!this.host) return;
    if (this.parts.length === 0) {
      // Tried again at the next open.
      this.loading = false;
      setStatus('eye-models', 'error', 'The eye models did not load (public/cache/meshes/eye/)');
      return;
    }
    this.settled = true;
    setStatus('eye-models', null);
    this.warmUp();
  }

  /** His models, each in its own holder; added as they arrive (normally at once: they are preloaded). */
  private async load(specs: PartSpec[]): Promise<void> {
    const mid = (Math.min(...specs.map((p) => p.layer)) + Math.max(...specs.map((p) => p.layer))) / 2;
    const jobs = specs.map((p) =>
        loadGlbTemplate(p.url)
          .then((tpl) => {
            if (!this.host) return;
            const obj = tpl.clone(true);
            const bounds = modelBounds(p.url, obj);
            const mats: EyeMat[] = [];
            obj.traverse((o) => {
              const mesh = o as THREE.Mesh;
              if (!mesh.isMesh) return;
              const copy = (m: THREE.Material): THREE.Material => {
                const c = m.clone();
                const sm = c as THREE.MeshStandardMaterial;
                if (sm.isMeshStandardMaterial) {
                  sm.clippingPlanes = [this.cutWorld];
                  mats.push({
                    mat: sm,
                    baseColor: sm.color.clone(),
                    baseEmissive: sm.emissive.clone(),
                    baseEnv: sm.envMapIntensity,
                    baseOpacity: sm.opacity,
                    baseSide: sm.side,
                    transmissive: ((sm as THREE.MeshPhysicalMaterial).transmission ?? 0) > 0,
                    dimmed: false,
                  });
                } else {
                  c.clippingPlanes = [this.cutWorld];
                }
                return c;
              };
              mesh.material = Array.isArray(mesh.material) ? mesh.material.map(copy) : copy(mesh.material);
            });
            const holder = new THREE.Group();
            holder.userData.partId = p.id;
            holder.add(obj);
            this.offset.add(holder);
            const half = (bounds.max.y - bounds.min.y) / 2;
            this.parts.push({
              id: p.id,
              layer: p.layer - mid,
              holder,
              bounds,
              anchor: new THREE.Vector3(bounds.centre.x, bounds.centre.y - half * 0.5, bounds.centre.z),
              mats,
              lining: LINING.has(p.id),
              hl: 0,
              dim: 1,
            });
          })
          .catch((e: unknown) => devLog(`Eye: model ${p.id} did not load (${errorText(e)})`, 'warn')),
      );
    await Promise.allSettled(jobs);
  }

  /**
   * Compile the shaders now, while nothing is shown, in each variant the eye will need: as built,
   * double-sided (the cutaway) and dimmed (another part highlighted). Without this the first open
   * would stop for a moment while they compile. The canvas is invisible and cleared afterwards.
   */
  private warmUp(): void {
    const r = this.renderer;
    if (!r) return;
    const t0 = performance.now();
    try {
      this.resize();
      const ppu = Math.max(50, 0.3 * this.vh);
      Object.assign(this.camera, { left: -this.vw / 2 / ppu, right: this.vw / 2 / ppu, top: this.vh / 2 / ppu, bottom: -this.vh / 2 / ppu });
      this.camera.position.set(0, 0, 20);
      this.camera.updateProjectionMatrix();
      const mats = this.parts.flatMap((p) => p.mats);
      const set = (side: THREE.Side, dim: boolean) => {
        for (const m of mats) {
          m.mat.side = side;
          const d = dim && !m.transmissive;
          m.mat.transparent = d;
          m.mat.depthWrite = !d;
          m.mat.needsUpdate = true;
        }
        r.render(this.scene, this.camera);
      };
      r.render(this.scene, this.camera);
      set(THREE.DoubleSide, false);
      set(THREE.DoubleSide, true);
      for (const m of mats) {
        m.mat.side = m.baseSide;
        m.mat.transparent = false;
        m.mat.depthWrite = true;
        m.mat.needsUpdate = true;
        m.dimmed = false;
      }
      this.cutSides = false;
      r.render(this.scene, this.camera);
      r.clear();
      devLog(`Eye ready: ${this.parts.length} models, shaders compiled in ${Math.round(performance.now() - t0)} ms`);
    } catch (e) {
      devLog(`Eye: shader warm-up failed (${errorText(e)}); it compiles on first open instead`, 'warn');
    }
  }

  /** The viewport box of the eye it came out of, if it is in view. */
  private objectBox(): ScreenBox | null {
    const obj = this.objectId ? live.objects.find((o) => o.id === this.objectId) : undefined;
    if (!obj) return null;
    const b = boxToView(getCoverMap(), obj.box);
    return { cx: b.x + b.w / 2, cy: b.y + b.h / 2, w: b.w, h: b.h };
  }

  /** Target yaw with the idle drift; any input (or a step / highlight) stops the drift. */
  private targetYaw(s: AppState, now: number, dt: number, still: boolean): number {
    const sn = this.seen;
    if (
      s.modelYaw !== sn.yaw ||
      s.modelPitch !== sn.pitch ||
      s.explodeAmount !== sn.explode ||
      s.activeStep !== sn.step ||
      s.highlightedPartId !== sn.hl ||
      modelControl.lastInputAt > this.lastInput
    ) {
      this.lastInput = Math.max(now, modelControl.lastInputAt);
      this.seen = { yaw: s.modelYaw, pitch: s.modelPitch, explode: s.explodeAmount, step: s.activeStep, hl: s.highlightedPartId };
    }
    if (still && now - this.lastInput > IDLE_MS) this.drift += IDLE_SPIN * dt;
    return s.modelYaw + this.drift;
  }

  private resize(): void {
    const vw = Math.max(1, window.innerWidth);
    const vh = Math.max(1, window.innerHeight);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (vw === this.vw && vh === this.vh && dpr === this.dpr) return;
    this.vw = vw;
    this.vh = vh;
    this.dpr = dpr;
    this.renderer?.setPixelRatio(dpr);
    this.renderer?.setSize(vw, vh, false);
  }

  /** Explode slide of a part along the visual axis (eye frame z). */
  private slide(p: EyePart): number {
    return -p.layer * SPACING * this.eShown;
  }

  /** Pivot (centre of all parts' bounds at the current explode, eye frame, before the mirror). */
  private pivot(): THREE.Vector3 {
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (const p of this.parts) {
      const dz = this.slide(p);
      min.min(new THREE.Vector3(p.bounds.min.x, p.bounds.min.y, p.bounds.min.z + dz));
      max.max(new THREE.Vector3(p.bounds.max.x, p.bounds.max.y, p.bounds.max.z + dz));
    }
    if (!Number.isFinite(min.x)) return new THREE.Vector3();
    return min.add(max).multiplyScalar(0.5);
  }

  /**
   * Px per eye unit that fits the stage: the parts as seen in the base view (without the wearer's
   * turning, so the size does not breathe as it turns) within the free area, and a disc round the
   * turning centre at most SPHERE_SLACK times the free area; the eyeball at most STAGE_SIZE of the view height.
   */
  private fitPpu(base: THREE.Quaternion, pivot: THREE.Vector3, mirror: number, availW: number, availH: number, vh: number): number {
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    let reach = 0;
    const c = new THREE.Vector3();
    for (const p of this.parts) {
      c.set(p.bounds.centre.x * mirror, p.bounds.centre.y, p.bounds.centre.z + this.slide(p)).sub(new THREE.Vector3(pivot.x * mirror, pivot.y, pivot.z));
      reach = Math.max(reach, c.length() + p.bounds.radius);
      c.applyQuaternion(base);
      x0 = Math.min(x0, c.x - p.bounds.radius);
      x1 = Math.max(x1, c.x + p.bounds.radius);
      y0 = Math.min(y0, c.y - p.bounds.radius);
      y1 = Math.max(y1, c.y + p.bounds.radius);
    }
    if (!Number.isFinite(x0)) return (STAGE_SIZE * vh) / 2;
    const proj = Math.min(availW / Math.max(0.01, x1 - x0), availH / Math.max(0.01, y1 - y0));
    const disc = (SPHERE_SLACK * Math.min(availW, availH)) / Math.max(0.01, 2 * reach);
    return Math.max(1, Math.min(proj, disc, STAGE_SIZE * vh));
  }

  /** Highlight tint, dimming of the others, his lining darkening, and the double sides of the cutaway. */
  private updateMaterials(hlIds: Set<string>, dt: number, lit: number): void {
    const cutSides = this.cut > 0.01;
    const sideChanged = cutSides !== this.cutSides;
    this.cutSides = cutSides;
    const k = 1 - Math.exp(-dt * 10);
    for (const p of this.parts) {
      const hl = hlIds.has(p.id) ? 1 : 0;
      const dimTarget = hlIds.size > 0 && !hlIds.has(p.id) ? DIM_TO : 1;
      p.hl += (hl - p.hl) * k;
      p.dim += (dimTarget - p.dim) * k;
      const shade = p.lining ? LINING_DARK + (1 - LINING_DARK) * lit : 1;
      for (const m of p.mats) {
        const mat = m.mat;
        mat.color.copy(m.baseColor).multiplyScalar(shade);
        if (p.lining) mat.envMapIntensity = m.baseEnv * (0.02 + 0.98 * lit);
        mat.emissive.copy(m.baseEmissive).lerp(ACCENT, HL_TINT * p.hl);
        // Clear parts stay as he made them; the others fade while something else is highlighted.
        const dim = !m.transmissive && p.dim < 0.98;
        if (dim !== m.dimmed) {
          m.dimmed = dim;
          mat.transparent = dim;
          mat.depthWrite = !dim;
          mat.needsUpdate = true;
        }
        mat.opacity = m.baseOpacity * (dim ? p.dim : 1);
        if (sideChanged) {
          mat.side = cutSides ? THREE.DoubleSide : m.baseSide;
          mat.needsUpdate = true;
        }
      }
    }
  }

  tick = (now: number): void => {
    const dt = this.lastNow ? Math.min(0.1, Math.max(0, (now - this.lastNow) / 1000)) : 1 / 60;
    this.lastNow = now;
    this.resize();
    const w = this.vw;
    const h = this.vh;
    const s = useStore.getState();
    const on = isEyeTeardown(s.teardown);
    if (on && !this.wasOn) {
      // A new open (unless it is re-opened while still going away): start from the eye in view.
      if (this.presence < 0.05 && this.lift < 0.05) {
        this.from = null;
        this.objectId = null;
        this.drift = 0;
        this.yaw = s.modelYaw;
        this.yawV = 0;
        this.pitch = s.modelPitch;
        this.pitchV = 0;
        this.eShown = 0;
        this.cut = 0;
        this.lastInput = now;
        for (const p of this.parts) {
          p.hl = 0;
          p.dim = 1;
        }
      }
      this.sessionAt = now;
      if (!this.loading) void this.init(s.teardown?.parts);
    }
    this.wasOn = on;
    if (!on && this.lift < 0.002 && this.presence < 0.002) {
      // Nothing to show: clear once, then draw nothing.
      if (this.drawn) {
        this.drawn = false;
        this.lift = 0;
        this.liftV = 0;
        this.presence = 0;
        if (this.renderer) {
          this.renderer.domElement.style.opacity = '0';
          this.renderer.clear();
        }
        this.labels?.clear();
      }
      return;
    }
    this.drawn = true;
    // the eye it came out of (kept while it is put away, so it goes back into the same eye)
    if (on) this.objectId = s.selectedObjectId ?? s.focusedObjectId ?? this.objectId;
    const mirror = this.objectId && /^eye-left\b/.test(this.objectId) ? -1 : 1;

    // Glide: out of the eye to the middle of the view, and back into it when put away.
    const box = this.objectBox();
    if (!this.from) this.from = box ?? { cx: w / 2, cy: h / 2, w: 0.08 * h, h: 0.08 * h };
    else if (box) {
      const k = 1 - Math.exp(-dt * 12);
      this.from.cx += (box.cx - this.from.cx) * k;
      this.from.cy += (box.cy - this.from.cy) * k;
      this.from.w += (box.w - this.from.w) * k;
      this.from.h += (box.h - this.from.h) * k;
    }
    const go = on && this.parts.length > 0 && (this.settled || now - this.sessionAt > MAX_WAIT_MS);
    [this.lift, this.liftV] = springStep(this.lift, this.liftV, go ? 1 : 0, STAGE_LIFT_OMEGA, dt);
    const L = clamp01(this.lift);
    const presTarget = go ? 1 : smoothstep(0.03, 0.35, L);
    this.presence += (presTarget - this.presence) * (1 - Math.exp(-dt * (go ? 9 : 14)));

    // Store -> eye. Put away: it closes and keeps its last view.
    const step = on && s.teardown && s.activeStep !== null ? s.teardown.steps.find((x) => x.n === s.activeStep) : undefined;
    const hlIds = new Set<string>(on ? [...(step?.part_ids ?? []), ...(s.highlightedPartId ? [s.highlightedPartId] : [])] : []);
    const eTarget = on ? clamp01((s.explodeAmount - STAGE_MIN_EXPLODE) / (1 - STAGE_MIN_EXPLODE)) : 0;
    this.eShown += (eTarget - this.eShown) * (1 - Math.exp(-dt * 6));
    const cutTarget = on ? Math.max(smoothstep(0, 0.25, this.eShown), hlIds.size > 0 ? 1 : 0) : 0;
    this.cut += (cutTarget - this.cut) * (1 - Math.exp(-dt * 5));
    if (on) {
      const ty = this.targetYaw(s, now, dt, hlIds.size === 0);
      [this.yaw, this.yawV] = springStep(this.yaw, this.yawV, ty, TURN_OMEGA, dt);
      [this.pitch, this.pitchV] = springStep(this.pitch, this.pitchV, s.modelPitch, TURN_OMEGA, dt);
    }

    // Pose: explode slides, pivot, orientation (lift: facing the wearer -> his view, plus the wearer's turning).
    for (const p of this.parts) p.holder.position.set(0, 0, this.slide(p));
    const pivot = this.pivot();
    this.offset.position.copy(pivot).multiplyScalar(-1);
    this.mirror.scale.set(mirror, 1, 1);
    const base = Q_ASSEMBLED.clone().slerp(Q_EXPLODED, smoothstep(0.05, 0.7, this.eShown));
    const lifted = Q_IDENTITY.clone().slerp(base, smoothstep(0, 1, L));
    const user = new THREE.Quaternion()
      .setFromAxisAngle(new THREE.Vector3(1, 0, 0), this.pitch)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw));
    this.turn.quaternion.copy(user).multiply(lifted);

    // Size and place: the eyeball fills the eye's box at the start of the glide; on stage it fits the
    // free area between the label columns, the title and the voice area.
    const side = Math.min(LABEL_SIDE_MAX_PX, w * LABEL_SIDE_FRAC);
    const availW = Math.max(100, w - 2 * side);
    const availH = Math.max(100, h - TOP_MARGIN - BOTTOM_MARGIN);
    const fit = this.fitPpu(base, pivot, mirror, availW, availH, h);
    const fromPpu = Math.max(4, Math.min(this.from.w, this.from.h * 1.6));
    this.ppu = fromPpu + (fit - fromPpu) * L;
    const sx = this.from.cx + (w / 2 - this.from.cx) * L;
    const sy = this.from.cy + (TOP_MARGIN + availH / 2 - this.from.cy) * L;
    const cam = this.camera;
    cam.left = -w / 2 / this.ppu;
    cam.right = w / 2 / this.ppu;
    cam.top = h / 2 / this.ppu;
    cam.bottom = -h / 2 / this.ppu;
    cam.position.set((w / 2 - sx) / this.ppu, (sy - h / 2) / this.ppu, 20);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    this.scene.updateMatrixWorld();

    // Cutaway plane: his "upper half removed", in the eye's own frame, slid in from above the eye.
    this.cutLocal.constant = CUT_NONE * (1 - this.cut);
    this.cutWorld.copy(this.cutLocal).applyMatrix4(this.offset.matrixWorld);
    const lit = Math.max(this.cut, smoothstep(0, 0.15, this.eShown));
    this.updateMaterials(hlIds, dt, lit);

    if (this.renderer) {
      this.renderer.domElement.style.opacity = this.presence.toFixed(3);
      this.renderer.render(this.scene, cam);
    }
    this.updateLabels(on, hlIds, L, w, h);
  };

  private toScreen(v: THREE.Vector3, w: number, h: number): { x: number; y: number } {
    const p = v.project(this.camera);
    return { x: ((p.x + 1) / 2) * w, y: ((1 - p.y) / 2) * h };
  }

  private updateLabels(on: boolean, hlIds: Set<string>, L: number, w: number, h: number): void {
    if (!this.labels) return;
    const s = useStore.getState();
    const names = new Map<string, string>();
    if (on && s.teardown) for (const p of s.teardown.parts) names.set(p.id, sentenceCase(p.name));
    const base = on ? this.presence * smoothstep(0.75, 1, L) : 0;
    const all = smoothstep(LABEL_FROM, LABEL_FULL, this.eShown);
    const items: LabelItem[] = [];
    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    const v = new THREE.Vector3();
    for (const p of this.parts) {
      const c = this.toScreen(p.holder.localToWorld(v.copy(p.bounds.centre)), w, h);
      const r = p.bounds.radius * this.ppu;
      left = Math.min(left, c.x - r);
      right = Math.max(right, c.x + r);
      top = Math.min(top, c.y - r);
      bottom = Math.max(bottom, c.y + r);
      const highlighted = hlIds.has(p.id);
      const opacity = base * (highlighted ? 1 : hlIds.size > 0 ? all * 0.6 : all);
      if (opacity < 0.02) continue;
      const a = this.toScreen(p.holder.localToWorld(v.copy(p.anchor)), w, h);
      items.push({ id: p.id, text: names.get(p.id) ?? sentenceCase(p.id.replace(/-/g, ' ')), ax: a.x, ay: a.y, opacity, highlighted });
    }
    if (!Number.isFinite(left)) {
      left = right = w / 2;
      top = bottom = h / 2;
    }
    this.labels.update(items, { left, right, top, bottom }, w, h);
  }

  /** Part under a viewport point (not one cut away), when the eye is open or cut away enough. */
  pickAt = (x: number, y: number): string | null => {
    if (this.presence < 0.5 || clamp01(this.lift) < 0.9) return null;
    if (this.eShown < PICK_MIN && this.cut < PICK_MIN) return null;
    this.ndc.set((x / this.vw) * 2 - 1, -(y / this.vh) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hits = this.raycaster.intersectObject(this.offset, true);
    for (const hit of hits) {
      if (this.cutWorld.distanceToPoint(hit.point) < -1e-4) continue; // cut away: not visible
      let o: THREE.Object3D | null = hit.object;
      while (o) {
        const pid = o.userData.partId;
        if (typeof pid === 'string') return pid;
        o = o.parent;
      }
    }
    return null;
  };
}

/** Mounted by the overlay for the whole session: draws the eye while the store's parts list is the eye (and while it is put away). */
export function EyeStage() {
  const hostRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const [ctl] = useState(() => new EyeStageCtl());
  useEffect(() => {
    const host = hostRef.current;
    const labels = labelRef.current;
    if (!host || !labels) return;
    ctl.attach(host, labels);
    return () => ctl.detach();
  }, [ctl]);
  return (
    <>
      <div ref={hostRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
      <div ref={labelRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
    </>
  );
}

export default EyeStage;
