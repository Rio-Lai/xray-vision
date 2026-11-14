/**
 * The overlay: one transparent three.js canvas over the video (orthographic camera in viewport
 * pixels, DPR capped at 2) + an HTML label layer. Stage calls tick(now) once per animation frame,
 * and pick(x, y) on clicks.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import * as THREE from 'three';
import { useStore } from '../state/store';
import type { AppState } from '../state/store';
import type { Teardown } from '../../shared/teardown';
import { boxToView, errorText, getCoverMap } from '../camera/frame';
import { live } from '../detect/live';
import { setStatus } from '../hud/hudStore';
import { pickPart } from '../lib/flow';
import { BoxRig } from './boxRig';
import type { ScreenBox } from './boxRig';
import { HandRig } from './handRig';
import { LabelLayer } from './labels';
import type { LabelItem, StackBounds } from './labels';

const DWELL_MS = 1200;

function teardownSignature(td: Teardown): string {
  return [
    td.object_id,
    td.anchor,
    td.explode_axis,
    ...td.parts.map((p) => `${p.id}:${p.layer}:${p.shape}:${p.size.join('/')}:${p.offset.join('/')}:${p.color}`),
  ].join('|');
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
    host.appendChild(this.canvas);
    this.canvas.addEventListener('webglcontextlost', this.onContextLost);

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 5000);
    this.camera.position.set(0, 0, 1000);
    this.camera.lookAt(0, 0, 0);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const dir = new THREE.DirectionalLight(0xffffff, 1.6);
    dir.position.set(-0.4, 1, 1.2);
    this.scene.add(dir);

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
      this.boxRig?.dispose();
      this.boxRig = null;
      this.labels.clear();
      this.dwellPart = null;
      if (td && td.anchor !== 'hand') {
        this.boxRig = new BoxRig(td, this.scene);
      }
    }
    if (td && this.boxRig) this.boxRig.syncMeshes(td);
  }

  /** Viewport-px box of the object the teardown belongs to. */
  private targetBox(s: AppState): ScreenBox | null {
    const vw = this.vw;
    const vh = this.vh;
    if (s.trackingMode === 'mat') {
      const w = vw * 0.42;
      return { cx: vw / 2, cy: vh * 0.47, w, h: w * 0.68 };
    }
    const id = s.selectedObjectId ?? s.focusedObjectId;
    let obj = id ? live.objects.find((o) => o.id === id) : undefined;
    if (!obj && !id) obj = live.objects.find((o) => o.lens === 'engineering');
    if (!obj) return null;
    const b = boxToView(getCoverMap(), obj.box);
    return { cx: b.x + b.w / 2, cy: b.y + b.h / 2, w: b.w, h: b.h };
  }

  /** Part id under viewport point (x, y), if any. */
  partAt(x: number, y: number): string | null {
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

  tick(now: number): void {
    const dt = this.lastNow ? Math.min(0.1, Math.max(0, (now - this.lastNow) / 1000)) : 1 / 60;
    this.lastNow = now;
    this.resize();
    const s = useStore.getState();
    if (s.teardown !== this.teardownRef) this.onTeardown(s.teardown);
    const td = s.teardown;
    const hl = highlightSet(s);
    const vw = this.vw;
    const vh = this.vh;

    let labelItems: LabelItem[] = [];
    let bounds: StackBounds = { left: vw / 2, right: vw / 2, top: vh / 2, bottom: vh / 2 };

    if (this.boxRig && td) {
      const out = this.boxRig.update({
        now,
        dt,
        vw,
        vh,
        box: this.targetBox(s),
        explodeTarget: s.explodeAmount,
        highlighted: hl,
      });
      labelItems = out.labels;
      bounds = out.bounds;
    }

    const handTd = td && td.anchor === 'hand' ? td : null;
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
      preview: !td && s.lens === 'biology',
      explodeTarget: s.explodeAmount,
      highlighted: hl,
    });
    if (handOut && handTd) {
      labelItems = handOut.labels;
      bounds = handOut.bounds;
    }

    this.labels.update(labelItems, bounds, vw, vh);
    this.updateDwell(now, td);
    this.renderer.render(this.scene, this.camera);
  }

  private updateDwell(now: number, td: Teardown | null): void {
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
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.boxRig?.dispose();
    this.boxRig = null;
    this.handRig.dispose();
    this.labels.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }
}

export interface OverlayHandle {
  tick: (now: number) => void;
  pick: (clientX: number, clientY: number) => void;
}

export const Overlay = forwardRef<OverlayHandle>(function Overlay(_props, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<OverlayEngine | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      tick: (now: number) => engineRef.current?.tick(now),
      pick: (x: number, y: number) => engineRef.current?.pick(x, y),
    }),
    [],
  );

  useEffect(() => {
    const host = hostRef.current;
    const labels = labelRef.current;
    if (!host || !labels) return;
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
    };
  }, []);

  return (
    <>
      <div ref={hostRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
      <div ref={labelRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
    </>
  );
});

export default Overlay;
