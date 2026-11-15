/**
 * Turning and opening the model on stage from direct input (the hidden mouse fallback, and hand
 * gestures): writes store.rotateModel / store.setExplode, keeps a little inertia after a drag is
 * let go (like spinning a globe), and remembers when anything was last touched, so the overlay's
 * idle drift waits for a few quiet seconds. Voice (rotate_model, explode, zoom_model) writes the store directly.
 * Turns go through turnModel (turnLimit.ts): a flat model is soft-limited so it never rests edge-on.
 * Zoom (#109): store.modelZoom, from the trackpad pinch, the + / - keys, the two-hand spread and the burst.
 * Pan (#121): store.modelPanX / modelPanY in stage sizes (PAN_UNIT_VH of the view height each), from the
 * two-hand pinch moved together, shift- or right-drag and shift + arrow keys; `centre` puts it back.
 */
import { useStore } from '../state/store';
import type { AppState } from '../state/store';
import { turnModel } from './turnLimit';

/** After a release the spin slows with this time constant (s). */
const INERTIA_TAU_S = 0.38;
/** Release speeds are capped (rad/s), and below this the spin just stops. */
const MAX_SPIN = 9;
const MIN_SPIN = 0.05;
/** A drag that paused this long before the release does not coast. */
const STILL_MS = 90;
/** Lowest explode amount reachable by mouse or hands: the "analyse" state, parts just apart. */
export const STAGE_MIN_EXPLODE = 0.12;

/**
 * One "stage size" of store.modelPanX / modelPanY, as a share of the view height: the normal stage
 * model's widest extent (boxRig.ts STAGE_SIZE). Every stage renderer converts pan with it.
 */
export const PAN_UNIT_VH = 0.56;

/** Pan in stage sizes -> viewport px, for a view `vh` px high. */
export function panPx(pan: number, vh: number): number {
  return Number.isFinite(pan) ? pan * PAN_UNIT_VH * vh : 0;
}

/** Direct input works only while a box model is on stage (the floating model). */
export function stageInputActive(s: Pick<AppState, 'trackingMode' | 'teardown'>): boolean {
  return s.trackingMode === 'stage' && s.teardown !== null;
}

class ModelControl {
  /** performance.now() of the last direct input (drag, hold, wheel, gesture) */
  lastInputAt = -1e9;
  private dragging = false;
  private lastDragAt = 0;
  private vYaw = 0;
  private vPitch = 0;
  private coasting = false;

  /** Mark activity without moving (e.g. a pinch held still): stops the idle drift. */
  touch(now: number): void {
    this.lastInputAt = now;
  }

  /** One drag step: turn the model by (dYaw, dPitch) radians now. */
  turn(dYaw: number, dPitch: number, now: number): void {
    const s = useStore.getState();
    if (!stageInputActive(s)) return;
    if (!Number.isFinite(dYaw) || !Number.isFinite(dPitch)) return;
    const dt = this.dragging ? Math.max(1 / 240, Math.min(0.1, (now - this.lastDragAt) / 1000)) : 1 / 60;
    if (!this.dragging) {
      this.vYaw = 0;
      this.vPitch = 0;
    }
    this.dragging = true;
    this.coasting = false;
    this.lastDragAt = now;
    this.lastInputAt = now;
    // Velocity estimate for the release (EMA over the last few steps).
    const k = 0.45;
    this.vYaw += (dYaw / dt - this.vYaw) * k;
    this.vPitch += (dPitch / dt - this.vPitch) * k;
    if (dYaw !== 0 || dPitch !== 0) turnModel(dYaw, dPitch, true);
  }

  /** The drag ended: keep turning a little, slowing down (inertia). */
  release(now: number): void {
    if (!this.dragging) return;
    this.dragging = false;
    this.lastInputAt = now;
    if (now - this.lastDragAt > STILL_MS) {
      this.vYaw = 0;
      this.vPitch = 0;
    }
    const clamp = (v: number) => Math.max(-MAX_SPIN, Math.min(MAX_SPIN, v));
    this.vYaw = clamp(this.vYaw);
    this.vPitch = clamp(this.vPitch) * 0.6; // tipping coasts less than turning
    this.coasting = Math.hypot(this.vYaw, this.vPitch) > MIN_SPIN;
  }

