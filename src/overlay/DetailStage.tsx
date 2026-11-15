/**
 * The detail model (`?detail=1` only; src/stage/Stage.tsx mounts this only with the flag): a small schematic
 * 3D model of one mechanism, material or process (store.detail, a DetailScene from shared/detail.ts), drawn
 * on the right half of the view while the main model sits smaller on the left (src/lib/detail.ts moves it),
 * or in the middle when nothing else is open. A glass card at the top right says what it is, always with
 * an "AI sketch" tag (it is AI-made and never checked; "Sample" for the ?detail=mock test fixture), and the
 * sentence of the step being explained.
 *
 *  - Same look as SolidStage.tsx: soft grey-translucent solids tinted by each part's colour, a fine edge
 *    line on the flat-sided shapes, soft key and fill lights, drawn largest last so what is inside shows.
 *  - Animations from the scene: spin (about a scene axis through the part's centre), slide (loop or yoyo),
 *    flow (dots moving along a path, e.g. electrons), pulse; a slow idle sway of the whole model.
 *  - The step's focus parts light up (accent tint, stronger edge); the others fade a little.
 *  - Its own canvas and its own animation frames, running only while a detail model is up or fading out;
 *    the canvas is sized to its area at most canvasDpr() (#131); nothing is drawn while the tab is hidden.
 *    Everything is disposed when the scene changes and when this unmounts.
 */
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import * as THREE from 'three';
import { useStore } from '../state/store';
import type { DetailPart, DetailScene, DetailShape } from '../../shared/detail';
import { flowEndScale, flowOffsets, pulseLevel, sceneBounds, slideFraction, spinAngle } from '../../shared/detail';
import { WIDE_DETAIL_SPLIT, isShortWide, phoneSafeArea } from '../phone/viewport';
import { canvasDpr, errorText } from '../camera/frame';
import { perfCount } from '../detect/live';
import { devLog, setStatus } from '../hud/hudStore';
import { DETAIL_MOCK } from '../lib/detail';

