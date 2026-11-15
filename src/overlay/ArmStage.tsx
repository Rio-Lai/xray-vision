/**
 * Kash's 3D arm as the floating model for a hand (issue #74, option A).
 *
 * While the store's parts list is the arm (src/stage/armTeardown.ts), this mounts his renderer
 * (src/biology/arm/ArmXrayView) over the live camera and drives it every frame from the app store,
 * so everything that works on the MacBook model works on the arm:
 *  - it lifts out of the hand, glides to the middle of the view and is sized like the MacBook
 *    model (boxRig.ts stage constants); "put it away" glides it back into the hand and fades it;
 *  - store.explodeAmount -> his explode (0.12, the "analyse" amount, = assembled with the skin
 *    sleeve; 1 = every layer fanned out), modelYaw / modelPitch (+ the idle drift) -> his view,
 *    modelZoom (eased) -> his camera's zoom (sharp at any size; moved to zoom about the stage centre),
 *    highlightedPartId and activeStep -> his layer focus and glow (as his tour did);
 *  - key presses and quick lifts from the app's hand tracker pulse that finger's flexor slip and
 *    tendon (his keystroke pulses);
 *  - labels are the Blowfish pills (labels.ts), not his own: the focused layer's parts, or one
 *    pill per layer once it is fanned out.
 * His arm stands in a fixed typing pose (src/stage/armStagePose.ts): no pose tracking.
 * The overlay asks `armStage.pickAt` which part a click is on.
 */
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import type { AppState } from '../state/store';
import { ArmXrayView } from '../biology/arm/ArmXrayView';
import type { ArmXrayDrive } from '../biology/arm/ArmXrayView';
import type { ArmLabel } from '../biology/arm/ArmXray';
import { useArmStore } from '../biology/arm/armStore';
import { loadArmTeardown } from '../biology/arm/types';
import type { ArmFrame, ArmStep, ArmTeardown, FingerId, Keystroke } from '../biology/arm/types';
import { ARM_RADIUS_M, armStageFrame } from '../stage/armStagePose';
import { isArmTeardown, sentenceCase } from '../stage/armTeardown';
import { STAGE_MIN_EXPLODE, modelControl } from '../stage/modelControl';
import { boxToView, getCoverMap } from '../camera/frame';
import { live } from '../detect/live';
import { FINGERS } from '../detect/handTracker';
import { smoothstep } from './explodeAnimator';
import { BOTTOM_MARGIN, LABEL_SIDE_FRAC, LABEL_SIDE_MAX_PX, STAGE_LIFT_OMEGA, STAGE_SIZE, STAGE_TURN_OMEGA, TOP_MARGIN } from './boxRig';
import type { ScreenBox } from './boxRig';
import { LabelLayer, inView } from './labels';
import type { LabelItem } from './labels';
import { springStep } from './stageLayout';

/** Idle drift, as for the box model (Overlay.tsx): after this long without input... */
const IDLE_MS = 4000;
/** ...turn at this speed (rad/s). Paused during a step or a highlight (his tour framing). */
const IDLE_SPIN = 0.1;
/** Keystrokes kept for his pulses (ms). */
const KEYS_MS = 2000;
/** Two key presses this recent count as typing (glow the typing muscles, as his tour does). */
const TYPING_MS = 2000;
/** A click picks the part whose label point is this close (px). */
const PICK_PX = 60;
/**
 * The arm waits for its models (26 GLBs, parsed on each mount) before it lifts out of the hand, so
 * they do not pop in during the glide; at most this long (ms).
 */
const MAX_WAIT_MS = 1500;
/** ArmXrayView eases the zoom it is given by this much per frame (its userZoom); mirrored here. */
const ARM_VIEW_ZOOM_EASE = 0.15;

/** For the overlay: which part of the arm is at a viewport point (null when the arm is not up). */
export const armStage: { pickAt: (x: number, y: number) => string | null } = { pickAt: () => null };

interface Anchor {
  id: string;
  layer: number;
  x: number;
  y: number;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** His typing roles as part id -> glow (only one layer if given). */
function typingGlow(td: ArmTeardown, layer?: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of td.activities.typing?.roles ?? []) {
    const part = td.parts.find((p) => p.id === r.part_id);
    if (!part || (layer !== undefined && part.layer !== layer)) continue;
    out[r.part_id] = r.intensity;
  }
  return out;
}

