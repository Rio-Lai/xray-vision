/**
 * HandState builder: smoothing, per-finger curl, press detection, activation glow levels.
 *
 * Press signal (per finger): rel = (tip.y - mcp.y) * frameH + (tip.z - mcp.z) * frameW * Z_WEIGHT,
 * divided by hand size (wrist -> middle MCP, px). Its time derivative (hand sizes per second),
 * EMA-smoothed and with the median of all five fingers subtracted (cancels whole-hand motion),
 * is v. A press is a short positive spike (tip moving down in the image / away from the camera
 * relative to its own MCP): ON when v > pressOn, OFF when v < pressOff or after PRESS_MAX_MS.
 * A quick extension is a negative spike below -extendOn.
 * The three thresholds (and the left/right swap) live in `handTuning`: tune them with the sliders in
 * the debug panel (D), which are saved in localStorage; URL params ?press=&release=&extend= override.
 */
import type { FingerName, FingerState, HandState, SceneObject } from '../state/store';
import { urlNumber } from '../camera/frame';

export interface Landmark {
  x: number;
  y: number;
  z: number;
}

export interface RawHand {
  handedness: 'left' | 'right';
  score: number;
  landmarks: Landmark[];
}

export const FINGERS: FingerName[] = ['thumb', 'index', 'middle', 'ring', 'pinky'];

/** [mcp-ish, pip, dip, tip] landmark indices per finger (thumb: cmc, mcp, ip, tip). */
export const FINGER_CHAINS: Record<FingerName, [number, number, number, number]> = {
  thumb: [1, 2, 3, 4],
  index: [5, 6, 7, 8],
  middle: [9, 10, 11, 12],
  ring: [13, 14, 15, 16],
  pinky: [17, 18, 19, 20],
};

export interface HandTuning {
  /** press starts when the finger's signal rises above this (hand sizes per second) */
  pressOn: number;
  /** press ends when it falls below this */
  pressOff: number;
  /** a quick lift (extension) when it falls below minus this */
  extendOn: number;
  /**
   * MediaPipe labels hands as if the image were mirrored (selfie). Our camera is not mirrored, so
   * the labels are swapped by default; untick in the debug panel (or ?hands=raw) if left/right look wrong.
   */
  swapHandedness: boolean;
}

export const HAND_TUNING_DEFAULTS: HandTuning = { pressOn: 0.6, pressOff: 0.15, extendOn: 1.2, swapHandedness: true };
const TUNING_KEY = 'blowfish.handTuning';

function loadTuning(): HandTuning {
  let saved: Partial<HandTuning> = {};
  try {
    const raw = window.localStorage.getItem(TUNING_KEY);
    if (raw) saved = JSON.parse(raw) as Partial<HandTuning>;
  } catch {
    /* private mode or bad JSON: defaults */
  }
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const t: HandTuning = {
    pressOn: num(saved.pressOn, HAND_TUNING_DEFAULTS.pressOn),
    pressOff: num(saved.pressOff, HAND_TUNING_DEFAULTS.pressOff),
    extendOn: num(saved.extendOn, HAND_TUNING_DEFAULTS.extendOn),
    swapHandedness: typeof saved.swapHandedness === 'boolean' ? saved.swapHandedness : HAND_TUNING_DEFAULTS.swapHandedness,
  };
  t.pressOn = urlNumber('press', t.pressOn);
  t.pressOff = urlNumber('release', t.pressOff);
  t.extendOn = urlNumber('extend', t.extendOn);
  try {
    if (new URLSearchParams(window.location.search).get('hands') === 'raw') t.swapHandedness = false;
  } catch {
    /* ignore */
  }
  return t;
}

/** Live hand tuning, read every frame. Change it with setHandTuning. */
export const handTuning: HandTuning = loadTuning();

export function setHandTuning(patch: Partial<HandTuning>): void {
  Object.assign(handTuning, patch);
  try {
    window.localStorage.setItem(TUNING_KEY, JSON.stringify(handTuning));
  } catch {
    /* ignore */
  }
}

const Z_WEIGHT = 0.5;
const PRESS_MAX_MS = 320;
const PRESS_REFRACTORY_MS = 140;
const ACTIVE_CLEAR_MS = 1200;
const DROP_AFTER_MS = 250;
const LM_ALPHA = 0.65;
const VEL_ALPHA = 0.5;
const GLOW_TAU_S = 0.35;