const DEG = Math.PI / 180;
const FOV = 30;
/** Seen a little from above and from the right, swaying slowly to and fro so its depth reads. */
const VIEW_PITCH = 14 * DEG;
const VIEW_YAW = -16 * DEG;
const SWAY = 20 * DEG;
const SWAY_PERIOD_S = 18;
const GREY = new THREE.Color('#c3c9d1');
const WHITE = new THREE.Color('#ffffff');
const ACCENT = new THREE.Color('#4DA3FF');
const NEUTRAL = '#9aa4ae';
/** How much of the part's own colour shows through the grey (more than SolidStage: colour tells the parts apart here). */
const TINT = 0.78;
const TUBE_WALL = 0.16;
const EDGE_OPACITY = 0.32;
/** Unfocused parts fade to this share while a step lights others. */
const DIM_TO = 0.4;
/** Fade in and out (1/s). */
const APPEAR_RATE = 7;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function safeColor(css: string): THREE.Color {
  const c = new THREE.Color(NEUTRAL);
  if (/^#[0-9a-f]{6}$/i.test(css.trim())) c.set(css.trim());
  return c;
}

/** A primitive for a part and the scale that makes it fill the part's size (cylinders, tubes, capsules and cones along y). */
function partGeometry(part: DetailPart): { geo: THREE.BufferGeometry; scale: THREE.Vector3 } {
  const [sx, sy, sz] = part.size;
  const unit = (geo: THREE.BufferGeometry) => ({ geo, scale: new THREE.Vector3(sx, sy, sz) });
  const shape: DetailShape = part.shape;
  switch (shape) {
    case 'cylinder':
      return unit(new THREE.CylinderGeometry(0.5, 0.5, 1, 36));
    case 'tube': {
      const ri = 0.5 * (1 - TUBE_WALL);
      const profile = [new THREE.Vector2(ri, -0.5), new THREE.Vector2(0.5, -0.5), new THREE.Vector2(0.5, 0.5), new THREE.Vector2(ri, 0.5), new THREE.Vector2(ri, -0.5)];
      return unit(new THREE.LatheGeometry(profile, 36));
    }
    case 'sphere':
      return unit(new THREE.SphereGeometry(0.5, 28, 18));
    case 'cone':
      return unit(new THREE.ConeGeometry(0.5, 1, 36));
    case 'torus': {
      // a ring in the x-y plane filling a unit box (z = the ring's thickness)
      const geo = new THREE.TorusGeometry(0.4, 0.1, 16, 48);
      geo.scale(1, 1, 5);
      return unit(geo);
    }
    case 'capsule': {
      // built at its real proportions (round ends stay round), then stretched across only
      const r = Math.max(0.005, Math.min(sx, sz) / 2);
      const geo = new THREE.CapsuleGeometry(r, Math.max(0, sy - 2 * r), 6, 20);
      return { geo, scale: new THREE.Vector3(sx / (2 * r), 1, sz / (2 * r)) };
    }
    default:
      // box and sheet (a sheet is a box with one very thin side)
      return unit(new THREE.BoxGeometry(1, 1, 1));
  }
}

const HAS_EDGES: Record<DetailShape, boolean> = { box: true, sheet: true, cylinder: true, tube: true, cone: true, sphere: false, capsule: false, torus: false };

interface PartView {
  id: string;
  /** position (and slide) > spin about a scene axis > the part's own rotation and pulse > mesh and edges at its size */
  holder: THREE.Group;
  spinner: THREE.Group;
  body: THREE.Group;
  mesh: THREE.Mesh;
  mat: THREE.MeshStandardMaterial;
  edges: THREE.LineSegments | null;
  edgeMat: THREE.LineBasicMaterial;
  base: THREE.Color;
  opacity: number;
  /** its place in the scene (a slide moves it from there) */
  rest: THREE.Vector3;
  /** this frame's pulse level, 0..1 */
  glow: number;
  hl: number;
  dim: number;
}

interface FlowView {
  curve: THREE.CatmullRomCurve3;
  length: number;
  closed: boolean;
  mesh: THREE.InstancedMesh;
  mat: THREE.MeshBasicMaterial;
  count: number;
  speed: number;
  size: number;
  offsets: number[];
}

interface Area {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where the model is drawn. Laptop: the right half of the view beside a model on stage, else the middle; below
 * the card's top edge. Phone mode (sideways about 1400 x 646, src/phone/viewport.ts): the right 45 percent (the
 * main model has the left 55, src/lib/detail.ts), inside the safe area, between the compact card at the top and
 * the captions at the bottom.
 */
function detailArea(beside: boolean, vw: number, vh: number): Area {
  if (isShortWide(vw, vh)) {
    const right = Math.round(Math.max(24, phoneSafeArea().right) + 8);
    // below the compact card (about 120 px from the top) and above the voice pill and captions
    const y = Math.max(Math.round(vh * 0.2), 146);
    const h = Math.max(1, Math.round(vh * 0.81) - y);
    const x = Math.round(vw * (beside ? WIDE_DETAIL_SPLIT : 0.2));
    const w = Math.max(1, (beside ? vw - right : Math.round(vw * 0.8)) - x);
    return { x, y, w, h };
  }
  return beside
    ? { x: Math.round(vw * 0.5), y: Math.round(vh * 0.14), w: Math.round(vw * 0.5 - 24), h: Math.round(vh * 0.74) }
    : { x: Math.round(vw * 0.2), y: Math.round(vh * 0.12), w: Math.round(vw * 0.6), h: Math.round(vh * 0.76) };
}

class DetailView {
  private host: HTMLDivElement | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private readonly scene3 = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 100);
  /** turn (view angle and sway) > centre (-bounds centre) > parts, paths and dots */
  private readonly turn = new THREE.Group();
  private readonly centre = new THREE.Group();
  private scene: DetailScene | null = null;
  private parts: PartView[] = [];
  private byId = new Map<string, PartView>();
  private flows: FlowView[] = [];
  private lines: { line: THREE.Line; mat: THREE.LineBasicMaterial }[] = [];
  private radius = 1;
  private appear = 0;
  private t0 = 0;
  private lastNow = 0;
  private raf = 0;
  private running = false;
  private drawn = false;
  private unsub: (() => void) | null = null;
  private area: Area = { x: 0, y: 0, w: 0, h: 0 };
  private dpr = 1;
  private stepSeen: number | null = -1;
  private focus = new Set<string>();
  // scratch (no allocation per frame)
  private readonly v = new THREE.Vector3();
  private readonly m4 = new THREE.Matrix4();
  private readonly tmpColor = new THREE.Color();

  constructor() {
    this.scene3.add(this.turn);
    this.turn.add(this.centre);
    this.scene3.add(new THREE.AmbientLight(0xffffff, 0.35));
    this.scene3.add(new THREE.HemisphereLight(0xffffff, 0x707680, 1.0));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(-1, 1.4, 2);
    this.scene3.add(key);
    const fill = new THREE.DirectionalLight(0xbfd6ff, 0.5);
    fill.position.set(1.2, 0.2, 1);
    this.scene3.add(fill);
  }

  attach(host: HTMLDivElement): void {
    this.host = host;
    try {
      const r = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
      r.setClearColor(0x000000, 0);
      r.toneMapping = THREE.NeutralToneMapping;
      Object.assign(r.domElement.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none' });
      host.appendChild(r.domElement);
      this.renderer = r;
      setStatus('detail-webgl', null);
    } catch (e) {
      setStatus('detail-webgl', 'error', `WebGL unavailable, detail models cannot be drawn: ${errorText(e)}`);
    }
    this.unsub = useStore.subscribe((s) => {
      if (s.detail) this.start();
    });
    if (useStore.getState().detail) this.start();
  }

  detach(): void {
    this.unsub?.();
    this.unsub = null;
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.clearScene();
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.forceContextLoss();
      this.renderer.domElement.remove();
      this.renderer = null;
    }
    this.host = null;
  }

  private start(): void {
    if (this.running || !this.renderer) return;
    this.running = true;
    this.lastNow = 0;
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number): void => {
    this.raf = 0;
    if (!this.running) return;
    let keep = true;
    try {
      keep = this.tick(now);
      setStatus('detail', null);
    } catch (e) {
      setStatus('detail', 'error', `Detail model error: ${errorText(e)}`);
    }
    if (keep && this.running) this.raf = requestAnimationFrame(this.frame);
    else this.running = false;
  };

  private clearScene(): void {
    for (const p of this.parts) {
      p.mesh.geometry.dispose();
      p.mat.dispose();
      p.edges?.geometry.dispose();
      p.edgeMat.dispose();
    }
    for (const f of this.flows) {
      f.mesh.geometry.dispose();
      f.mat.dispose();
      f.mesh.dispose();
    }
    for (const l of this.lines) {
      l.line.geometry.dispose();
      l.mat.dispose();
    }
    this.centre.clear();
    this.parts = [];
    this.byId.clear();
    this.flows = [];
    this.lines = [];
    this.scene = null;
    this.stepSeen = -1;
    this.focus.clear();
  }

  private build(sc: DetailScene): void {
    this.clearScene();
    this.scene = sc;
    const { lo, hi } = sceneBounds(sc);
    this.centre.position.set(-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, -(lo[2] + hi[2]) / 2);
    this.radius = Math.max(0.2, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2);
    // largest last, so what is inside is drawn before the shell round it
    const vol = (p: DetailPart) => p.size[0] * p.size[1] * p.size[2];
    const rank = sc.parts.map((_, i) => i).sort((a, b) => vol(sc.parts[b]) - vol(sc.parts[a]));
    sc.parts.forEach((part, i) => {
      const { geo, scale } = partGeometry(part);
      const base = GREY.clone().lerp(safeColor(part.color), TINT);
      const mat = new THREE.MeshStandardMaterial({
        color: base.clone(),
        emissive: new THREE.Color(0x000000),
        roughness: 0.5,
        metalness: 0.05,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.scale.copy(scale);
      mesh.renderOrder = 10 + (rank.length - rank.indexOf(i));
      const edgeMat = new THREE.LineBasicMaterial({ color: WHITE.clone(), transparent: true, opacity: 0, depthWrite: false });
      const edges = HAS_EDGES[part.shape] ? new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), edgeMat) : null;
      if (edges) {
        edges.scale.copy(scale);
        edges.renderOrder = 100 + mesh.renderOrder;
      }
      const body = new THREE.Group();
      body.rotation.set(part.rotation[0] * DEG, part.rotation[1] * DEG, part.rotation[2] * DEG, 'XYZ');
      body.add(mesh);
      if (edges) body.add(edges);
      const spinner = new THREE.Group();
      spinner.add(body);
      const holder = new THREE.Group();
      holder.position.set(...part.position);
      holder.add(spinner);
      this.centre.add(holder);
      const rest = new THREE.Vector3(part.position[0], part.position[1], part.position[2]);
      const view: PartView = { id: part.id, holder, spinner, body, mesh, mat, edges, edgeMat, base, opacity: part.opacity, rest, glow: 0, hl: 0, dim: 0 };
      this.parts.push(view);
      this.byId.set(part.id, view);
    });
    const curves = new Map<string, { curve: THREE.CatmullRomCurve3; closed: boolean }>();
    for (const path of sc.paths) {
      const closed = path.closed === true;
      // low tension: nearly straight between points, with soft corners
      const curve = new THREE.CatmullRomCurve3(path.points.map((p) => new THREE.Vector3(p[0], p[1], p[2])), closed, 'catmullrom', 0.25);
      curves.set(path.id, { curve, closed });
      const mat = new THREE.LineBasicMaterial({ color: WHITE.clone(), transparent: true, opacity: 0, depthWrite: false });
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getSpacedPoints(96)), mat);
      line.renderOrder = 400;
      this.centre.add(line);
      this.lines.push({ line, mat });
    }
    for (const a of sc.animations) {
      if (a.kind !== 'flow') continue;
      const c = curves.get(a.path);
      if (!c) continue;
      const mat = new THREE.MeshBasicMaterial({ color: safeColor(a.color), transparent: true, opacity: 0, depthWrite: false });
      const mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.5, 12, 8), mat, a.count);
      mesh.renderOrder = 500;
      mesh.frustumCulled = false;
      this.centre.add(mesh);
      this.flows.push({ curve: c.curve, length: Math.max(1e-3, c.curve.getLength()), closed: c.closed, mesh, mat, count: a.count, speed: a.speed, size: a.size, offsets: [] });
    }
    devLog(`Detail model: ${sc.title}, ${sc.parts.length} parts, ${sc.paths.length} paths, ${sc.animations.length} animations`);
  }

  /** Right half of the view beside a model on stage, else the middle (phone mode: detailArea). */
  private layout(beside: boolean): void {
    const vw = Math.max(1, window.innerWidth);
    const vh = Math.max(1, window.innerHeight);
    const a: Area = detailArea(beside, vw, vh);
    const dpr = canvasDpr();
    if (a.x !== this.area.x || a.y !== this.area.y || a.w !== this.area.w || a.h !== this.area.h || dpr !== this.dpr) {
      this.area = a;
      this.dpr = dpr;
      if (this.host) Object.assign(this.host.style, { left: `${a.x}px`, top: `${a.y}px`, width: `${a.w}px`, height: `${a.h}px` });
      this.renderer?.setPixelRatio(dpr);
      this.renderer?.setSize(Math.max(1, a.w), Math.max(1, a.h), false);
    }
    // fit the whole model whichever way it sways
    const aspect = Math.max(0.1, a.w / Math.max(1, a.h));
    const vfov = FOV * DEG;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
    const dist = (this.radius / Math.sin(Math.min(vfov, hfov) / 2)) * 1.06;
    this.camera.aspect = aspect;
    this.camera.near = Math.max(0.01, dist - this.radius * 3);
    this.camera.far = dist + this.radius * 3;
    this.camera.position.set(0, 0, dist);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();
  }

  private hide(): void {
    if (!this.drawn) return;
    this.drawn = false;
    if (this.renderer) {
      this.renderer.clear();
      this.renderer.domElement.style.opacity = '0';
    }
    if (this.host) this.host.style.opacity = '0';
  }

  /** One frame. false = nothing left to draw: the frames stop until a detail model comes up again. */
  private tick(now: number): boolean {
    const dt = this.lastNow ? Math.min(1 / 20, Math.max(0, (now - this.lastNow) / 1000)) : 1 / 60;
    this.lastNow = now;
    const s = useStore.getState();
    const want = s.detail;
    if (want && want !== this.scene) {
      this.build(want);
      this.appear = 0;
      this.t0 = now;
    }
    this.appear += ((want ? 1 : 0) - this.appear) * (1 - Math.exp(-dt * APPEAR_RATE));
    if (!want && this.appear < 0.01) {
      this.appear = 0;
      this.hide();
      this.clearScene();
      return false;
    }
    if (!this.renderer || !this.scene || document.hidden) return true;
    this.layout(s.teardown !== null);
    const t = (now - this.t0) / 1000;
    this.animate(t, dt, s.detailStep);
    if (this.host) this.host.style.opacity = String(clamp01(this.appear));
    this.renderer.domElement.style.opacity = '1';
    this.renderer.render(this.scene3, this.camera);
    this.drawn = true;
    perfCount('detail');
    return true;
  }

  private animate(t: number, dt: number, step: number | null): void {
    const sc = this.scene;
    if (!sc) return;
    const shown = this.appear;
    this.turn.rotation.set(VIEW_PITCH, VIEW_YAW + SWAY * Math.sin((2 * Math.PI * t) / SWAY_PERIOD_S), 0, 'XYZ');
    this.turn.scale.setScalar(0.92 + 0.08 * shown);

    if (step !== this.stepSeen) {
      this.stepSeen = step;
      this.focus = new Set(step !== null ? sc.steps[step - 1]?.focus ?? [] : []);
    }
    const anyFocus = this.focus.size > 0;

    // rest pose, then the animations on top
    for (const p of this.parts) {
      p.holder.position.copy(p.rest);
      p.spinner.rotation.set(0, 0, 0);
      p.body.scale.setScalar(1);
      p.glow = 0;
    }
    let fi = 0;
    for (const a of sc.animations) {
      if (a.kind === 'flow') {
        const f = this.flows[fi++];
        if (!f) continue;
        flowOffsets(t, f.count, f.speed, f.length, f.offsets);
        for (let i = 0; i < f.count; i++) {
          const u = f.offsets[i];
          f.curve.getPointAt(u, this.v);
          const k = Math.max(1e-4, f.size * flowEndScale(u, f.closed));
          this.m4.makeScale(k, k, k).setPosition(this.v);
          f.mesh.setMatrixAt(i, this.m4);
        }
        f.mesh.instanceMatrix.needsUpdate = true;
        f.mat.opacity = 0.95 * shown;
        continue;
      }
      const p = this.byId.get(a.part);
      if (!p) continue;
      if (a.kind === 'spin') p.spinner.rotation[a.axis] = spinAngle(t, a.rpm);
      else if (a.kind === 'slide') {
        const k = slideFraction(t, a.seconds, a.mode);
        p.holder.position.set(a.from[0] + (a.to[0] - a.from[0]) * k, a.from[1] + (a.to[1] - a.from[1]) * k, a.from[2] + (a.to[2] - a.from[2]) * k);
      } else if (a.kind === 'pulse') {
        const level = pulseLevel(t, a.seconds);
        p.body.scale.setScalar(1 + 0.06 * level);
        p.glow = level;
      }
    }

    // focus, fade and glow
    const k = 1 - Math.exp(-dt * 8);
    for (const p of this.parts) {
      const isFocus = this.focus.has(p.id);
      p.hl += ((isFocus ? 1 : 0) - p.hl) * k;
      p.dim += ((anyFocus && !isFocus ? 1 : 0) - p.dim) * k;
      const dimF = 1 - (1 - DIM_TO) * p.dim;
      const lit = Math.min(1, p.opacity + 0.3);
      p.mat.opacity = shown * (p.opacity + (lit - p.opacity) * p.hl) * dimF;
      p.mat.color.copy(p.base).lerp(ACCENT, 0.3 * p.hl);
      p.mat.emissive.copy(p.base).multiplyScalar(0.45 * p.glow).add(this.tmpColor.copy(ACCENT).multiplyScalar(0.4 * p.hl));
      p.edgeMat.color.copy(WHITE).lerp(ACCENT, p.hl);
      p.edgeMat.opacity = shown * (EDGE_OPACITY + (0.9 - EDGE_OPACITY) * p.hl) * dimF;
    }
    for (const l of this.lines) l.mat.opacity = 0.28 * shown;
  }
}

