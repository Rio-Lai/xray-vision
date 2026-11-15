/**
 * The overlay: one transparent three.js canvas over the video (orthographic camera in viewport
 * pixels, DPR capped at MAX_DPR, 1.5 unless `?dpr=`, #131), the part label layer, and the object
 * label layer (live view, pure DOM, so it still works when WebGL does not). Stage calls tick(now)
 * once per animation frame, and pick(x, y) on clicks. With nothing of its own to show (#131) its
 * canvas is cleared once and hidden, and not drawn until there is something again.
 *
 * Stage mode (the default): the box rig lifts the model out of the object and floats it in the
 * middle of the view, turned by store.modelYaw / modelPitch, plus a very slow idle drift once
 * nothing has touched it for IDLE_MS. Its models are flat: the drift sways it to and fro about the
 * face it shows, and its yaw never goes past FLAT_YAW_LIMIT (src/stage/turnLimit.ts, #107).
 * The lift-out and put-away (#109) are liftOut.ts: an accent outline draws round the object (drawn
 * here for the box rig), the model appears over it and rises to the middle; "put it away" (reset)
 * glides it back into its object, or into its saved pill (top left) when the object has gone.
 * A hand on stage is Kash's 3D arm (flow.ts swaps in its parts list, src/stage/armTeardown.ts):
 * ArmStage.tsx draws it in the middle of the view with its own renderer and labels, while the
 * landmark-drawn tendons keep following the real hand here (the live preview, lit by key presses).
 * An eye on stage is Kash's procedural eye (#94), drawn by EyeStage.tsx in its own frame (never
 * through the box rig, which would stretch each of its nested parts).
 * Any other hand teardown goes on stage like a box once its parts have models (mesh_url); without
 * models a hand is drawn on the real hand only.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { useStore } from '../state/store';
import type { AppState } from '../state/store';
import type { Teardown } from '../../shared/teardown';
import { DEMO_IDENTIFY } from '../../shared/demo';
import { boxToView, canvasDpr, errorText, getCoverMap, urlFlag } from '../camera/frame';
import { live, perfCount, perfDraw } from '../detect/live';
import { devLog, setHoldFrozen, setStageArrived, setStatus, useHud } from '../hud/hudStore';
import { pickPart, reopenedSavedId } from '../lib/flow';
import { BoxRig } from './boxRig';
import type { ScreenBox } from './boxRig';
import { HandRig } from './handRig';
import { LabelLayer } from './labels';
import { LiftOutline, OpenMeter, frameStep, pillBox } from './liftOut';
import type { LabelItem, StackBounds } from './labels';
import { ObjectLabelLayer } from './objectLabels';
import { GlbWarmer, idleSlice, preloadTeardownMeshes } from './glbCache';
import { armMeshesPreloaded, preloadArmMeshes } from '../biology/arm/ArmXray';
import { modelControl } from '../stage/modelControl';
import { FLAT_YAW_LIMIT, faceNear, faceOf, stageYawOffset } from '../stage/turnLimit';
import { gestureLive } from '../detect/gestureDriver';
import type { GestureMark } from '../detect/gestures';
import { HandCueLayer } from './pinchDots';
import { hasPartMeshes, isSolidTeardown } from './stageState';
import { SolidStage, solidStage } from './SolidStage';
import { ArmStage, armStage } from './ArmStage';
import { isArmTeardown } from '../stage/armTeardown';
import { EyeStage, eyeStage } from './EyeStage';
import { isEyeTeardown } from '../stage/eyeTeardown';

const DWELL_MS = 1200;
/**
 * Gaze dwell (look at a part for DWELL_MS to pick it) is OFF unless `?dwell=1`: in freeze mode the
 * stack does not move with the head, so the part at the screen centre would be picked (and the
 * tutor asked about it) by itself a second after every explode.
 */
const DWELL_ENABLED = urlFlag('dwell');
/**
 * Warm the stored models (#125) this long after start, once camera frames are flowing (something
 * detected or the detector timed), or at the latest after WARM_LATEST_MS; only while the tab is visible.
 */
const PRELOAD_DELAY_MS = 2500;
const WARM_LATEST_MS = 10000;
/** Stage: the model starts turning slowly by itself after this long without any input... */
const IDLE_MS = 4000;
/** ...at this speed (rad/s)... */
const IDLE_SPIN = 0.1;
/** ...to and fro, up to this far either side of the face it shows (radians). */
const IDLE_SWAY = (35 * Math.PI) / 180;

