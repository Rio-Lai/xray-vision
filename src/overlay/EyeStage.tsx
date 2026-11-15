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
 *    part slides along the visual axis (z). Fully apart, the layers lie in a row in their order (the
 *    cornea in front, the optic nerve at the back), each placed by its real depth (its model's
 *    bounds along z) with ROW_GAP between neighbours, so the back shells (vitreous, retina,
 *    choroid, sclera) no longer nest inside one another (#109); parts of one layer (the lens and
 *    the ciliary body) stay together. In between, each part slides in proportion. As it opens, the view turns
 *    from his "assembled" camera to his "exploded" one, and the upper half is cut away (his cutaway,
 *    a clipping plane sliding down from above the eye), so the inside shows. A step or a highlighted
 *    part brings the cutaway in too, on the assembled eye, so the path of light can be seen.
 *  - His materials are kept (transparent cornea, lens and humours; textured iris and retina): only
 *    clipping, a highlight tint, dimming of the other parts while something is highlighted, and his
 *    darkening of the eye's lining while it is closed (so the pupil looks black) are added, on copies.
 *  - It lifts out of the eye it came from (liftOut.ts, #109, as the box rig and the arm do: an
 *    outline draws round the eye, the eyeball appears over it at its size, facing the wearer as the
 *    real eye does, opaque; a left eye is mirrored, so the optic nerve leaves on the nasal side), then
 *    rises, grows and turns to his three-quarter view on one ease-out curve, its parts separating
 *    only as it arrives; modelYaw / modelPitch (hands, mouse, voice) and the idle drift turn it,
 *    modelZoom (eased) scales it about its middle, modelPanX / modelPanY (eased, #121) move it
 *    (labels too); "put it away" closes it and glides it back into
 *    the eye (or its saved pill) and fades it. A saved eye brought back with no eye in view lifts
 *    out of its pill.
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
import { boxToView, canvasDpr, errorText, getCoverMap } from '../camera/frame';
import { live, perfCount } from '../detect/live';
import { devLog, setStatus } from '../hud/hudStore';
import { isEyeTeardown } from '../stage/eyeTeardown';
import { sentenceCase } from '../stage/armTeardown';
import { STAGE_MIN_EXPLODE, modelControl, panPx } from '../stage/modelControl';
import { smoothstep } from './explodeAnimator';
import { BOTTOM_MARGIN, LABEL_SIDE_FRAC, LABEL_SIDE_MAX_PX, STAGE_SIZE, STAGE_TURN_OMEGA, TOP_MARGIN } from './boxRig';
import type { ScreenBox } from './boxRig';
import { loadGlbTemplate } from './glbCache';
import { LabelLayer, inView } from './labels';
import { Lift, LiftOutline, frameStep, pillBox } from './liftOut';
import { idleSlice } from './glbCache';
import { reopenedSavedId } from '../lib/flow';
import { setStageArrived } from '../hud/hudStore';
import type { LabelItem } from './labels';
import { springStep } from './stageLayout';

/** Fully apart: the clear gap along the visual axis between neighbouring layers (eyeball widths). */
export const ROW_GAP = 0.1;
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
const TURN_OMEGA = STAGE_TURN_OMEGA;
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
export const eyeStage: { tick: (now: number) => void; pickAt: (x: number, y: number) => string | null; warm: () => boolean } = {
  tick: () => undefined,
  pickAt: () => null,
  /** its shaders are compiled (#125, for the overlay's open measurement) */
  warm: () => false,
};

/**
 * Each part's slide along the visual axis (eye frame z, + = anterior) when fully apart: the layers
 * in order (lowest first, in front), each layer's parts together, every layer placed just behind the
 * one before it by its real depth (its parts' z extent) with `gap` between them. The middle layer
 * stays put (the stage centres the row on its pivot anyway). Pure, so it can be checked on its own.
 */
export function rowSlides(parts: { layer: number; zMin: number; zMax: number }[], gap: number): number[] {
  const layers = [...new Set(parts.map((p) => p.layer))].sort((a, b) => a - b);
  const off = new Map<number, number>();
  let back = Infinity; // the back of the layer before, where it lies once apart
  for (const l of layers) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of parts) {
      if (p.layer !== l) continue;
      lo = Math.min(lo, p.zMin);
      hi = Math.max(hi, p.zMax);
    }
    const o = back === Infinity ? 0 : back - gap - hi;
    off.set(l, o);
    back = lo + o;
  }
  const mid = layers.length > 0 ? off.get(layers[Math.floor((layers.length - 1) / 2)]) ?? 0 : 0;
  return parts.map((p) => (off.get(p.layer) ?? 0) - mid);
}

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
  /** its slide along z when fully apart (eye frame; see rowSlides) */
  rowZ: number;
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
  /** how many parts the row slides were worked out for (they arrive one by one) */
  private rowFor = -1;
  private labels: LabelLayer | null = null;
  private outline: LiftOutline | null = null;
  private readonly cutWorld = new THREE.Plane(new THREE.Vector3(0, -1, 0), CUT_NONE);
  private readonly cutLocal = new THREE.Plane(new THREE.Vector3(0, -1, 0), CUT_NONE);
  private cutSides = false;
  /** building has started / finished (all models settled) */
  private loading = false;
  private settled = false;
  /** the sliced shader warm-up has finished (#125) */
  private warmed = false;
  private initTimer: ReturnType<typeof setTimeout> | null = null;
  /** an open has started (for MAX_WAIT_MS), the eye was open last frame, something is on the canvas */
  private sessionAt = 0;
  private wasOn = false;
  private drawn = false;
  private lastNow = 0;
  private vw = 0;
  private vh = 0;
  private dpr = 1;
  // the lift-out / put-away (liftOut.ts, as BoxRig.updateStage / ArmStage)
  private readonly lift = new Lift();
  private from: ScreenBox | null = null;
  /** it lifts out of a saved pill (no eye in view): the start does not follow an eye */
  private fromPill = false;
  private objectId: string | null = null;
  /** the parts list it came from (its saved pill, if it is put away with no eye in view) */
  private savedId: string | null = null;
  // view
  private yaw = 0;
  private yawV = 0;
  private pitch = 0;
  private pitchV = 0;
  private zoom = 1;
  private zoomV = 0;
  /** pan (store.modelPanX / modelPanY, stage sizes), eased */
  private panX = 0;
  private panXV = 0;
  private panY = 0;
  private panYV = 0;
  private drift = 0;
  private lastInput = 0;
  private seen = { yaw: 0, pitch: 0, explode: 0, step: null as number | null, hl: null as string | null };
  private eShown = 0;
  /** the explode amount drawn: eShown, held closed while it rises and closed as it is put away */
  private eView = 0;
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
    this.outline = new LiftOutline(labelHost);
    this.initTimer = setTimeout(() => {
      this.initTimer = null;
      void this.init();
    }, INIT_DELAY_MS);
    eyeStage.tick = this.tick;
    eyeStage.pickAt = this.pickAt;
    eyeStage.warm = () => this.warmed;
  }

  detach(): void {
    if (this.initTimer) clearTimeout(this.initTimer);
    this.initTimer = null;
    eyeStage.tick = () => undefined;
    eyeStage.pickAt = () => null;
    eyeStage.warm = () => false;
    setStageArrived('eye', false);
    this.outline?.dispose();
    this.outline = null;
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
    void this.warmUp();
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
              rowZ: 0,
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
   * #125: in slices (textures a few at a time, then per variant a compile that the browser runs in
   * parallel where it can, and one draw in the next slice), so the warm-up itself never stalls the
   * view. If the eye is opened meanwhile it stops, puts the materials back, and the open compiles.
   */
  private async warmUp(): Promise<void> {
    const r = this.renderer;
    if (!r) return;
    const t0 = performance.now();
    const mats = this.parts.flatMap((p) => p.mats);
    const busy = () => !this.host || this.renderer !== r || this.wasOn || !this.lift.done;
    const set = (side: THREE.Side | null, dim: boolean) => {
      for (const m of mats) {
        m.mat.side = side ?? m.baseSide;
        const d = dim && !m.transmissive;
        m.mat.transparent = d;
        m.mat.depthWrite = !d;
        m.mat.needsUpdate = true;
        m.dimmed = false;
      }
    };
    const frame = () => {
      this.resize();
      const ppu = Math.max(50, 0.3 * this.vh);
      Object.assign(this.camera, { left: -this.vw / 2 / ppu, right: this.vw / 2 / ppu, top: this.vh / 2 / ppu, bottom: -this.vh / 2 / ppu });
      this.camera.position.set(0, 0, 20);
      this.camera.updateProjectionMatrix();
    };
    try {
      const textures = new Set<THREE.Texture>();
      for (const m of mats) {
        for (const v of Object.values(m.mat as unknown as Record<string, unknown>)) if (v instanceof THREE.Texture) textures.add(v);
      }
      let k = 0;
      for (const t of textures) {
        if (k++ % 3 === 0) {
          await idleSlice();
          if (busy()) return;
        }
        r.initTexture(t);
      }
      const variants: [THREE.Side | null, boolean][] = [
        [null, false],
        [THREE.DoubleSide, false],
        [THREE.DoubleSide, true],
      ];
      for (const [side, dim] of variants) {
        await idleSlice();
        if (busy()) return;
        frame();
        set(side, dim);
        await r.compileAsync(this.scene, this.camera);
        await idleSlice();
        if (busy()) return;
        set(side, dim); // (nothing else touches them while the eye is closed)
        frame();
        r.render(this.scene, this.camera);
      }
      await idleSlice();
      if (busy()) return;
      set(null, false);
      this.cutSides = false;
      frame();
      r.render(this.scene, this.camera);
      r.clear();
      this.warmed = true;
      devLog(`Eye ready: ${this.parts.length} models, shaders compiled in ${Math.round(performance.now() - t0)} ms (sliced)`);
    } catch (e) {
      devLog(`Eye: shader warm-up failed (${errorText(e)}); it compiles on first open instead`, 'warn');
    } finally {
      if (!this.warmed && this.renderer === r) {
        // stopped (opened, or failed): as built, as an open expects
        set(null, false);
        this.cutSides = false;
      }
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
    const dpr = canvasDpr(); // #131
    if (vw === this.vw && vh === this.vh && dpr === this.dpr) return;
    this.vw = vw;
    this.vh = vh;
    this.dpr = dpr;
    this.renderer?.setPixelRatio(dpr);
    this.renderer?.setSize(vw, vh, false);
  }

  /** Explode slide of a part along the visual axis (eye frame z). */
  private slide(p: EyePart): number {
    return p.rowZ * this.eView;
  }

  /** Work out each part's slide when fully apart (once the parts have arrived; see rowSlides). */
  private layoutRow(): void {
    if (this.rowFor === this.parts.length) return;
    this.rowFor = this.parts.length;
    const z = rowSlides(this.parts.map((p) => ({ layer: p.layer, zMin: p.bounds.min.z, zMax: p.bounds.max.z })), ROW_GAP);
    this.parts.forEach((p, i) => (p.rowZ = z[i]));
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
    const dt = frameStep(now, this.lastNow); // at most MAX_STEP_S (#125)
    this.lastNow = now;
    this.resize();
    const w = this.vw;
    const h = this.vh;
    const s = useStore.getState();
    const on = isEyeTeardown(s.teardown);
    if (on && !this.wasOn) {
      // A new open (unless it is re-opened while still going away): start from the eye in view.
      if (this.lift.done) {
        this.from = null;
        this.objectId = null;
        this.drift = 0;
        this.zoom = s.modelZoom;
        this.zoomV = 0;
        this.panX = s.modelPanX;
        this.panY = s.modelPanY;
        this.panXV = this.panYV = 0;
        this.yaw = s.modelYaw;
        this.yawV = 0;
        this.pitch = s.modelPitch;
        this.pitchV = 0;
        this.eShown = 0;
        this.eView = 0;
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
    if (!on && this.lift.done) {
      // Nothing to show: clear once, then draw nothing.
      if (this.drawn) {
        this.drawn = false;
        setStageArrived('eye', false);
        this.outline?.update(null, 0, 0);
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
    if (on) {
      this.objectId = s.selectedObjectId ?? s.focusedObjectId ?? this.objectId;
      this.savedId = s.teardown?.object_id ?? this.savedId;
    }
    const mirror = this.objectId && /^eye-left\b/.test(this.objectId) ? -1 : 1;

    // Lift: out of the eye (or its saved pill) to the middle of the view, and back when put away.
    // It appears once its models are in (they are preloaded), at most MAX_WAIT_MS after the open.
    const box = this.objectBox();
    if (!this.from) {
      const saved = on ? reopenedSavedId(this.objectId) : null;
      this.fromPill = saved !== null;
      const start = saved !== null ? pillBox(saved) : box ?? { cx: w / 2, cy: h / 2, w: 0.08 * h, h: 0.08 * h };
      this.from = { cx: start.cx, cy: start.cy, w: start.w, h: start.h };
    }
    this.lift.update(dt, on, this.parts.length > 0 && (this.settled || now - this.sessionAt > MAX_WAIT_MS));
    // the start follows the eye for the first third of the lift; put away, the eye (or the pill)
    const goal = !on ? box ?? pillBox(this.savedId) : this.lift.follow && !this.fromPill ? box : null;
    if (goal) {
      const k = 1 - Math.exp(-dt * 12);
      this.from.cx += (goal.cx - this.from.cx) * k;
      this.from.cy += (goal.cy - this.from.cy) * k;
      this.from.w += (goal.w - this.from.w) * k;
      this.from.h += (goal.h - this.from.h) * k;
    }
    // L: 0 on the eye, 1 in the middle of the view (a little past it at the overshoot)
    const L = this.lift.pos;
    setStageArrived('eye', on && this.lift.arrived);
    this.outline?.update(this.from, this.lift.outlineDrawn, this.lift.outlineOpacity);

    // Store -> eye. Put away: it closes and keeps its last view.
    const step = on && s.teardown && s.activeStep !== null ? s.teardown.steps.find((x) => x.n === s.activeStep) : undefined;
    const hlIds = new Set<string>(on ? [...(step?.part_ids ?? []), ...(s.highlightedPartId ? [s.highlightedPartId] : [])] : []);
    // (0 = analysed, assembled): it opens only once the eye is up, and closes as it is put away (spreadK)
    const eTarget = on && this.lift.phase !== 'out' ? clamp01((s.explodeAmount - STAGE_MIN_EXPLODE) / (1 - STAGE_MIN_EXPLODE)) : 0;
    this.eShown += (eTarget - this.eShown) * (1 - Math.exp(-dt * 6));
    this.eView = this.eShown * this.lift.spreadK;
    const cutTarget = on ? Math.max(smoothstep(0, 0.25, this.eView), hlIds.size > 0 ? 1 : 0) : 0;
    this.cut += (cutTarget - this.cut) * (1 - Math.exp(-dt * 5));
    if (on) {
      const ty = this.targetYaw(s, now, dt, hlIds.size === 0);
      [this.yaw, this.yawV] = springStep(this.yaw, this.yawV, ty, TURN_OMEGA, dt);
      [this.pitch, this.pitchV] = springStep(this.pitch, this.pitchV, s.modelPitch, TURN_OMEGA, dt);
    }
    [this.zoom, this.zoomV] = springStep(this.zoom, this.zoomV, on ? s.modelZoom : 1, TURN_OMEGA, dt);
    [this.panX, this.panXV] = springStep(this.panX, this.panXV, on ? s.modelPanX : 0, TURN_OMEGA, dt);
    [this.panY, this.panYV] = springStep(this.panY, this.panYV, on ? s.modelPanY : 0, TURN_OMEGA, dt);

    // Pose: explode slides, pivot, orientation (lift: facing the wearer -> his view, plus the wearer's turning).
    this.layoutRow();
    for (const p of this.parts) p.holder.position.set(0, 0, this.slide(p));
    const pivot = this.pivot();
    this.offset.position.copy(pivot).multiplyScalar(-1);
    this.mirror.scale.set(mirror, 1, 1);
    const base = Q_ASSEMBLED.clone().slerp(Q_EXPLODED, smoothstep(0.05, 0.7, this.eView));
    // the angle travels on the lift's curve (held at the stage view past it)
    const lifted = Q_IDENTITY.clone().slerp(base, clamp01(L));
    const user = new THREE.Quaternion()
      .setFromAxisAngle(new THREE.Vector3(1, 0, 0), this.pitch)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw));
    this.turn.quaternion.copy(user).multiply(lifted);

    // Size and place: the eyeball fills the eye's box at the start of the glide; on stage it fits the
    // free area between the label columns, the title and the voice area, times the zoom.
    const side = Math.min(LABEL_SIDE_MAX_PX, w * LABEL_SIDE_FRAC);
    const availW = Math.max(100, w - 2 * side);
    const availH = Math.max(100, h - TOP_MARGIN - BOTTOM_MARGIN);
    const fit = this.fitPpu(base, pivot, mirror, availW, availH, h) * Math.max(0.05, this.zoom);
    const fromPpu = Math.max(4, Math.min(this.from.w, this.from.h * 1.6));
    this.ppu = fromPpu + (fit - fromPpu) * L;
    const sx = this.from.cx + (w / 2 + panPx(this.panX, h) - this.from.cx) * L;
    const sy = this.from.cy + (TOP_MARGIN + availH / 2 + panPx(this.panY, h) - this.from.cy) * L;
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
    const lit = Math.max(this.cut, smoothstep(0, 0.15, this.eView));
    this.updateMaterials(hlIds, dt, lit);

    if (this.renderer) {
      this.renderer.domElement.style.opacity = this.lift.opacity.toFixed(3);
      this.renderer.render(this.scene, cam);
      perfCount('eye');
    }
    this.updateLabels(on, hlIds, w, h);
  };

  private toScreen(v: THREE.Vector3, w: number, h: number): { x: number; y: number } {
    const p = v.project(this.camera);
    return { x: ((p.x + 1) / 2) * w, y: ((1 - p.y) / 2) * h };
  }

  private updateLabels(on: boolean, hlIds: Set<string>, w: number, h: number): void {
    if (!this.labels) return;
    const s = useStore.getState();
    const names = new Map<string, string>();
    if (on && s.teardown) for (const p of s.teardown.parts) names.set(p.id, sentenceCase(p.name));
    const base = on ? this.lift.opacity * this.lift.labels : 0;
    const all = smoothstep(LABEL_FROM, LABEL_FULL, this.eView);
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
      const a = this.toScreen(p.holder.localToWorld(v.copy(p.anchor)), w, h);
      const opacity = base * (highlighted ? 1 : hlIds.size > 0 ? all * 0.6 : all) * inView(a.x, a.y, w, h);
      if (opacity < 0.02) continue;
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
    if (this.lift.opacity < 0.5 || this.lift.pos < 0.9) return null;
    if (this.eView < PICK_MIN && this.cut < PICK_MIN) return null;
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