/* ---------- the card ---------- */

const CARD: CSSProperties = {
  position: 'absolute',
  top: 32,
  right: 32,
  width: 'min(420px, 40vw)',
  boxSizing: 'border-box',
  padding: '18px 22px 20px',
  borderRadius: 22,
  color: '#fff',
  background: 'var(--bf-color-glass-strong, rgba(16, 19, 24, 0.78))',
  border: '1px solid var(--bf-color-border, rgba(255, 255, 255, 0.16))',
  boxShadow: '0 12px 40px rgba(0, 0, 0, 0.28)',
  WebkitBackdropFilter: 'blur(24px) saturate(140%)',
  backdropFilter: 'blur(24px) saturate(140%)',
  fontFamily: 'system-ui, -apple-system, "SF Pro Text", Inter, sans-serif',
  pointerEvents: 'none',
};
const CHIP: CSSProperties = {
  display: 'inline-block',
  padding: '3px 10px',
  borderRadius: 999,
  background: 'rgba(255, 255, 255, 0.12)',
  color: 'rgba(255, 255, 255, 0.78)',
  fontSize: 16,
  lineHeight: 1.3,
};
const TITLE: CSSProperties = { margin: '10px 0 6px', fontSize: 20, lineHeight: 1.25, fontWeight: 600 };
const BODY: CSSProperties = { margin: 0, fontSize: 18, lineHeight: 1.4, color: 'rgba(255, 255, 255, 0.9)' };
const MUTED: CSSProperties = { margin: '8px 0 0', fontSize: 16, lineHeight: 1.35, color: 'rgba(255, 255, 255, 0.62)' };