function teardownSignature(td: Teardown): string {
  return [
    td.object_id,
    td.anchor,
    td.explode_axis,
    ...td.parts.map((p) => `${p.id}:${p.layer}:${p.shape}:${p.size.join('/')}:${p.offset.join('/')}:${p.color}`),
  ].join('|');
}

/**
 * Whether the teardown gets the box rig: every non-hand teardown but the eye; a hand only on stage with models (not the arm);
 * a solid sketch (#124) only in the freeze and follow modes (on stage SolidStage.tsx draws it).
 */
function wantsBoxRig(td: Teardown | null, s: AppState): boolean {
  if (!td || isArmTeardown(td) || isEyeTeardown(td)) return false;
  if (isSolidTeardown(td)) return s.trackingMode !== 'stage';
  if (td.anchor !== 'hand') return true;
  return s.trackingMode === 'stage' && hasPartMeshes(td);
}

function highlightSet(s: AppState): Set<string> {
  const ids = new Set<string>();
  if (s.highlightedPartId) ids.add(s.highlightedPartId);
  if (s.activeStep !== null && s.teardown) {
    const step = s.teardown.steps.find((st) => st.n === s.activeStep);
    if (step) for (const id of step.part_ids) ids.add(id);
  }
  return ids;
}

class OverlayEngine {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.OrthographicCamera;
  private readonly labels: LabelLayer;
  private readonly handRig: HandRig;
  private boxRig: BoxRig | null = null;
  /** The previous object's rig, collapsing after a reset before it is disposed. */
  private retiring: BoxRig | null = null;
  /** Armed once the current rig has been exploded; fires the unfreeze when it is collapsed again. */
  private collapseArmed = false;
  /** Stage: which scene object the current / retiring model came out of (to go back into it). */
  private rigObjectId: string | null = null;
  private retiringObjectId: string | null = null;
  private retiringStage = false;
  /** Stage: the parts list the retiring model came from (its saved pill, if its object has gone). */
  private retiringSavedId: string | null = null;
  /** Stage: where the current model lifts out of when it is not its object's box (a saved pill), or null. */
  private rigStartBox: ScreenBox | null = null;
  /** The box rig's object outline (liftOut.ts). */
  private readonly outline: LiftOutline;
  /** Stage idle drift: extra yaw added to store.modelYaw, and what was last seen of the inputs. */
  private drift = 0;
  /** Which way the idle sway is going, and the face (front or back) the model shows. */
  private driftDir = 1;
  private face = 0;
  private seenYaw = 0;
  private seenPitch = 0;
  private seenExplode = 0;
  private lastInput = 0;
  private wasFrozen = false;
  private teardownRef: Teardown | null = null;
  private teardownSig = '';
  private vw = 0;
  private vh = 0;
  private dpr = 1;
  private lastNow = 0;
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private dwellPart: string | null = null;
  private dwellStart = 0;
  private dwellFired = false;
  private readonly canvas: HTMLCanvasElement;
  /** #131: the canvas is shown (it may hold a picture); hidden once it has been cleared with nothing to show */
  private canvasShown = true;
  private envTex: THREE.Texture | null = null;
  /** #125: the warm-up of the stored models, when the engine started, and whether it has begun */
  private readonly warmer: GlbWarmer;
  private readonly bornAt = performance.now();
  private warmStarted = false;
  /** the rig's own materials (glass, edges, shadows) are compiled */
  private rigWarm = false;
  /** #125: how smooth the last open was (debug panel), and the request seen last frame */
  private readonly meter = new OpenMeter();
  private lastTdStatus = '';
  private opened: Teardown | null = null;