export interface FingerDyn {
  prevRel: number | null;
  vel: number;
  /** median-subtracted velocity (the press signal) */
  signal: number;
  pressing: boolean;
  pressStart: number;
  lastPressAt: number;
  extending: boolean;
  extendStart: number;
  /** largest |signal| lately (decays over ~1.5 s), shown in the debug panel to help tuning */
  peak: number;
  /** 0..1 glow levels read by the overlay */
  flexGlow: number;
  extendGlow: number;
  curl: number;
}

export interface TrackedHand {
  id: 'hand-left' | 'hand-right';
  handedness: 'left' | 'right';
  score: number;
  /** smoothed landmarks, normalised frame coords */
  lm: Landmark[];
  dyn: Record<FingerName, FingerDyn>;
  activeFinger: FingerName | null;
  activeAt: number;
  lastSeen: number;
  lastUpdate: number;
  /** wrist -> middle MCP distance in frame px */
  handSize: number;
}

function newDyn(): FingerDyn {
  return {
    prevRel: null,
    vel: 0,
    signal: 0,
    pressing: false,
    pressStart: 0,
    lastPressAt: -1e9,
    extending: false,
    extendStart: 0,
    peak: 0,
    flexGlow: 0,
    extendGlow: 0,
    curl: 0,
  };
}

function newDynMap(): Record<FingerName, FingerDyn> {
  return { thumb: newDyn(), index: newDyn(), middle: newDyn(), ring: newDyn(), pinky: newDyn() };
}

type V3 = [number, number, number];