/*
 * Phone mode (detailArea): a compact card at the top right, clear of the settings gear (--bf-phone-* come from
 * src/phone/PhoneApp.tsx): the tag and the step marks, the title on one line, the step's sentence (or the summary)
 * on at most two; no part names, no caveat (the tag says it).
 */
const CARD_WIDE: CSSProperties = {
  ...CARD,
  top: 'var(--bf-phone-top, 24px)',
  right: 'calc(var(--bf-phone-right, 24px) + var(--bf-phone-gear, 0px) + 4px)',
  width: 'min(380px, 30vw)',
  padding: '10px 14px 12px',
  borderRadius: 16,
};
const CHIP_WIDE: CSSProperties = { ...CHIP, padding: '2px 8px', fontSize: 15 };
const TITLE_WIDE: CSSProperties = { ...TITLE, margin: '6px 0 4px', fontSize: 17, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const BODY_WIDE: CSSProperties = {
  ...BODY,
  fontSize: 16,
  lineHeight: 1.35,
  display: '-webkit-box',
  WebkitBoxOrient: 'vertical',
  WebkitLineClamp: 2,
  overflow: 'hidden',
};


function DetailCard() {
  const detail = useStore((s) => s.detail);
  const status = useStore((s) => s.detailStatus);
  const topic = useStore((s) => s.detailTopic);
  const error = useStore((s) => s.detailError);
  const step = useStore((s) => s.detailStep);
  // phone mode only (a constant): the laptop always gets the laptop card
  const wide = isShortWide(window.innerWidth, window.innerHeight);
  if (status === 'idle') return null;
  const title = wide ? TITLE_WIDE : TITLE;
  const body = wide ? BODY_WIDE : BODY;
  const short = (topic ?? '').length > 60 ? `${(topic ?? '').slice(0, 58).trim()}…` : topic ?? '';
  const current = detail && step !== null ? detail.steps[step - 1] : undefined;
  const names = current && detail ? current.focus.map((id) => detail.parts.find((p) => p.id === id)?.name).filter((n): n is string => Boolean(n)) : [];
  return (
    <section style={wide ? CARD_WIDE : CARD} className="bf-enter bf-detail-card" data-bf-avoid key={detail?.title ?? `loading-${topic ?? ''}`}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {/* AI-made, never checked; the ?detail=mock fixture is hand-written: "Sample" (while loading, what is coming) */}
        <span style={wide ? CHIP_WIDE : CHIP}>{(detail ? detail.source === 'sample' : DETAIL_MOCK) ? 'Sample' : 'AI sketch'}</span>
        {detail && (
          <span style={{ display: 'flex', gap: 4, flex: 1 }} aria-hidden="true">
            {detail.steps.map((_, i) => (
              <span key={i} style={{ height: 4, flex: 1, borderRadius: 999, background: step === i + 1 ? '#4DA3FF' : 'rgba(255, 255, 255, 0.14)' }} />
            ))}
          </span>
        )}
      </div>
      {status === 'loading' && <h2 style={title}>Building a model of {short}…</h2>}
      {status === 'error' && (
        <>
          <h2 style={title}>{short || 'Detail'}</h2>
          <p style={body}>{error}</p>
        </>
      )}
      {status === 'ready' && detail && (
        <>
          <h2 style={title}>{detail.title}</h2>
          <p style={body}>{current ? current.say : detail.summary}</p>
          {!wide && names.length > 0 && <p style={MUTED}>{names.join(' · ')}</p>}
          {!wide && detail.caveat && !current && <p style={MUTED}>{detail.caveat}</p>}
        </>
      )}
    </section>
  );
}

/** Mounted by Stage.tsx only with `?detail=1`: the detail model's canvas (it places itself) and its card. */
export function DetailStage() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [view] = useState(() => new DetailView());
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    view.attach(host);
    return () => view.detach();
  }, [view]);
  return (
    <>
      <div
        ref={hostRef}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: 0,
          height: 0,
          opacity: 0,
          pointerEvents: 'none',
          // a soft dark pool behind it, so the translucent parts read over a bright camera view
          background: 'radial-gradient(closest-side, rgba(8, 10, 14, 0.42), rgba(8, 10, 14, 0))',
        }}
      />
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        <DetailCard />
      </div>
    </>
  );
}

export default DetailStage;