  constructor(host: HTMLDivElement, labelHost: HTMLDivElement) {
    this.canvas = document.createElement('canvas');
    Object.assign(this.canvas.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
    });
    // Throws "Error creating WebGL context." when WebGL is unavailable; caught by the component.
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setClearColor(0x000000, 0);
    // Neutral tone mapping keeps the parts' own colours while real models get soft highlights.
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    host.appendChild(this.canvas);
    this.canvas.addEventListener('webglcontextlost', this.onContextLost);

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 5000);
    this.camera.position.set(0, 0, 1000);
    this.camera.lookAt(0, 0, 0);
    // Soft, neutral studio light: frosted placeholder parts and real models both read as objects.
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa0a8, 0.9));
    const dir = new THREE.DirectionalLight(0xffffff, 1.4);
    dir.position.set(-0.4, 1, 1.2);
    this.scene.add(dir);
    // Neutral studio environment for reflections on real models (and a soft sheen on the glass).
    try {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      this.envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      this.scene.environment = this.envTex;
      pmrem.dispose();
    } catch (e) {
      devLog(`No environment light: ${errorText(e)}`, 'warn');
    }
    this.warmer = new GlbWarmer(this.renderer, this.scene, this.camera);

    this.labels = new LabelLayer(labelHost);
    this.outline = new LiftOutline(labelHost);
    this.handRig = new HandRig(this.scene);
    this.resize();
  }

  /**
   * #125: the stored models, warmed one slice at a time (glbCache.ts) so their first open does not
   * stop the view: the laptop's rig materials and its models (parsed, compiled, uploaded, drawn
   * once), then the hand's and the eye's models parsed (the eye compiles its own), then the arm's.
   */
  private async warmUp(): Promise<void> {
    const w = this.warmer;
    const id = DEMO_IDENTIFY.laptop.object_id;
    const t0 = performance.now();
    let td: Teardown | null = null;
    try {
      const r = await fetch(`/cache/${encodeURIComponent(id)}.json`);
      if (r.ok && !(r.headers.get('content-type') ?? '').includes('text/html')) td = (await r.json()) as Teardown;
    } catch {
      td = null; // no stored laptop: nothing to warm
    }
    let n = 0;
    if (td && Array.isArray(td.parts)) {
      await idleSlice();
      if (w.cancelled) return;
      try {
        // A copy of the rig that is never drawn: its materials compile the rig's own programs.
        await w.compile(new BoxRig(td, new THREE.Scene()).root);
        this.rigWarm = true;
      } catch (e) {
        devLog(`Warm-up: rig materials not compiled (${errorText(e)})`, 'warn');
      }
      for (const p of td.parts) {
        if (w.cancelled) return;
        if (p.mesh_url && (await w.warmUrl(p.mesh_url))) n += 1;
      }
      devLog(`Warmed ${n} models for ${id} in ${Math.round(performance.now() - t0)} ms (sliced)`);
    }
    for (const other of [DEMO_IDENTIFY.hand.object_id, DEMO_IDENTIFY.eye.object_id]) {
      if (w.cancelled) return;
      const k = await preloadTeardownMeshes(other, () => w.cancelled);
      if (k > 0) devLog(`Preloaded ${k} models for ${other}`);
    }
    if (w.cancelled) return;
    const a = await preloadArmMeshes(idleSlice, () => w.cancelled);
    if (a > 0) devLog(`Preloaded ${a} arm models`);
  }

  /** Were this parts list's models warm when it opened (#125)? */
  private modelsWarm(td: Teardown): boolean {
    if (isArmTeardown(td)) return armMeshesPreloaded();
    if (isEyeTeardown(td)) return eyeStage.warm();
    return this.rigWarm && td.parts.every((p) => !p.mesh_url || this.warmer.isWarm(p.mesh_url));
  }

  private onContextLost = (e: Event): void => {
    e.preventDefault();
    setStatus('webgl', 'error', 'WebGL context lost: reload the page');
  };

  private resize(): void {
    const vw = Math.max(1, window.innerWidth);
    const vh = Math.max(1, window.innerHeight);
    const dpr = canvasDpr(); // #131
    if (vw === this.vw && vh === this.vh && dpr === this.dpr) return;
    this.vw = vw;
    this.vh = vh;
    this.dpr = dpr;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(vw, vh, false);
    this.camera.left = -vw / 2;
    this.camera.right = vw / 2;
    this.camera.top = vh / 2;
    this.camera.bottom = -vh / 2;
    this.camera.updateProjectionMatrix();
  }

  private onTeardown(td: Teardown | null): void {
    const prevTd = this.teardownRef;
    this.teardownRef = td;
    const sig = td ? teardownSignature(td) : '';
    if (sig !== this.teardownSig) {
      this.teardownSig = sig;
      const old = this.boxRig;
      this.boxRig = null;
      this.collapseArmed = false;
      this.labels.clear();
      this.endRetire();
      const s = useStore.getState();
      if (old && !td && s.trackingMode === 'stage') {
        // "Put it away": the floating model glides back into its object and fades.
        this.retiring = old;
        this.retiringStage = true;
        this.retiringObjectId = this.rigObjectId;
        this.retiringSavedId = prevTd?.object_id ?? null;
      } else if (old && !td && old.explodeLevel() > 0.05) {
        // "Put it back" by reset: collapse the parts over the same frozen image, then let go.
        this.retiring = old;
        this.retiringStage = false;
        if (this.wasFrozen) setHoldFrozen(true);
      } else {
        old?.dispose();
      }
      this.dwellPart = null;
      this.rigObjectId = null;
      if (td) this.opened = td;
      if (td && wantsBoxRig(td, s)) this.createRig(td, s);
    }
    if (td && this.boxRig) this.boxRig.syncMeshes(td);
  }

  private createRig(td: Teardown, s: AppState): void {
    // A hand on stage shows only the parts that have models; the rest stay on the real hand.
    this.boxRig = new BoxRig(td, this.scene, { meshOnly: td.anchor === 'hand' });
    this.rigObjectId = s.selectedObjectId ?? s.focusedObjectId;
    // A saved model brought back while its object is not in view lifts out of its pill (#109).
    const saved = reopenedSavedId(this.rigObjectId);
    this.rigStartBox = saved !== null ? pillBox(saved) : null;
    this.drift = 0;
    this.driftDir = 1;
    this.face = faceOf(s.modelYaw);
    this.lastInput = performance.now();
    this.boxRig.syncMeshes(td);
  }

  /**
   * A hand teardown gains or loses its stage model without a new parts list: its models appeared
   * (mesh_url), or the tracking mode changed (hidden M key). Box teardowns always keep their rig.
   */
  private syncHandRig(td: Teardown | null, s: AppState): void {
    if (!td || (td.anchor !== 'hand' && !isSolidTeardown(td))) return;
    const want = wantsBoxRig(td, s);
    if (want && !this.boxRig) {
      this.createRig(td, s);
    } else if (!want && this.boxRig) {
      this.boxRig.dispose();
      this.boxRig = null;
      this.labels.clear();
    }
  }

  /**
   * Viewport-px box of the object the teardown belongs to (in stage mode: the object the model
   * lifts out of and goes back into), or null when it is not in view.
   */
  private targetBox(s: AppState, objectId?: string | null): ScreenBox | null {
    const id = objectId !== undefined ? objectId : s.selectedObjectId ?? s.focusedObjectId;
    let obj = id ? live.objects.find((o) => o.id === id) : undefined;
    if (!obj && !id) obj = live.objects.find((o) => o.anchor === 'box');
    if (!obj) return null;
    const b = boxToView(getCoverMap(), obj.box);
    return { cx: b.x + b.w / 2, cy: b.y + b.h / 2, w: b.w, h: b.h };
  }

  /**
   * Stage: yaw target with the idle drift (after IDLE_MS without input; any input stops it). The
   * box rig's models are flat: the drift sways about the face shown, and the yaw is held within
   * FLAT_YAW_LIMIT of it whatever turned it (the excess goes into the drift, so a turn back answers
   * at once). Inputs are limited before they reach the store (turnLimit.ts); this is the backstop.
   */
  private stageYaw(s: AppState, now: number, dt: number): number {
    if (
      s.modelYaw !== this.seenYaw ||
      s.modelPitch !== this.seenPitch ||
      s.explodeAmount !== this.seenExplode ||
      modelControl.lastInputAt > this.lastInput
    ) {
      this.lastInput = Math.max(now, modelControl.lastInputAt);
      this.seenYaw = s.modelYaw;
      this.seenPitch = s.modelPitch;
      this.seenExplode = s.explodeAmount;
    }
    let yaw = s.modelYaw + this.drift;
    this.face = faceNear(yaw, this.face);
    if (now - this.lastInput > IDLE_MS) {
      if (yaw - this.face > IDLE_SWAY) this.driftDir = -1;
      else if (yaw - this.face < -IDLE_SWAY) this.driftDir = 1;
      this.drift += this.driftDir * IDLE_SPIN * dt;
      yaw = s.modelYaw + this.drift;
    }
    const held = Math.min(this.face + FLAT_YAW_LIMIT, Math.max(this.face - FLAT_YAW_LIMIT, yaw));
    this.drift += held - yaw;
    stageYawOffset.value = this.drift;
    return held;
  }

  /** true while the floating model is gliding back into its object after "put it away". */
  isPuttingAway(): boolean {
    return this.retiring !== null && this.retiringStage;
  }

  /** Part id under viewport point (x, y), if any. */
  partAt(x: number, y: number): string | null {
    if (isArmTeardown(this.teardownRef)) return armStage.pickAt(x, y);
    if (isEyeTeardown(this.teardownRef)) return eyeStage.pickAt(x, y);
    if (isSolidTeardown(this.teardownRef) && !this.boxRig) return solidStage.pickAt(x, y);
    if (this.boxRig) {
      if (this.boxRig.explodeLevel() < 0.3) return null;
      this.ndc.set((x / this.vw) * 2 - 1, -(y / this.vh) * 2 + 1);
      this.raycaster.setFromCamera(this.ndc, this.camera);
      const hits = this.raycaster.intersectObjects(this.boxRig.pickables(), true);
      for (const h of hits) {
        let o: THREE.Object3D | null = h.object;
        while (o) {
          const pid = o.userData.partId;
          if (typeof pid === 'string') return pid;
          o = o.parent;
        }
      }
      return null;
    }
    const td = this.teardownRef;
    if (td && td.anchor === 'hand') return this.handRig.pickAt(x, y, 60);
    return null;
  }

  pick(x: number, y: number): void {
    const id = this.partAt(x, y);
    if (id) pickPart(id);
  }

  private endRetire(): void {
    if (this.retiring) {
      this.retiring.dispose();
      this.retiring = null;
    }
    this.retiringStage = false;
    this.retiringObjectId = null;
    this.retiringSavedId = null;
    setHoldFrozen(false);
  }

  tick(now: number): void {
    // At most MAX_STEP_S per frame (#125): a late frame does not jump the lift or the springs ahead.
    const dt = frameStep(now, this.lastNow);
    this.lastNow = now;
    this.resize();
    const s = useStore.getState();
    // #125: the warm-up starts a few seconds in, once frames are flowing, while the tab is visible.
    const age = now - this.bornAt;
    if (!this.warmStarted && age >= PRELOAD_DELAY_MS && !document.hidden && (live.objects.length > 0 || live.stats.objMs > 0 || age >= WARM_LATEST_MS)) {
      this.warmStarted = true;
      void this.warmUp();
    }
    // #125: watch the frames of an open, from the request (or the parts list, if it came unasked).
    const report = this.meter.frame(now);
    if (report) console.info(`[overlay] ${report}`);
    if (s.teardownStatus === 'loading' && this.lastTdStatus !== 'loading') this.meter.start(now);
    this.lastTdStatus = s.teardownStatus;
    stageYawOffset.value = 0; // set again by stageYaw while a box-rig model is on stage
    if (s.teardown !== this.teardownRef) this.onTeardown(s.teardown);
    if (this.opened) {
      this.meter.start(now);
      this.meter.note(this.opened.object_id, this.modelsWarm(this.opened));
      this.opened = null;
    }
    const td = s.teardown;
    this.syncHandRig(td, s);
    const hl = highlightSet(s);
    const vw = this.vw;
    const vh = this.vh;

    let labelItems: LabelItem[] = [];
    let bounds: StackBounds = { left: vw / 2, right: vw / 2, top: vh / 2, bottom: vh / 2 };

    if (this.boxRig && td) {
      const stage = s.trackingMode === 'stage';
      const out = this.boxRig.update({
        now,
        dt,
        vw,
        vh,
        box: this.targetBox(s, stage ? this.rigObjectId : undefined),
        explodeTarget: s.explodeAmount,
        highlighted: hl,
        stage: stage
          ? { yaw: this.stageYaw(s, now, dt), pitch: s.modelPitch, putAway: false, zoom: s.modelZoom, panX: s.modelPanX, panY: s.modelPanY, startBox: this.rigStartBox }
          : null,
      });
      labelItems = out.labels;
      bounds = out.bounds;
    }
    const lifting = this.boxRig ? this.boxRig.outline() : null;
    this.outline.update(lifting ? lifting.box : null, lifting ? lifting.drawn : 0, lifting ? lifting.opacity : 0);
    // A solid sketch on stage (#124, SolidStage.tsx) counts as the box model for the title.
    setStageArrived('box', (this.boxRig !== null && td !== null && this.boxRig.arrived()) || solidStage.arrived());

    // Kash's arm on stage (ArmStage.tsx): the real hand keeps the live tendon preview, lit by key presses.
    const armUp = isArmTeardown(td);
    const handTd = td && td.anchor === 'hand' && !armUp ? td : null;
    // The hand's model is on stage: the live drawing stays on the real hand, collapsed, without labels.
    const handOnStage = handTd !== null && this.boxRig !== null;
    const sel = s.selectedObjectId && s.selectedObjectId.startsWith('hand-') ? s.selectedObjectId : null;
    const foc = s.focusedObjectId && s.focusedObjectId.startsWith('hand-') ? s.focusedObjectId : null;
    const handOut = this.handRig.update({
      now,
      dt,
      vw,
      vh,
      map: getCoverMap(),
      hands: live.hands,
      preferredId: sel ?? foc,
      teardown: handTd,
      // Live tendons on a focused hand once the overlay is on (the full layers come with explode),
      // and on the real hand while the arm floats on stage.
      preview: armUp || (!td && s.overlayOn && foc !== null),
      explodeTarget: handOnStage ? 0 : s.explodeAmount,
      highlighted: hl,
    });
    if (handOut && handTd && !handOnStage) {
      labelItems = handOut.labels;
      bounds = handOut.bounds;
    }

    if (this.retiring) {
      if (this.retiringStage) {
        // Back into its object if it is still in view (following it), else into its saved pill.
        const box = (this.retiringObjectId ? this.targetBox(s, this.retiringObjectId) : null) ?? pillBox(this.retiringSavedId);
        const stage = { yaw: 0, pitch: 0, putAway: true, zoom: 1 };
        this.retiring.update({ now, dt, vw, vh, box, explodeTarget: 0, highlighted: new Set(), stage });
        if (this.retiring.stageDone()) this.endRetire();
      } else {
        this.retiring.update({ now, dt, vw, vh, box: null, explodeTarget: 0, highlighted: new Set(), hold: true });
        if (this.retiring.explodeLevel() < 0.01) this.endRetire();
      }
    }

    // "Put it back" by collapsing (explode amount 0): once the parts are home, unfreeze.
    if (this.boxRig && td) {
      const level = this.boxRig.explodeLevel();
      if (s.explodeAmount > 0 && level > 0.5) this.collapseArmed = true;
      if (this.collapseArmed && s.explodeAmount <= 0 && level < 0.02) {
        this.collapseArmed = false;
        if (s.frozen) s.setFrozen(false);
      }
    }
    this.wasFrozen = s.frozen;

    this.labels.update(labelItems, bounds, vw, vh);
    this.updateDwell(now, td);
    this.warmer.beforeRender();
    // #131: nothing of its own to show (no box model, none going away, no hand drawing): one last
    // draw clears the canvas, then it is hidden and not drawn. A warm-up model is still drawn into
    // it while hidden (#125: that draw shows nothing; its point is the upload before the first open).
    const content = this.boxRig !== null || this.retiring !== null || this.handRig.root.visible;
    if (content || this.canvasShown || this.warmer.drawing) {
      if (content && !this.canvasShown) {
        this.canvasShown = true;
        this.canvas.style.visibility = '';
      }
      this.renderer.render(this.scene, this.camera);
      perfCount('overlay');
      if (!content && this.canvasShown) {
        this.canvasShown = false;
        this.canvas.style.visibility = 'hidden';
      }
    }
    this.warmer.afterRender();
  }

  private updateDwell(now: number, td: Teardown | null): void {
    if (!DWELL_ENABLED) return;
    const level = this.boxRig ? this.boxRig.explodeLevel() : td && td.anchor === 'hand' ? this.handRig.explodeLevel() : 0;
    if (!td || level < 0.6) {
      this.dwellPart = null;
      this.labels.setDwell(null);
      return;
    }
    const id = this.partAt(this.vw / 2, this.vh / 2);
    if (id !== this.dwellPart) {
      this.dwellPart = id;
      this.dwellStart = now;
      this.dwellFired = false;
    }
    if (!id) {
      this.labels.setDwell(null);
      return;
    }
    const progress = (now - this.dwellStart) / DWELL_MS;
    if (progress >= 1 && !this.dwellFired) {
      this.dwellFired = true;
      if (useStore.getState().highlightedPartId !== id) pickPart(id);
    }
    this.labels.setDwell(this.dwellFired ? null : progress);
  }

  dispose(): void {
    this.warmer.dispose();
    this.envTex?.dispose();
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.boxRig?.dispose();
    this.boxRig = null;
    this.endRetire();
    this.outline.dispose();
    setStageArrived('box', false);
    this.handRig.dispose();
    this.labels.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }
}

