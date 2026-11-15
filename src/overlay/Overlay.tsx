/**
 * The overlay: one transparent three.js canvas over the video (orthographic camera in viewport
 * pixels, DPR capped at 2), the part label layer, and the object label layer (live view, pure DOM,
 * so it still works when WebGL does not). Stage calls tick(now) once per animation frame,
 * and pick(x, y) on clicks.
 *
 * Stage mode (the default): the box rig lifts the model out of the object and floats it in the
 * middle of the view, turned by store.modelYaw / modelPitch, plus a very slow idle drift once
 * nothing has touched it for IDLE_MS. "Put it away" (reset) glides it back into its object.
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
import { boxToView, errorText, getCoverMap, urlFlag } from '../camera/frame';
import { live } from '../detect/live';
import { devLog, setHoldFrozen, setStatus, useHud } from '../hud/hudStore';
import { pickPart } from '../lib/flow';
import { BoxRig } from './boxRig';
import type { ScreenBox } from './boxRig';
import { HandRig } from './handRig';
import { LabelLayer } from './labels';
import type { LabelItem, StackBounds } from './labels';
import { ObjectLabelLayer } from './objectLabels';
import { preloadTeardownMeshes } from './glbCache';
import { modelControl } from '../stage/modelControl';
import { gestureLive } from '../detect/gestureDriver';
import { PinchDotLayer } from './pinchDots';
import { hasPartMeshes } from './stageState';
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
/** Load the demo laptop's real models this long after start, in the background. */
const PRELOAD_DELAY_MS = 2500;
/** Stage: the model starts turning slowly by itself after this long without any input... */
const IDLE_MS = 4000;
/** ...at this speed (rad/s): a full turn a minute. */
const IDLE_SPIN = 0.1;

function teardownSignature(td: Teardown): string {
  return [
    td.object_id,
    td.anchor,
    td.explode_axis,
    ...td.parts.map((p) => `${p.id}:${p.layer}:${p.shape}:${p.size.join('/')}:${p.offset.join('/')}:${p.color}`),
  ].join('|');
}

/** Whether the teardown gets the box rig: every non-hand teardown but the eye; a hand only on stage with models (not the arm). */
function wantsBoxRig(td: Teardown | null, s: AppState): boolean {
  if (!td || isArmTeardown(td) || isEyeTeardown(td)) return false;
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
  /** Stage idle drift: extra yaw added to store.modelYaw, and what was last seen of the inputs. */
  private drift = 0;
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
  private envTex: THREE.Texture | null = null;
  private preloadTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

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
    // The demo laptop's models, parsed once in the background so the first explode shows them at once.
    this.preloadTimer = setTimeout(() => {
      this.preloadTimer = null;
      void (async () => {
        // The demo laptop first, then the hand (nothing to load until its models exist), then the eye.
        for (const id of [DEMO_IDENTIFY.laptop.object_id, DEMO_IDENTIFY.hand.object_id, DEMO_IDENTIFY.eye.object_id]) {
          if (this.disposed) return;
          const n = await preloadTeardownMeshes(id, () => this.disposed);
          if (n > 0) devLog(`Preloaded ${n} models for ${id}`);
        }
      })();
    }, PRELOAD_DELAY_MS);

    this.labels = new LabelLayer(labelHost);
    this.handRig = new HandRig(this.scene);
    this.resize();
  }

  private onContextLost = (e: Event): void => {
    e.preventDefault();
    setStatus('webgl', 'error', 'WebGL context lost: reload the page');
  };

  private resize(): void {
    const vw = Math.max(1, window.innerWidth);
    const vh = Math.max(1, window.innerHeight);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
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
      if (td && wantsBoxRig(td, s)) this.createRig(td, s);
    }
    if (td && this.boxRig) this.boxRig.syncMeshes(td);
  }

  private createRig(td: Teardown, s: AppState): void {
    // A hand on stage shows only the parts that have models; the rest stay on the real hand.
    this.boxRig = new BoxRig(td, this.scene, { meshOnly: td.anchor === 'hand' });
    this.rigObjectId = s.selectedObjectId ?? s.focusedObjectId;
    this.drift = 0;
    this.lastInput = performance.now();
    this.boxRig.syncMeshes(td);
  }

  /**
   * A hand teardown gains or loses its stage model without a new parts list: its models appeared
   * (mesh_url), or the tracking mode changed (hidden M key). Box teardowns always keep their rig.
   */
  private syncHandRig(td: Teardown | null, s: AppState): void {
    if (!td || td.anchor !== 'hand') return;
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

  /** Stage: yaw target with the idle drift (after IDLE_MS without input; any input stops it). */
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
    if (now - this.lastInput > IDLE_MS) this.drift += IDLE_SPIN * dt;
    return s.modelYaw + this.drift;
  }

  /** true while the floating model is gliding back into its object after "put it away". */
  isPuttingAway(): boolean {
    return this.retiring !== null && this.retiringStage;
  }

  /** Part id under viewport point (x, y), if any. */
  partAt(x: number, y: number): string | null {
    if (isArmTeardown(this.teardownRef)) return armStage.pickAt(x, y);
    if (isEyeTeardown(this.teardownRef)) return eyeStage.pickAt(x, y);
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
    setHoldFrozen(false);
  }

  tick(now: number): void {
    const dt = this.lastNow ? Math.min(0.1, Math.max(0, (now - this.lastNow) / 1000)) : 1 / 60;
    this.lastNow = now;
    this.resize();
    const s = useStore.getState();
    if (s.teardown !== this.teardownRef) this.onTeardown(s.teardown);
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
        stage: stage ? { yaw: this.stageYaw(s, now, dt), pitch: s.modelPitch, putAway: false } : null,
      });
      labelItems = out.labels;
      bounds = out.bounds;
    }

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
        const box = this.retiringObjectId ? this.targetBox(s, this.retiringObjectId) : null;
        const stage = { yaw: 0, pitch: 0, putAway: true };
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
    this.renderer.render(this.scene, this.camera);
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
    this.disposed = true;
    if (this.preloadTimer) clearTimeout(this.preloadTimer);
    this.envTex?.dispose();
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.boxRig?.dispose();
    this.boxRig = null;
    this.endRetire();
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

export const Overlay = forwardRef<OverlayHandle>(function Overlay(_props, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<OverlayEngine | null>(null);
  const objLabelsRef = useRef<ObjectLabelLayer | null>(null);
  const pinchRef = useRef<PinchDotLayer | null>(null);
  const lastNowRef = useRef(0);

  useImperativeHandle(
    ref,
    () => ({
      tick: (now: number) => {
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
        pinchRef.current?.update(gestureLive.out?.dots ?? [], getCoverMap());
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
    const pinch = new PinchDotLayer(labels);
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
      <div ref={labelRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
    </>
  );
});

export default Overlay;