  /** Set the explode amount from direct input (kept between the analyse state and fully open). */
  setExplode(amount: number, now: number): void {
    const s = useStore.getState();
    if (!stageInputActive(s) || !Number.isFinite(amount)) return;
    this.lastInputAt = now;
    const a = Math.min(1, Math.max(STAGE_MIN_EXPLODE, amount));
    if (Math.abs(a - s.explodeAmount) > 1e-4) s.setExplode(a);
  }

  /** Multiply the zoom (store.modelZoom, clamped by the store) from direct input. */
  zoomBy(factor: number, now: number): void {
    const s = useStore.getState();
    if (!stageInputActive(s) || !Number.isFinite(factor) || factor <= 0) return;
    this.lastInputAt = now;
    s.zoomModel(factor);
  }

  /** Set the zoom from direct input (the two-hand spread past fully open). */
  setZoom(zoom: number, now: number): void {
    const s = useStore.getState();
    if (!stageInputActive(s) || !Number.isFinite(zoom)) return;
    this.lastInputAt = now;
    if (Math.abs(zoom - s.modelZoom) > 1e-4) s.setModelZoom(zoom);
  }

  /** Move the model by (dx, dy) stage sizes from direct input (clamped by the store). */
  panBy(dx: number, dy: number, now: number): void {
    const s = useStore.getState();
    if (!stageInputActive(s) || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
    this.lastInputAt = now;
    if (Math.abs(dx) > 1e-5 || Math.abs(dy) > 1e-5) s.panModel(dx, dy);
  }

  /** Back to the middle of the view at the normal size (double-click, the 0 key). */
  centre(now: number): void {
    const s = useStore.getState();
    if (!stageInputActive(s)) return;
    this.lastInputAt = now;
    s.centreModel();
    s.setModelZoom(1);
  }

  /** Stop any coasting (reset, model gone). */
  stop(): void {
    this.dragging = false;
    this.coasting = false;
    this.vYaw = 0;
    this.vPitch = 0;
  }

  /** Once per animation frame. */
  tick(now: number, dtSec: number): void {
    const s = useStore.getState();
    if (!stageInputActive(s)) {
      if (this.coasting || this.dragging) this.stop();
      return;
    }
    if (this.dragging && now - this.lastDragAt > STILL_MS) {
      // Holding still mid-drag: let the velocity estimate die down.
      const d = Math.exp(-Math.max(0, dtSec) / 0.08);
      this.vYaw *= d;
      this.vPitch *= d;
    }
    if (!this.coasting) return;
    const dt = Math.min(0.1, Math.max(0, dtSec));
    const dy = this.vYaw * dt;
    const dp = this.vPitch * dt;
    if (turnModel(dy, dp, true)) {
      // A flat model coasting into its limit: the spin dies there instead of pressing on.
      const n = useStore.getState();
      if (dy !== 0) this.vYaw *= Math.min(1, Math.max(0, (n.modelYaw - s.modelYaw) / dy));
      if (dp !== 0) this.vPitch *= Math.min(1, Math.max(0, (n.modelPitch - s.modelPitch) / dp));
    }
    const decay = Math.exp(-dt / INERTIA_TAU_S);
    this.vYaw *= decay;
    this.vPitch *= decay;
    this.lastInputAt = now;
    if (Math.hypot(this.vYaw, this.vPitch) < MIN_SPIN) this.coasting = false;
  }

  /** For the debug panel. */
  describe(): string {
    return `${this.dragging ? 'dragging' : this.coasting ? 'coasting' : 'idle'} v ${this.vYaw.toFixed(2)}/${this.vPitch.toFixed(2)} rad/s`;
  }
}

export const modelControl = new ModelControl();