/**
 * Object labels: shown while the overlay is on and nothing is exploded (a collapsed teardown counts
 * as nothing once the frame is live again); while an explode is loading, only its target.
 */
function tickObjectLabels(layer: ObjectLabelLayer, now: number, dt: number, puttingAway: boolean): void {
  const s = useStore.getState();
  // Hidden while anything is exploded or on stage (and while a model goes back into its object).
  const exploding = puttingAway || (s.teardown !== null && (s.explodeAmount > 0 || s.frozen || s.trackingMode === 'stage'));
  const names = new Map<string, string | undefined>();
  for (const o of s.objects) names.set(o.id, o.name);
  const loading = s.teardownStatus === 'loading';
  layer.update({
    now,
    dt,
    vw: Math.max(1, window.innerWidth),
    vh: Math.max(1, window.innerHeight),
    map: getCoverMap(),
    objects: live.objects,
    names,
    focusedId: s.focusedObjectId,
    only: loading ? new Set(s.selectedObjectId ? [s.selectedObjectId] : []) : null,
    visible: s.overlayOn && !exploding && !useHud.getState().holdFrozen,
  });
}

export interface OverlayHandle {
  tick: (now: number) => void;
  pick: (clientX: number, clientY: number) => void;
}

/** No hands: no markers. */
const NO_MARKS: GestureMark[] = [];