class ArmStageCtl {
  onDone: () => void = () => undefined;
  private wrap: HTMLDivElement | null = null;
  private labels: LabelLayer | null = null;
  private td: ArmTeardown | null = null;
  private done = false;
  private ready = false;
  private mountAt = 0;
  private lastNow = 0;
  // glide (like BoxRig.updateStage)
  private lift = 0;
  private liftV = 0;
  private presence = 0;
  private from: ScreenBox | null = null;
  private objectId: string | null = null;
  // glide transform of the arm canvas, about the stage centre (ox, oy)
  private xf = { ox: 0, oy: 0, s: 1, tx: 0, ty: 0 };
  // fixed pose for the current canvas size
  private frame: ArmFrame | null = null;
  private frameKey = '';
  // idle drift
  private drift = 0;
  private lastInput = 0;
  private seen = { yaw: 0, pitch: 0, explode: 0, step: null as number | null, hl: null as string | null };
  private yaw = 0;
  private pitch = 0;
  // zoom (store.modelZoom): eased here, and the value his view is showing (it eases it again)
  private zoom = 1;
  private zoomV = 0;
  private viewZoom = 1;
  // key presses from the app's hand tracker
  private keys: Keystroke[] = [];
  private seenPress = new Map<string, number>();
  private seenLift = new Map<string, number>();
  // labels and picking
  private focus: number | null = null;
  private hlIds = new Set<string>();
  private explodeTarget = 0;
  private eShown = 0;
  private anchors: Anchor[] = [];

  attach(wrap: HTMLDivElement, labelHost: HTMLDivElement): void {
    this.wrap = wrap;
    this.labels = new LabelLayer(labelHost);
    this.lastInput = performance.now();
    this.mountAt = performance.now();
    loadArmTeardown()
      .then((t) => (this.td = t))
      .catch((e: unknown) => console.error('[arm] teardown', e));
    armStage.pickAt = this.pickAt;
  }

  detach(): void {
    armStage.pickAt = () => null;
    this.labels?.dispose();
    this.labels = null;
    this.wrap = null;
  }

  /** The viewport box of the object the arm came out of (the hand), if it is in view. */
  private objectBox(): ScreenBox | null {
    const obj = this.objectId ? live.objects.find((o) => o.id === this.objectId) : undefined;
    if (!obj) return null;
    const b = boxToView(getCoverMap(), obj.box);
    return { cx: b.x + b.w / 2, cy: b.y + b.h / 2, w: b.w, h: b.h };
  }

  /** New key presses (and quick lifts) since the last frame, from the tracker's per-finger timestamps. */
  private collectKeys(now: number): Keystroke[] {
    for (const h of live.hands) {
      for (const f of FINGERS) {
        const d = h.dyn[f];
        const finger: FingerId = f === 'pinky' ? 'little' : f;
        const k = `${h.id}:${f}`;
        const p0 = this.seenPress.get(k);
        if (p0 !== undefined && d.lastPressAt > p0) this.keys.push({ finger, kind: 'press', t: d.lastPressAt });
        this.seenPress.set(k, d.lastPressAt);
        const l0 = this.seenLift.get(k);
        if (l0 !== undefined && d.extendStart > l0) this.keys.push({ finger, kind: 'lift', t: d.extendStart });
        this.seenLift.set(k, d.extendStart);
      }
    }
    if (this.keys.length > 0 && this.keys[0].t < now - KEYS_MS) this.keys = this.keys.filter((x) => x.t >= now - KEYS_MS);
    return this.keys;
  }

  private typingNow(now: number): boolean {
    if (useArmStore.getState().activity === 'typing') return true;
    let n = 0;
    for (const k of this.keys) if (k.kind === 'press' && k.t >= now - TYPING_MS) n += 1;
    return n >= 2;
  }

