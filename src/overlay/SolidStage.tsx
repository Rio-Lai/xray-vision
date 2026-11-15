/**
 * #124: a live object sketched as simple solids (a parts list with `layout: "solid"`, POST /api/sketch)
 * as the floating model on stage, in a small renderer of its own beside ArmStage.tsx and EyeStage.tsx.
 * The box rig skips these lists on stage (it still draws them in the hidden freeze and follow modes,
 * from the flat fields the server derives).
 *
 *  - Every part is a three.js primitive at its real size and place (size_mm, position_mm, axis): box and
 *    board as boxes, cylinder, tube as a hollow cylinder, sphere as an ellipsoid; the whole model is
 *    scaled uniformly to the stage, never stretched per part, so a bottle stands up with its cap on top.
 *  - Look: a soft grey-translucent physical material tinted by each part's colour, a fine edge line, a key
 *    and a fill light so the form reads against the dimmed camera view. The parts do not write depth and
 *    are drawn largest last, so what is nested inside (the water in a bottle, a drum in a cabinet) shows
 *    through its shell.
 *  - Explode (store.explodeAmount; 0.12, the "analyse" amount, = assembled with hairline gaps, 1 = apart):
 *    each part moves along its own direction by the distance worked out in solidLayout.ts (no two parts
 *    overlap at 1), outermost first, eased.
 *  - Highlight (accent tint, stronger edge; the others fade), a step's parts the same, labels and leader
 *    lines through LabelLayer, click to pick (the overlay asks `solidStage.pickAt`), the lift-out and
 *    put-away from liftOut.ts, free turning (store.modelYaw / modelPitch: a solid is not limited, see
 *    turnLimit.ts), zoom and pan from the store (eased), and a slow idle sway once nothing has touched it.
 *  - It appears only after one frame has been drawn with its solids at opacity 0 (their shaders are
 *    compiled then, never on a visible frame), and its lift and springs run on the clamped step (frameStep, #125).
 *  - Per frame it allocates nothing but the label list; everything is disposed when the parts list changes
 *    and when the overlay goes.
 */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { useStore } from '../state/store';
import type { AppState } from '../state/store';
import type { Teardown, TeardownPart } from '../../shared/teardown';
import { boxToView, errorText, getCoverMap } from '../camera/frame';
import { live } from '../detect/live';
import { devLog, setStatus } from '../hud/hudStore';
import { STAGE_MIN_EXPLODE, modelControl, panPx } from '../stage/modelControl';
import { smoothstep } from './explodeAnimator';
import { BOTTOM_MARGIN, LABEL_SIDE_FRAC, LABEL_SIDE_MAX_PX, STAGE_SIZE, STAGE_TURN_OMEGA, TOP_MARGIN } from './boxRig';
import type { ScreenBox } from './boxRig';
import { LabelLayer, inView } from './labels';
import type { LabelItem } from './labels';
import { Lift, LiftOutline, frameStep, pillBox } from './liftOut';
import { reopenedSavedId } from '../lib/flow';
import { springStep } from './stageLayout';
import { isSolidTeardown } from './stageState';
import { partProgress, solidLayout } from './solidLayout';
import type { SolidLayout } from './solidLayout';

const DEG = Math.PI / 180;
/** On stage it is seen a little from above and from the right: a three-quarter view that shows its depth. */
const VIEW_YAW = -28 * DEG;
const VIEW_PITCH = 16 * DEG;
/** Hairline gaps between touching parts when assembled, in longest sides of the object (shrunk, never more than 15% of a side). */
const HAIRLINE = 0.006;
/** Tube wall, as a share of its radius. */
const TUBE_WALL = 0.16;
const GREY = new THREE.Color('#c3c9d1');
const WHITE = new THREE.Color('#ffffff');
const ACCENT = new THREE.Color('#4DA3FF');
const NEUTRAL = '#9aa4ae';
/** How much of the part's own colour tints the grey. */
const TINT = 0.6;
const BODY_OPACITY = 0.42;
const EDGE_OPACITY = 0.55;
const DIM_TO = 0.3;
/** Idle sway, as the box model: after IDLE_MS without input, to and fro about the yaw asked for. */
const IDLE_MS = 4000;
const IDLE_SPIN = 0.12;
const IDLE_SWAY = 35 * DEG;
/** Labels for every part fade in between these normalised explode amounts. */
const LABEL_FROM = 0.35;
const LABEL_FULL = 0.75;
/** Picking needs it this far apart (as the eye). */
const PICK_MIN = 0.3;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** For the overlay: ticked every frame; which part is at a viewport point; whether it has arrived (the title). */
export const solidStage: { tick: (now: number) => void; pickAt: (x: number, y: number) => string | null; arrived: () => boolean } = {
  tick: () => undefined,
  pickAt: () => null,
  arrived: () => false,
};