export const Overlay = forwardRef<OverlayHandle>(function Overlay(_props, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<OverlayEngine | null>(null);
  const objLabelsRef = useRef<ObjectLabelLayer | null>(null);
  const pinchRef = useRef<HandCueLayer | null>(null);
  const lastNowRef = useRef(0);

  useImperativeHandle(
    ref,
    () => ({
      tick: (now: number) => {
        const t0 = performance.now(); // #131: drawing time for the debug panel
        const last = lastNowRef.current;
        lastNowRef.current = now;
        const dt = last ? Math.min(0.1, Math.max(0, (now - last) / 1000)) : 1 / 60;
        const ol = objLabelsRef.current;
        if (ol) {
          try {
            tickObjectLabels(ol, now, dt, engineRef.current?.isPuttingAway() ?? false);
            setStatus('labels', null);
          } catch (e) {
            setStatus('labels', 'error', `Label error: ${errorText(e)}`);
          }
        }
        engineRef.current?.tick(now);
        // Kash's eye has its own renderer (EyeStage.tsx); a no-op unless it is up.
        try {
          eyeStage.tick(now);
          setStatus('eye', null);
        } catch (e) {
          setStatus('eye', 'error', `Eye error: ${errorText(e)}`);
        }
        // #124: a live object sketched as solids has its own renderer too (SolidStage.tsx); a no-op unless one is up.
        try {
          solidStage.tick(now);
          setStatus('solid', null);
        } catch (e) {
          setStatus('solid', 'error', `Solid model error: ${errorText(e)}`);
        }
        pinchRef.current?.update(gestureLive.out?.marks ?? NO_MARKS, gestureLive.hint, getCoverMap(), now);
        perfDraw(performance.now() - t0);
      },
      pick: (x: number, y: number) => engineRef.current?.pick(x, y),
    }),
    [],
  );

  useEffect(() => {
    const host = hostRef.current;
    const labels = labelRef.current;
    if (!host || !labels) return;
    const objLabels = new ObjectLabelLayer(labels);
    objLabelsRef.current = objLabels;
    const pinch = new HandCueLayer(labels);
    pinchRef.current = pinch;
    let engine: OverlayEngine | null = null;
    try {
      engine = new OverlayEngine(host, labels);
      engineRef.current = engine;
      setStatus('webgl', null);
    } catch (e) {
      setStatus('webgl', 'error', `WebGL unavailable, no 3D overlay: ${errorText(e)}`);
    }
    return () => {
      engineRef.current = null;
      engine?.dispose();
      objLabelsRef.current = null;
      objLabels.dispose();
      pinchRef.current = null;
      pinch.dispose();
    };
  }, []);

  return (
    <>
      <div ref={hostRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
      <ArmStage />
      <EyeStage />
      <SolidStage />
      <div ref={labelRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
    </>
  );
});

export default Overlay;