  /** Target yaw with the idle drift; any input (or a step / highlight) stops the drift. */
  private stageYaw(s: AppState, now: number, dt: number, still: boolean): number {
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

  /** Every frame, before his renderer draws: store -> arm inputs, and the glide. */
  drive = (now: number, w: number, h: number): ArmXrayDrive => {
    const dt = this.lastNow ? Math.min(0.1, Math.max(0, (now - this.lastNow) / 1000)) : 1 / 60;
    this.lastNow = now;
    const s = useStore.getState();
    const on = isArmTeardown(s.teardown);
    // the hand it came out of (kept while it is put away, so it goes back into the same hand)
    if (on) this.objectId = s.selectedObjectId ?? s.focusedObjectId ?? this.objectId;

    // Glide: out of the hand to the middle of the view, and back into it when put away.
    const box = this.objectBox();
    if (!this.from) this.from = box ?? { cx: w / 2, cy: h * 0.75, w: w * 0.15, h: w * 0.15 };
    else if (box) {
      const k = 1 - Math.exp(-dt * 12);
      this.from.cx += (box.cx - this.from.cx) * k;
      this.from.cy += (box.cy - this.from.cy) * k;
      this.from.w += (box.w - this.from.w) * k;
      this.from.h += (box.h - this.from.h) * k;
    }
    const go = on && (this.ready || now - this.mountAt > MAX_WAIT_MS);
    [this.lift, this.liftV] = springStep(this.lift, this.liftV, go ? 1 : 0, STAGE_LIFT_OMEGA, dt);
    const L = clamp01(this.lift);
    const presTarget = go ? 1 : smoothstep(0.03, 0.35, L);
    this.presence += (presTarget - this.presence) * (1 - Math.exp(-dt * (go ? 9 : 14)));
    if (!on && L < 0.02 && this.presence < 0.02 && !this.done) {
      this.done = true;
      setTimeout(() => this.onDone(), 0);
    }

    // Size and place like the MacBook model: a disc of the arm's radius, about half the view height,
    // between the label columns, the title and the voice area.
    const side = Math.min(LABEL_SIDE_MAX_PX, w * LABEL_SIDE_FRAC);
    const availW = Math.max(100, w - 2 * side);
    const availH = Math.max(100, h - TOP_MARGIN - BOTTOM_MARGIN);
    const diameter = Math.min(STAGE_SIZE * h, availW, availH);
    const pxPerM = diameter / (2 * ARM_RADIUS_M);
    const oy = TOP_MARGIN + availH / 2; // screen y of the arm's turning centre
    const key = `${w}x${h}`;
    if (key !== this.frameKey || !this.frame) {
      this.frameKey = key;
      this.frame = armStageFrame(w, h, pxPerM, { x: 0, y: h / 2 - oy });
    }
    const s0 = Math.min(1, Math.max(0.08, this.from.w / diameter));
    // Zoom: his camera zooms about the canvas centre (h / 2); the translate moves that to the stage
    // centre (oy), using the zoom his view shows this frame (it eases what it is given once more).
    [this.zoom, this.zoomV] = springStep(this.zoom, this.zoomV, on ? s.modelZoom : 1, STAGE_TURN_OMEGA, dt);
    this.viewZoom += (this.zoom - this.viewZoom) * ARM_VIEW_ZOOM_EASE;
    const sc = s0 + (1 - s0) * L;
    this.xf = {
      ox: w / 2,
      oy,
      s: sc,
      tx: (this.from.cx - w / 2) * (1 - L),
      ty: (this.from.cy - oy) * (1 - L) + sc * (1 - this.viewZoom) * (oy - h / 2),
    };
    if (this.wrap) {
      const st = this.wrap.style;
      st.transformOrigin = `${this.xf.ox.toFixed(1)}px ${this.xf.oy.toFixed(1)}px`;
      st.transform = `translate(${this.xf.tx.toFixed(1)}px, ${this.xf.ty.toFixed(1)}px) scale(${this.xf.s.toFixed(4)})`;
      st.opacity = this.presence.toFixed(3);
    }

    // Store -> his inputs. Put away: collapse, no focus, no glow, keep the last view.
    const td = this.td;
    const step: ArmStep | undefined = on && td && s.activeStep !== null ? td.steps.find((x) => x.n === s.activeStep) : undefined;
    const hlPart = on && td && s.highlightedPartId ? td.parts.find((p) => p.id === s.highlightedPartId) : undefined;
    this.explodeTarget = on ? clamp01((s.explodeAmount - STAGE_MIN_EXPLODE) / (1 - STAGE_MIN_EXPLODE)) : 0;
    // as his tour: a step focuses its layer, a highlighted part its own layer
    this.focus = step ? step.layer_focus : hlPart ? hlPart.layer : null;
    this.hlIds = new Set([...(step?.part_ids ?? []), ...(hlPart ? [hlPart.id] : [])]);
    let highlight: Record<string, number> = {};
    if (td && step) {
      highlight = typingGlow(td, step.layer_focus);
      for (const id of step.part_ids) highlight[id] = Math.max(highlight[id] ?? 0, 0.85);
    }
    if (hlPart) highlight[hlPart.id] = 1;
    const keystrokes = this.collectKeys(now);
    if (td && on && !step && !hlPart && this.typingNow(now)) highlight = typingGlow(td);
    if (on) {
      this.yaw = this.stageYaw(s, now, dt, !step && !hlPart);
      this.pitch = s.modelPitch;
    }
    return {
      landmarks: this.frame,
      explode: this.explodeTarget,
      layerFocus: this.focus,
      highlight,
      keystrokes,
      frozen: false,
      view: { yaw: this.yaw, pitch: this.pitch, zoom: this.zoom },
    };
  };

  /** His models are loaded (from ArmXrayView's onReady). */
  onReady = (): void => {
    this.ready = true;
  };

  /** Every frame, after his renderer drew: Blowfish label pills and the pick points. */
  onFrame = (labels: ArmLabel[], w: number, h: number): void => {
    const dt = 1 / 60;
    this.eShown += (this.explodeTarget - this.eShown) * (1 - Math.exp(-dt * 6));
    const { ox, oy, s, tx, ty } = this.xf;
    const anchors: Anchor[] = labels.map((l) => ({ id: l.id, layer: l.layer, x: ox + (l.at[0] - ox) * s + tx, y: oy + (l.at[1] - oy) * s + ty }));
    this.anchors = anchors;
    if (!this.labels) return;
    const st = useStore.getState();
    const names = new Map<string, string>();
    if (isArmTeardown(st.teardown)) for (const p of st.teardown!.parts) names.set(p.id, p.name);
    const base = this.presence * smoothstep(0.75, 1, clamp01(this.lift));
    const items: LabelItem[] = [];
    if (this.focus !== null) {
      // the focused layer's parts (a step, or a highlighted part)
      for (const a of anchors) {
        if (a.layer !== this.focus) continue;
        const l = labels.find((x) => x.id === a.id);
        const opacity = base * inView(a.x, a.y, w, h);
        items.push({ id: a.id, text: names.get(a.id) ?? sentenceCase(l?.name ?? a.id), ax: a.x, ay: a.y, opacity, highlighted: this.hlIds.has(a.id) });
      }
    } else if (this.td && this.eShown > 0.3) {
      // fanned out, nothing focused: one pill per layer, on its most central part
      const legend = this.td.layers_legend;
      const byLayer = new Map<number, Anchor[]>();
      for (const a of anchors) byLayer.set(a.layer, [...(byLayer.get(a.layer) ?? []), a]);
      for (const [layer, list] of byLayer) {
        const mx = list.reduce((acc, a) => acc + a.x, 0) / list.length;
        const my = list.reduce((acc, a) => acc + a.y, 0) / list.length;
        const rep = list.reduce((best, a) => (Math.hypot(a.x - mx, a.y - my) < Math.hypot(best.x - mx, best.y - my) ? a : best));
        items.push({
          id: `layer-${layer}`,
          text: sentenceCase(legend[String(layer)] ?? `Layer ${layer}`),
          ax: rep.x,
          ay: rep.y,
          opacity: base * smoothstep(0.35, 0.75, this.eShown) * inView(rep.x, rep.y, w, h),
          highlighted: false,
        });
      }
    }
    // the arm's on-screen extent, for the label columns (its label points, plus the limb's thickness)
    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    for (const a of anchors) {
      left = Math.min(left, a.x);
      right = Math.max(right, a.x);
      top = Math.min(top, a.y);
      bottom = Math.max(bottom, a.y);
    }
    if (!Number.isFinite(left)) {
      left = right = ox;
      top = bottom = oy;
    }
    const pad = 0.035 * Math.min(w, h) * s;
    this.labels.update(items, { left: left - pad, right: right + pad, top: top - pad, bottom: bottom + pad }, w, h);
  };

  /** Part under a viewport point: the nearest label point within PICK_PX (the focused layer only, if any). */
  pickAt = (x: number, y: number): string | null => {
    if (this.presence < 0.5 || clamp01(this.lift) < 0.9) return null;
    if (this.focus === null && this.eShown < 0.3) return null;
    let best: string | null = null;
    let bestD = PICK_PX;
    for (const a of this.anchors) {
      if (this.focus !== null && a.layer !== this.focus) continue;
      const d = Math.hypot(a.x - x, a.y - y);
      if (d < bestD) {
        bestD = d;
        best = a.id;
      }
    }
    return best;
  };
}

const NO_GLOW: Record<string, number> = {};
const NO_KEYS: Keystroke[] = [];

function ArmStageView({ onDone }: { onDone: () => void }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const [ctl] = useState(() => new ArmStageCtl());
  ctl.onDone = onDone;
  useEffect(() => {
    const wrap = wrapRef.current;
    const host = labelRef.current;
    if (!wrap || !host) return;
    ctl.attach(wrap, host);
    return () => ctl.detach();
  }, [ctl]);
  return (
    <>
      <div ref={wrapRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', opacity: 0, willChange: 'transform, opacity' }}>
        <ArmXrayView
          landmarks={null}
          explode={0}
          layerFocus={null}
          highlight={NO_GLOW}
          activity="none"
          keystrokes={NO_KEYS}
          showLabels={false}
          drive={ctl.drive}
          onFrame={ctl.onFrame}
          onReady={ctl.onReady}
        />
      </div>
      <div ref={labelRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
    </>
  );
}

/** Mounted by the overlay: shows the arm while the store's parts list is the arm (and while it is put away). */
export function ArmStage() {
  const on = useStore((s) => isArmTeardown(s.teardown));
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (on) setMounted(true);
  }, [on]);
  if (!mounted) return null;
  return <ArmStageView onDone={() => setMounted(false)} />;
}

export default ArmStage;
