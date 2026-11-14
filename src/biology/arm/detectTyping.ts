/**
 * Typing detector: a pure function over the last ~1.5 s of hand landmarks.
 *
 * Typing = forearm pronated (palm facing down, from the palm normal of the hand landmarks)
 *      AND fingertips making small, quick vertical taps (about 2-10 per second) relative to their own knuckle
 *      AND the wrist staying fairly still.
 * Keystrokes: a fingertip's local dip (towards the keys) relative to its MCP = "press"; the rise back = "lift".
 *
 * Coordinates are MediaPipe's normalised image coords. "Down towards the keys" is taken from the hand itself:
 * the palm normal, so it works whatever the camera angle.
 */
import type { FingerId, Keystroke, Landmark, TypingResult } from './types';

export interface HandSample {
  t: number;
  hand: Landmark[];
}

const TIP: Record<FingerId, number> = { thumb: 4, index: 8, middle: 12, ring: 16, little: 20 };
const MCP: Record<FingerId, number> = { thumb: 2, index: 5, middle: 9, ring: 13, little: 17 };
const FINGER_IDS: FingerId[] = ['thumb', 'index', 'middle', 'ring', 'little'];

type V = [number, number, number];
const sub = (a: Landmark, b: Landmark): V => [a.x - b.x, a.y - b.y, a.z - b.z];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: V): V => {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Palm normal pointing out of the palm (right hand; flipped for a left hand). */
export function palmNormal(hand: Landmark[], handedness: 'left' | 'right' = 'right'): V {
  // MediaPipe coords (x right, y down, z away) are right-handed. For a RIGHT hand the index knuckle is on the
  // thumb side, so (index MCP - wrist) x (little MCP - wrist) points out of the palm.
  const n = unit(cross(sub(hand[5], hand[0]), sub(hand[17], hand[0])));
  return handedness === 'right' ? n : [-n[0], -n[1], -n[2]];
}

/** Palm-down score 0..1 for a camera looking down at a desk: palm normal pointing away from the camera (+z in MediaPipe). */
export function pronationScore(hand: Landmark[], handedness: 'left' | 'right' = 'right'): number {
  const n = palmNormal(hand, handedness);
  // MediaPipe z grows away from the camera, so a palm facing away from the camera has n.z > 0.
  return Math.max(0, Math.min(1, n[2] * 1.4 + 0.1));
}

export interface DetectOptions {
  windowMs?: number;
  handedness?: 'left' | 'right';
  /** minimum dip, as a fraction of the hand size (wrist -> middle MCP), to count as a keystroke */
  minDip?: number;
}

export function detectTyping(samples: HandSample[], opts: DetectOptions = {}): TypingResult {
  const windowMs = opts.windowMs ?? 1500;
  const hd = opts.handedness ?? 'right';
  const minDip = opts.minDip ?? 0.035;
  const none = (debug: TypingResult['debug']): TypingResult => ({ activity: 'none', confidence: 0, keystrokes: [], debug });
  if (samples.length < 6) return none({ pronation: 0, tapRate: 0, wristStill: 0, frames: samples.length });
  const tEnd = samples[samples.length - 1].t;
  const win = samples.filter((s) => s.t >= tEnd - windowMs && s.hand && s.hand.length >= 21);
  if (win.length < 6) return none({ pronation: 0, tapRate: 0, wristStill: 0, frames: win.length });

  const handSize = (h: Landmark[]) => Math.hypot(...sub(h[9], h[0])) || 1e-3;
  const size = win.reduce((s, x) => s + handSize(x.hand), 0) / win.length;

  // 1. Palm down (average over the window).
  const pronation = win.reduce((s, x) => s + pronationScore(x.hand, hd), 0) / win.length;

  // 2. Wrist steadiness: how far the wrist wanders, relative to the hand size.
  const wx = win.map((s) => s.hand[0].x);
  const wy = win.map((s) => s.hand[0].y);
  const range = Math.max(Math.max(...wx) - Math.min(...wx), Math.max(...wy) - Math.min(...wy)) / size;
  const wristStill = Math.max(0, Math.min(1, 1 - (range - 0.15) / 0.5));

  // 3. Taps: each fingertip's height above its own knuckle, along the palm normal ("down" = towards the keys).
  //    A press is a local minimum of that height that dips at least minDip below its neighbours.
  const keystrokes: Keystroke[] = [];
  for (const f of FINGER_IDS) {
    const h = win.map((s) => {
      const n = palmNormal(s.hand, hd);
      return dot(sub(s.hand[TIP[f]], s.hand[MCP[f]]), n) / size; // more negative = further from the palm side... see below
    });
    // Height towards the keys: the palm faces the keys, so moving the tip along +palm normal = pressing.
    const depth = h; // larger = pressed further down
    const smooth = depth.map((_, i) => (depth[Math.max(0, i - 1)] + depth[i] + depth[Math.min(depth.length - 1, i + 1)]) / 3);
    let lastPeak = -Infinity;
    let state: 'up' | 'down' = 'up';
    let base = smooth[0];
    for (let i = 1; i < smooth.length; i++) {
      const v = smooth[i];
      if (state === 'up') {
        base = Math.min(base, v);
        if (v - base > minDip && win[i].t - lastPeak > 90) {
          keystrokes.push({ finger: f, kind: 'press', t: win[i].t });
          state = 'down';
          lastPeak = win[i].t;
          base = v;
        }
      } else {
        base = Math.max(base, v);
        if (base - v > minDip * 0.7) {
          keystrokes.push({ finger: f, kind: 'lift', t: win[i].t });
          state = 'up';
          base = v;
        }
      }
    }
  }
  const presses = keystrokes.filter((k) => k.kind === 'press').length;
  const secs = Math.max(0.3, (win[win.length - 1].t - win[0].t) / 1000);
  const tapRate = presses / secs;
  // 2-10 taps per second is typing; outside that range the score falls off.
  const rateScore = tapRate < 1 ? tapRate / 2 : tapRate <= 10 ? Math.min(1, tapRate / 2) : Math.max(0, 1 - (tapRate - 10) / 6);

  const confidence = Math.round(Math.min(pronation, 1) * rateScore * wristStill * 100) / 100;
  keystrokes.sort((a, b) => a.t - b.t);
  return {
    activity: confidence >= 0.45 ? 'typing' : 'none',
    confidence,
    keystrokes,
    debug: { pronation: Math.round(pronation * 100) / 100, tapRate: Math.round(tapRate * 10) / 10, wristStill: Math.round(wristStill * 100) / 100, frames: win.length },
  };
}