/** What a parts list looks like on stage: rebuilt only when this changes (not when details arrive). */
function geometrySig(td: Teardown): string {
  return [
    td.object_id,
    ...td.parts.map((p) => `${p.id}:${p.shape}:${p.axis ?? ''}:${(p.size_mm ?? p.size).join('/')}:${(p.position_mm ?? p.offset).join('/')}:${p.color}`),
  ].join('|');
}

function safeColor(css: string): THREE.Color {
  const c = new THREE.Color(NEUTRAL);
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(css.trim())) c.set(css.trim());
  return c;
}

/** A unit-sized primitive (1 x 1 x 1 box round its centre) for a part, its long axis turned to `axis`. */
function partGeometry(part: TeardownPart): THREE.BufferGeometry {
  let geo: THREE.BufferGeometry;
  switch (part.shape) {
    case 'cylinder':
      geo = new THREE.CylinderGeometry(0.5, 0.5, 1, 40);
      break;
    case 'tube': {
      const ri = 0.5 * (1 - TUBE_WALL);
      const profile = [new THREE.Vector2(ri, -0.5), new THREE.Vector2(0.5, -0.5), new THREE.Vector2(0.5, 0.5), new THREE.Vector2(ri, 0.5), new THREE.Vector2(ri, -0.5)];
      geo = new THREE.LatheGeometry(profile, 40);
      break;
    }
    case 'sphere':
      geo = new THREE.SphereGeometry(0.5, 32, 20);
      break;
    default:
      return new THREE.BoxGeometry(1, 1, 1);
  }
  // cylinders and tubes are built along y
  if (part.axis === 'x') geo.rotateZ(Math.PI / 2);
  else if (part.axis === 'z') geo.rotateX(Math.PI / 2);
  return geo;
}

interface SolidPart {
  id: string;
  name: string;
  holder: THREE.Group;
  mesh: THREE.Mesh;
  edges: THREE.LineSegments | null;
  mat: THREE.MeshPhysicalMaterial;
  edgeMat: THREE.LineBasicMaterial;
  base: THREE.Color;
  /** assembled centre, size (shrunk by the hairline), direction and travel (mm) */
  c: THREE.Vector3;
  s: THREE.Vector3;
  dir: THREE.Vector3;
  t: number;
  start: number;
  hl: number;
  dim: number;
  label: LabelItem;
}