function bend(a: V3, b: V3, c: V3): number {
  const v1x = b[0] - a[0];
  const v1y = b[1] - a[1];
  const v1z = b[2] - a[2];
  const v2x = c[0] - b[0];
  const v2y = c[1] - b[1];
  const v2z = c[2] - b[2];
  const l1 = Math.hypot(v1x, v1y, v1z);
  const l2 = Math.hypot(v2x, v2y, v2z);
  if (l1 < 1e-6 || l2 < 1e-6) return 0;
  const cos = (v1x * v2x + v1y * v2y + v1z * v2z) / (l1 * l2);
  return Math.acos(Math.min(1, Math.max(-1, cos)));
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export class HandTracker {
  hands: TrackedHand[] = [];

  update(raw: RawHand[], now: number, fw: number, fh: number): void {
    // Two hands with the same label: the one further left in the image is the left hand.
    let input = raw.filter((h) => h.landmarks.length >= 21);
    if (input.length === 2 && input[0].handedness === input[1].handedness) {
      const sorted = [...input].sort((a, b) => a.landmarks[0].x - b.landmarks[0].x);
      input = [
        { ...sorted[0], handedness: 'left' },
        { ...sorted[1], handedness: 'right' },
      ];
    }
    for (const r of input) this.updateOne(r, now, fw, fh);
    this.prune(now);
  }

  prune(now: number): void {
    this.hands = this.hands.filter((h) => now - h.lastSeen <= DROP_AFTER_MS);
    for (const h of this.hands) {
      if (h.activeFinger && now - h.activeAt > ACTIVE_CLEAR_MS) h.activeFinger = null;
    }
  }

  clear(): void {
    this.hands = [];
  }

  states(): HandState[] {
    return this.hands.map((h) => {
      const fingers = {} as Record<FingerName, FingerState>;
      for (const f of FINGERS) fingers[f] = { curl: h.dyn[f].curl, pressing: h.dyn[f].pressing };
      return {
        handedness: h.handedness,
        landmarks: h.lm.map((p) => ({ x: p.x, y: p.y, z: p.z })),
        fingers,
        activeFinger: h.activeFinger,
      };
    });
  }

  sceneObjects(): SceneObject[] {
    return this.hands.map((h) => {
      let x0 = 1;
      let y0 = 1;
      let x1 = 0;
      let y1 = 0;
      for (const p of h.lm) {
        x0 = Math.min(x0, p.x);
        y0 = Math.min(y0, p.y);
        x1 = Math.max(x1, p.x);
        y1 = Math.max(y1, p.y);
      }
      const w = Math.max(0.001, x1 - x0);
      const hh = Math.max(0.001, y1 - y0);
      const bx0 = Math.max(0, x0 - w * 0.15);
      const by0 = Math.max(0, y0 - hh * 0.15);
      const bx1 = Math.min(1, x1 + w * 0.15);
      const by1 = Math.min(1, y1 + hh * 0.15);
      return {
        id: h.id,
        label: 'hand',
        confidence: h.score,
        box: { x: bx0, y: by0, w: bx1 - bx0, h: by1 - by0 },
        lens: 'biology',
        anchor: 'hand',
      };
    });
  }

  private updateOne(r: RawHand, now: number, fw: number, fh: number): void {
    const id = r.handedness === 'left' ? 'hand-left' : 'hand-right';
    let h = this.hands.find((x) => x.id === id);
    const rawLm = r.landmarks.slice(0, 21).map((p) => ({ x: p.x, y: p.y, z: p.z ?? 0 }));
    if (!h) {
      h = {
        id,
        handedness: r.handedness,
        score: r.score,
        lm: rawLm,
        dyn: newDynMap(),
        activeFinger: null,
        activeAt: 0,
        lastSeen: now,
        lastUpdate: now,
        handSize: 1,
      };
      this.hands.push(h);
    } else {
      // Snap instead of smoothing across a big jump (re-acquired / swapped hand).
      const jump = Math.hypot((rawLm[0].x - h.lm[0].x) * fw, (rawLm[0].y - h.lm[0].y) * fh);
      if (jump > h.handSize * 1.2 || now - h.lastSeen > DROP_AFTER_MS) {
        h.lm = rawLm;
        for (const f of FINGERS) h.dyn[f].prevRel = null;
      } else {
        for (let i = 0; i < 21; i++) {
          const a = h.lm[i];
          const b = rawLm[i];
          a.x += (b.x - a.x) * LM_ALPHA;
          a.y += (b.y - a.y) * LM_ALPHA;
          a.z += (b.z - a.z) * LM_ALPHA;
        }
      }
      h.score += (r.score - h.score) * 0.3;
    }
    const dt = Math.min(0.1, Math.max(1 / 240, (now - h.lastUpdate) / 1000));
    h.lastUpdate = now;
    h.lastSeen = now;

    const P: V3[] = h.lm.map((p) => [p.x * fw, p.y * fh, p.z * fw]);
    const hs = Math.max(8, Math.hypot(P[9][0] - P[0][0], P[9][1] - P[0][1]));
    h.handSize = hs;

    // Curl + raw velocities.
    const vels: number[] = [];
    for (const f of FINGERS) {
      const [a, b, c, d] = FINGER_CHAINS[f];
      const dyn = h.dyn[f];
      let sum: number;
      if (f === 'thumb') {
        sum = bend(P[a], P[b], P[c]) + bend(P[b], P[c], P[d]);
        dyn.curl = Math.min(1, sum / 1.8);
      } else {
        sum = bend(P[0], P[a], P[b]) + bend(P[a], P[b], P[c]) + bend(P[b], P[c], P[d]);
        dyn.curl = Math.min(1, sum / 4.2);
      }
      const mcp = f === 'thumb' ? P[b] : P[a];
      const tip = P[d];
      const rel = ((tip[1] - mcp[1]) + (tip[2] - mcp[2]) * Z_WEIGHT) / hs;
      if (dyn.prevRel !== null) {
        const v = (rel - dyn.prevRel) / dt;
        dyn.vel += (v - dyn.vel) * VEL_ALPHA;
      } else {
        dyn.vel = 0;
      }
      dyn.prevRel = rel;
      vels.push(dyn.vel);
    }

    const common = median(vels);
    const decay = Math.exp(-dt / GLOW_TAU_S);
    const peakDecay = Math.exp(-dt / 1.5);
    const { pressOn, pressOff, extendOn } = handTuning;
    for (const f of FINGERS) {
      const dyn = h.dyn[f];
      dyn.signal = dyn.vel - common;
      dyn.peak = Math.max(dyn.peak * peakDecay, Math.abs(dyn.signal));
      // Press with hysteresis.
      if (!dyn.pressing) {
        if (dyn.signal > pressOn && now - dyn.lastPressAt > PRESS_REFRACTORY_MS) {
          dyn.pressing = true;
          dyn.pressStart = now;
          dyn.lastPressAt = now;
          h.activeFinger = f;
          h.activeAt = now;
        }
      } else if (dyn.signal < pressOff || now - dyn.pressStart > PRESS_MAX_MS) {
        dyn.pressing = false;
      }
      // Quick extension.
      if (!dyn.extending) {
        if (!dyn.pressing && dyn.signal < -extendOn) {
          dyn.extending = true;
          dyn.extendStart = now;
        }
      } else if (dyn.signal > -extendOn * 0.3 || now - dyn.extendStart > PRESS_MAX_MS) {
        dyn.extending = false;
      }
      dyn.flexGlow = dyn.pressing ? 1 : dyn.flexGlow * decay;
      dyn.extendGlow = dyn.extending ? 1 : dyn.extendGlow * decay;
    }
    if (h.activeFinger && now - h.activeAt > ACTIVE_CLEAR_MS) h.activeFinger = null;
  }
}