class SolidStageCtl {
  private host: HTMLDivElement | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private envTex: THREE.Texture | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 40000);
  /** turn (orientation) > offset (-pivot) > one holder per part (its explode travel) */
  private readonly turn = new THREE.Group();
  private readonly offset = new THREE.Group();
  private parts: SolidPart[] = [];
  private meshes: THREE.Object3D[] = [];
  private sig = '';
  /** one frame has been drawn with these solids at opacity 0, so their shaders are compiled before they show (#125) */
  private primed = false;
  private layout: SolidLayout | null = null;
  private labels: LabelLayer | null = null;
  private outline: LiftOutline | null = null;
  private readonly lift = new Lift();
  private from: ScreenBox | null = null;
  private fromPill = false;
  private objectId: string | null = null;
  private savedId: string | null = null;
  private wasOn = false;
  private drawn = false;
  private lastNow = 0;
  private vw = 0;
  private vh = 0;
  private dpr = 1;
  private yaw = 0;
  private yawV = 0;
  private pitch = 0;
  private pitchV = 0;
  private zoom = 1;
  private zoomV = 0;
  private panX = 0;
  private panXV = 0;
  private panY = 0;
  private panYV = 0;
  private drift = 0;
  private driftDir = 1;
  private lastInput = 0;
  private seenYaw = 0;
  private seenPitch = 0;
  private seenExplode = 0;
  private eShown = 0;
  private eView = 0;
  private ppu = 1;
  private items: LabelItem[] = [];
  // scratch (no allocation per frame)
  private readonly v = new THREE.Vector3();
  private readonly lo = new THREE.Vector3();
  private readonly hi = new THREE.Vector3();
  private readonly pivot = new THREE.Vector3();
  private readonly qView = new THREE.Quaternion();
  private readonly corner = new THREE.Vector3();
  private readonly eul = new THREE.Euler();
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();

  constructor() {
    this.scene.add(this.turn);
    this.turn.add(this.offset);
    // Fixed to the view: a soft ambient, a sky/ground fill, a key from the upper left and a cooler fill from the right.
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.45));
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a9099, 0.8));
    const key = new THREE.DirectionalLight(0xffffff, 1.7);
    key.position.set(-0.5, 1, 1.1);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xbfd6ff, 0.6);
    fill.position.set(1, 0.2, 0.6);
    this.scene.add(fill);
  }

  attach(host: HTMLDivElement, labelHost: HTMLDivElement): void {
    this.host = host;
    try {
      const r = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
      r.setClearColor(0x000000, 0);
      r.toneMapping = THREE.NeutralToneMapping;
      Object.assign(r.domElement.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', opacity: '0' });
      host.appendChild(r.domElement);
      this.renderer = r;
      try {
        const pmrem = new THREE.PMREMGenerator(r);
        this.envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
        this.scene.environment = this.envTex;
        pmrem.dispose();
      } catch (e) {
        devLog(`Solid model: no environment light: ${errorText(e)}`, 'warn');
      }
      setStatus('solid-webgl', null);
    } catch (e) {
      setStatus('solid-webgl', 'error', `WebGL unavailable, sketched objects cannot be drawn: ${errorText(e)}`);
    }
    this.labels = new LabelLayer(labelHost);
    this.outline = new LiftOutline(labelHost);
    solidStage.tick = this.tick;
    solidStage.pickAt = this.pickAt;
    solidStage.arrived = () => this.lift.arrived && this.wasOn;
  }

  detach(): void {
    solidStage.tick = () => undefined;
    solidStage.pickAt = () => null;
    solidStage.arrived = () => false;
    this.clearParts();
    this.outline?.dispose();
    this.outline = null;
    this.labels?.dispose();
    this.labels = null;
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

  private clearParts(): void {
    for (const p of this.parts) {
      p.mesh.geometry.dispose();
      p.mat.dispose();
      p.edges?.geometry.dispose();
      p.edgeMat.dispose();
    }
    this.offset.clear();
    this.parts = [];
    this.meshes = [];
    this.layout = null;
    this.sig = '';
    this.primed = false;
  }

  /** Build the solids for a parts list (once per list; details arriving later change nothing here). */
  private build(td: Teardown): void {
    this.clearParts();
    this.sig = geometrySig(td);
    const lay = solidLayout(td.parts);
    this.layout = lay;
    const hair = HAIRLINE * lay.maxDim;
    // largest last, so nested parts are drawn before the shell round them
    const vol = (i: number) => lay.parts[i].s[0] * lay.parts[i].s[1] * lay.parts[i].s[2];
    const rank = td.parts.map((_, i) => i).sort((a, b) => vol(b) - vol(a));
    td.parts.forEach((part, i) => {
      const L = lay.parts[i];
      const geo = partGeometry(part);
      const base = GREY.clone().lerp(safeColor(part.color), TINT);
      const mat = new THREE.MeshPhysicalMaterial({
        color: base.clone(),
        emissive: base.clone(),
        emissiveIntensity: 0.08,
        roughness: 0.42,
        metalness: 0,
        clearcoat: 0.35,
        clearcoatRoughness: 0.4,
        envMapIntensity: 0.7,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = 10 + (rank.length - rank.indexOf(i));
      const edgeMat = new THREE.LineBasicMaterial({ color: WHITE.clone(), transparent: true, opacity: 0, depthWrite: false });
      // A sphere has no edges worth drawing (a wire ellipsoid reads as sci-fi).
      const edges = part.shape === 'sphere' ? null : new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), edgeMat);
      if (edges) edges.renderOrder = 100 + mesh.renderOrder;
      const s = new THREE.Vector3(...L.s.map((v) => Math.max(0.5, v - Math.min(hair, 0.15 * v))));
      mesh.scale.copy(s);
      edges?.scale.copy(s);
      const holder = new THREE.Group();
      holder.userData.partId = part.id;
      mesh.userData.partId = part.id;
      holder.add(mesh);
      if (edges) holder.add(edges);
      this.offset.add(holder);
      this.parts.push({
        id: part.id,
        name: part.name,
        holder,
        mesh,
        edges,
        mat,
        edgeMat,
        base,
        c: new THREE.Vector3(...L.c),
        s,
        dir: new THREE.Vector3(...L.dir),
        t: L.t,
        start: L.start,
        hl: 0,
        dim: 0,
        label: { id: part.id, text: part.name, ax: 0, ay: 0, opacity: 0, highlighted: false },
      });
      this.meshes.push(mesh);
    });
    devLog(`Solid model: ${td.name}, ${td.parts.length} solids`);
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

  /** The viewport box of the object it came out of, if it is in view. */
  private objectBox(): ScreenBox | null {
    const obj = this.objectId ? live.objects.find((o) => o.id === this.objectId) : undefined;
    if (!obj) return null;
    const b = boxToView(getCoverMap(), obj.box);
    return { cx: b.x + b.w / 2, cy: b.y + b.h / 2, w: b.w, h: b.h };
  }

  /** Yaw asked for plus the idle sway (after IDLE_MS without input; any input, step or highlight stops it). */
  private targetYaw(s: AppState, now: number, dt: number, still: boolean): number {
    if (s.modelYaw !== this.seenYaw || s.modelPitch !== this.seenPitch || s.explodeAmount !== this.seenExplode || modelControl.lastInputAt > this.lastInput) {
      this.lastInput = Math.max(now, modelControl.lastInputAt);
      this.seenYaw = s.modelYaw;
      this.seenPitch = s.modelPitch;
      this.seenExplode = s.explodeAmount;
    }
    if (!still) this.lastInput = now;
    if (now - this.lastInput > IDLE_MS) {
      if (this.drift > IDLE_SWAY) this.driftDir = -1;
      else if (this.drift < -IDLE_SWAY) this.driftDir = 1;
      this.drift += this.driftDir * IDLE_SPIN * dt;
    }
    return s.modelYaw + this.drift;
  }

  tick = (now: number): void => {
    const dt = frameStep(now, this.lastNow); // at most MAX_STEP_S (#125)
    this.lastNow = now;
    const s = useStore.getState();
    const td = s.teardown;
    const on = s.trackingMode === 'stage' && isSolidTeardown(td);
    if (on && td && geometrySig(td) !== this.sig) {
      this.build(td);
      if (!this.lift.done) this.from = null; // a new object while the last one was still on: start again from it
    }
    if (on && !this.wasOn && this.lift.done) {
      // A new open: start from the object in view, facing the camera as the real one does.
      this.from = null;
      this.objectId = null;
      this.drift = 0;
      this.driftDir = 1;
      this.yaw = s.modelYaw;
      this.pitch = s.modelPitch;
      this.yawV = this.pitchV = 0;
      this.zoom = s.modelZoom;
      this.zoomV = 0;
      this.panX = s.modelPanX;
      this.panY = s.modelPanY;
      this.panXV = this.panYV = 0;
      this.eShown = this.eView = 0;
      this.lastInput = now;
      for (const p of this.parts) p.hl = p.dim = 0;
    }
    this.wasOn = on;
    if (!on && this.lift.done) {
      if (this.drawn) {
        this.drawn = false;
        this.outline?.update(null, 0, 0);
        if (this.renderer) {
          this.renderer.domElement.style.opacity = '0';
          this.renderer.clear();
        }
        this.labels?.clear();
        // put away and gone: free the GPU things (built again on the next open)
        if (!isSolidTeardown(td)) this.clearParts();
      }
      return;
    }
    if (this.parts.length === 0) return;
    this.drawn = true;
    this.resize();
    const w = this.vw;
    const h = this.vh;
    if (on) {
      this.objectId = s.selectedObjectId ?? s.focusedObjectId ?? this.objectId;
      this.savedId = td?.object_id ?? this.savedId;
    }

    // Lift: out of the object (or its saved pill) to the middle of the view, and back when put away.
    const box = this.objectBox();
    if (!this.from) {
      const saved = on ? reopenedSavedId(this.objectId) : null;
      this.fromPill = saved !== null;
      const start = saved !== null ? pillBox(saved) : box ?? { cx: w / 2, cy: h / 2, w: 0.2 * h, h: 0.3 * h };
      this.from = { cx: start.cx, cy: start.cy, w: start.w, h: start.h };
    }
    // it appears only once a frame has been drawn with its solids invisible (no shader compile on a visible frame)
    this.lift.update(dt, on, this.primed);
    const goal = !on ? box ?? pillBox(this.savedId) : this.lift.follow && !this.fromPill ? box : null;
    if (goal) {
      const k = 1 - Math.exp(-dt * 12);
      this.from.cx += (goal.cx - this.from.cx) * k;
      this.from.cy += (goal.cy - this.from.cy) * k;
      this.from.w += (goal.w - this.from.w) * k;
      this.from.h += (goal.h - this.from.h) * k;
    }
    const L = this.lift.pos;
    const L01 = clamp01(L);
    this.outline?.update(this.from, this.lift.outlineDrawn, this.lift.outlineOpacity);

    // Store -> model.
    const step = on && td && s.activeStep !== null ? td.steps.find((x) => x.n === s.activeStep) : undefined;
    const hlId = on ? s.highlightedPartId : null;
    const anyHl = hlId !== null || (step !== undefined && step.part_ids.length > 0);
    const eTarget = on && this.lift.phase !== 'out' ? clamp01((s.explodeAmount - STAGE_MIN_EXPLODE) / (1 - STAGE_MIN_EXPLODE)) : 0;
    this.eShown += (eTarget - this.eShown) * (1 - Math.exp(-dt * 5));
    this.eView = this.eShown * this.lift.spreadK;
    if (on) {
      [this.yaw, this.yawV] = springStep(this.yaw, this.yawV, this.targetYaw(s, now, dt, !anyHl), STAGE_TURN_OMEGA, dt);
      [this.pitch, this.pitchV] = springStep(this.pitch, this.pitchV, s.modelPitch, STAGE_TURN_OMEGA, dt);
    }
    [this.zoom, this.zoomV] = springStep(this.zoom, this.zoomV, on ? s.modelZoom : 1, STAGE_TURN_OMEGA, dt);
    [this.panX, this.panXV] = springStep(this.panX, this.panXV, on ? s.modelPanX : 0, STAGE_TURN_OMEGA, dt);
    [this.panY, this.panYV] = springStep(this.panY, this.panYV, on ? s.modelPanY : 0, STAGE_TURN_OMEGA, dt);

    // Parts: explode travel, and the bounds (mm) of where they are now, for the pivot and the fit.
    this.lo.set(Infinity, Infinity, Infinity);
    this.hi.set(-Infinity, -Infinity, -Infinity);
    for (const p of this.parts) {
      const k = partProgress(this.eView, p.start) * p.t;
      p.holder.position.copy(p.dir).multiplyScalar(k).add(p.c);
      this.v.copy(p.s).multiplyScalar(0.5);
      this.lo.min(this.corner.copy(p.holder.position).sub(this.v));
      this.hi.max(this.corner.copy(p.holder.position).add(this.v));
    }
    this.pivot.copy(this.lo).add(this.hi).multiplyScalar(0.5);
    this.offset.position.copy(this.pivot).multiplyScalar(-1);
    // radius round the pivot: the model fits whatever way it is turned, so its size does not breathe as it turns
    let reach = 1;
    for (const p of this.parts) {
      this.v.copy(p.holder.position).sub(this.pivot);
      reach = Math.max(reach, this.v.length() + 0.5 * p.s.length());
    }

    // Orientation: facing the camera on the object (as the real one is seen), the stage view plus the wearer's turning on stage.
    this.eul.set(VIEW_PITCH * L01 + this.pitch * L01, VIEW_YAW * L01 + this.yaw * L01, 0, 'XYZ');
    this.qView.setFromEuler(this.eul);
    this.turn.quaternion.copy(this.qView);

    // Size and place: the object's front view fills its box at the start; on stage it fits the free area, times the zoom.
    const side = Math.min(LABEL_SIDE_MAX_PX, w * LABEL_SIDE_FRAC);
    const availW = Math.max(100, w - 2 * side);
    const availH = Math.max(100, h - TOP_MARGIN - BOTTOM_MARGIN);
    const fit = (Math.min(STAGE_SIZE * h, availW, availH) / (2 * reach)) * Math.max(0.05, this.zoom);
    const fromPpu = Math.max(0.01, Math.min(this.from.w / Math.max(1, this.hi.x - this.lo.x), this.from.h / Math.max(1, this.hi.y - this.lo.y)));
    this.ppu = fromPpu + (fit - fromPpu) * L;
    const sx = this.from.cx + (w / 2 + panPx(this.panX, h) - this.from.cx) * L;
    const sy = this.from.cy + (TOP_MARGIN + availH / 2 + panPx(this.panY, h) - this.from.cy) * L;
    const cam = this.camera;
    cam.left = -w / 2 / this.ppu;
    cam.right = w / 2 / this.ppu;
    cam.top = h / 2 / this.ppu;
    cam.bottom = -h / 2 / this.ppu;
    cam.position.set((w / 2 - sx) / this.ppu, (sy - h / 2) / this.ppu, 20000);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    this.scene.updateMatrixWorld();

    // Materials: frosted tint, highlight (accent, stronger edge), the others fade while something is highlighted.
    const op = this.lift.opacity;
    const kHl = 1 - Math.exp(-dt * 10);
    for (const p of this.parts) {
      const isHl = p.id === hlId || (step !== undefined && step.part_ids.includes(p.id));
      p.hl += ((isHl ? 1 : 0) - p.hl) * kHl;
      p.dim += ((anyHl && !isHl ? 1 : 0) - p.dim) * kHl;
      const dimF = 1 - (1 - DIM_TO) * p.dim;
      p.mat.opacity = op * (BODY_OPACITY + (0.85 - BODY_OPACITY) * p.hl) * dimF;
      p.mat.color.copy(p.base).lerp(ACCENT, 0.35 * p.hl);
      p.mat.emissive.copy(p.base).lerp(ACCENT, 0.5 * p.hl);
      p.mat.emissiveIntensity = 0.08 + 0.3 * p.hl;
      p.edgeMat.color.copy(WHITE).lerp(ACCENT, p.hl);
      p.edgeMat.opacity = op * (EDGE_OPACITY + (1 - EDGE_OPACITY) * p.hl) * dimF;
      p.holder.visible = op > 0.004 || !this.primed;
    }

    if (this.renderer) {
      this.renderer.domElement.style.opacity = '1';
      this.renderer.render(this.scene, cam);
      this.primed = true;
    }
    this.updateLabels(on, w, h);
  };

  private toScreen(v: THREE.Vector3, w: number, h: number): void {
    v.project(this.camera);
    v.set(((v.x + 1) / 2) * w, ((1 - v.y) / 2) * h, 0);
  }

  private updateLabels(on: boolean, w: number, h: number): void {
    if (!this.labels) return;
    const base = on ? this.lift.opacity * this.lift.labels : 0;
    const all = smoothstep(LABEL_FROM, LABEL_FULL, this.eView);
    const items = this.items;
    items.length = 0;
    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    for (const p of this.parts) {
      p.holder.getWorldPosition(this.v);
      this.toScreen(this.v, w, h);
      const r = 0.5 * p.s.length() * this.ppu;
      left = Math.min(left, this.v.x - r);
      right = Math.max(right, this.v.x + r);
      top = Math.min(top, this.v.y - r);
      bottom = Math.max(bottom, this.v.y + r);
      const highlighted = p.hl > 0.5;
      const opacity = base * (highlighted ? 1 : p.dim > 0.5 ? all * 0.6 : all) * inView(this.v.x, this.v.y, w, h);
      if (opacity < 0.02) continue;
      const it = p.label;
      it.ax = this.v.x;
      it.ay = this.v.y;
      it.opacity = opacity;
      it.highlighted = highlighted;
      items.push(it);
    }
    if (!Number.isFinite(left)) {
      left = right = w / 2;
      top = bottom = h / 2;
    }
    this.labels.update(items, { left, right, top, bottom }, w, h);
  }

  /** Part under a viewport point, once it is up and apart enough. */
  pickAt = (x: number, y: number): string | null => {
    if (this.lift.opacity < 0.5 || this.lift.pos < 0.9 || this.eView < PICK_MIN) return null;
    this.ndc.set((x / this.vw) * 2 - 1, -(y / this.vh) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.meshes, false);
    // The parts are see-through: of those under the point, the smallest wins (the water, not the bottle round it).
    let best: string | null = null;
    let bestVol = Infinity;
    for (const hit of hits) {
      const pid = hit.object.userData.partId;
      const sc = hit.object.scale;
      const vol = sc.x * sc.y * sc.z;
      if (typeof pid === 'string' && vol < bestVol) {
        best = pid;
        bestVol = vol;
      }
    }
    return best;
  };
}

/** Mounted by the overlay for the whole session: draws a solid sketch while one is open on stage (and while it is put away). */
export function SolidStage() {
  const hostRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const [ctl] = useState(() => new SolidStageCtl());
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

export default SolidStage;
