/**
 * Synthetic hands for `?mock=gesture` (and the Node simulations of gestures.ts): a hand seen from
 * the back by the head camera, fingers pointing up the image, posed by a few numbers (wrist
 * position, size, curl, pinch, per-finger curls, index beside the middle finger), and a scripted loop
 * that plays every hand control of Rio's mapping (15 Nov, third pass) in turn, with a short pause
 * between them, so you can see what each should look like:
 *   1. two-finger pan: right hand comes up, index and middle out and together, ring and pinky curled,
 *      moves right and up (the model follows the two fingertips), back, opens and goes down;
 *   2. two-hand zoom: both hands pinch, pull apart (zooms in), hold, come together (zooms out), let go;
 *   3. globe turn: both open hands come up, hold, move right together (turns it), back left, then one
 *      hand comes closer while the other moves away (turns it too), and back;
 *   4. snap: a hand comes up with the thumb on the middle fingertip, snaps (explodes the model);
 *   5. sweep: a flat open hand at the top of the view sweeps down and out (puts the model away; the
 *      mock analyses the fake laptop again before the loop starts over).
 */
import type { Landmark, RawHand } from './handTracker';

export interface HandPose {
  /** wrist, frame px */
  wx: number;
  wy: number;
  /** wrist -> middle MCP, frame px */
  hs: number;
  /** 0 = open, 1 = fist (index..pinky; the thumb folds with it) */
  curl: number;
  /** curl of the middle, ring and pinky fingers if different (a pinch with the other fingers curled) */
  rest?: number;
  /** curl of each finger (index, middle, ring, pinky) if given: overrides curl and rest (the two-finger pose: [0, 0, 1, 1]) */
  fingers?: [number, number, number, number];
  /** the index finger leans towards the middle finger (1 = tips together, about 0.2 hand sizes apart; negative = spread, a V) */
  pair?: number;
  /** how far the thumb folds over the palm if not with the index curl (0 = out, 1 = folded) */
  thumb?: number;
  /** 0 = apart, 1 = thumb tip on index tip (or on the middle tip with pinchTo 12) */
  pinch: number;
  /** the fingertip the thumb pinches: 8 = index (default), 12 = middle (a snap getting ready) */
  pinchTo?: 8 | 12;
  /** true = left hand (mirrored) */
  left: boolean;
  /** in-plane rotation, radians (0 = fingers straight up the image) */
  angle?: number;
}

/** Right hand, palm away from the camera, fingers up: landmark offsets from the wrist in hand sizes. */
const BASE: [number, number][] = [
  [0, 0],
  [-0.29, -0.16], [-0.53, -0.38], [-0.71, -0.58], [-0.82, -0.75],
  [-0.3, -0.94], [-0.36, -1.3], [-0.39, -1.53], [-0.4, -1.71],
  [0, -1.0], [0, -1.4], [0, -1.65], [0, -1.85],
  [0.28, -0.94], [0.32, -1.3], [0.34, -1.53], [0.36, -1.7],
  [0.53, -0.83], [0.6, -1.11], [0.64, -1.28], [0.67, -1.42],
];
const CHAINS = [
  [5, 6, 7, 8],
  [9, 10, 11, 12],
  [13, 14, 15, 16],
  [17, 18, 19, 20],
];
/** Joint bends at a full fist (radians): MCP, PIP, DIP. */
const BEND = [1.5, 1.75, 1.2];

type P3 = { x: number; y: number; z: number };

/** 21 landmarks (normalised frame coords; z in frame-width units, + = away from the camera). */
export function syntheticHand(p: HandPose, fw: number, fh: number): Landmark[] {
  const pts: P3[] = BASE.map(([x, y]) => ({ x, y, z: 0 }));
  const curl = Math.min(1, Math.max(0, p.curl));
  const pinch = Math.min(1, Math.max(0, p.pinch));
  // Fingers: bend each joint towards the palm (away from the camera); in the image the finger
  // shortens along its own direction.
  const rest = Math.min(1, Math.max(0, p.rest ?? curl));
  CHAINS.forEach((chain, k) => {
    const own = p.fingers ? Math.min(1, Math.max(0, p.fingers[k])) : k === 0 ? curl : rest;
    const c = k === 0 ? Math.max(own, 0.35 * pinch) : own;
    const m = pts[chain[0]];
    const segs = [1, 2, 3].map((j) => {
      const a = BASE[chain[j - 1]];
      const b = BASE[chain[j]];
      return { dx: b[0] - a[0], dy: b[1] - a[1] };
    });
    let ang = 0;
    let x = m.x;
    let y = m.y;
    let z = 0;
    segs.forEach((s, j) => {
      const l = Math.hypot(s.dx, s.dy);
      const ux = s.dx / l;
      const uy = s.dy / l;
      ang += BEND[j] * c;
      x += ux * l * Math.cos(ang);
      y += uy * l * Math.cos(ang);
      z += l * Math.sin(ang);
      pts[chain[j + 1]] = { x, y, z };
    });
  });
  // The index leaning towards the middle finger (in the image plane, about its knuckle).
  if (p.pair) {
    const a = 0.3 * p.pair;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const o = pts[5];
    for (const i of [6, 7, 8]) {
      const q = pts[i];
      const dx = q.x - o.x;
      const dy = q.y - o.y;
      pts[i] = { x: o.x + dx * ca - dy * sa, y: o.y + dx * sa + dy * ca, z: q.z };
    }
  }
  // Thumb: folds over the index when curled; meets the index tip (or the middle tip) when pinching.
  const idxTip = pts[p.pinchTo ?? 8];
  const idxPip = pts[6];
  const fold = 0.85 * (p.thumb ?? curl);
  for (const [i, w] of [[2, 0.3], [3, 0.6], [4, 1]] as [number, number][]) {
    const o = pts[i];
    const toPip = { x: o.x + (idxPip.x - o.x) * fold * w, y: o.y + (idxPip.y - o.y) * fold * w, z: o.z + (idxPip.z + 0.05 - o.z) * fold * w };
    // pinch: tip to just beside the index tip (0.06 hand sizes), the IP joint part of the way
    const goal = i === 4 ? { x: idxTip.x - 0.06, y: idxTip.y + 0.02, z: idxTip.z } : { x: (o.x + idxTip.x) / 2, y: (o.y + idxTip.y) / 2, z: idxTip.z / 2 };
    const t = pinch * (i === 4 ? 1 : i === 3 ? 0.6 : 0.25);
    pts[i] = { x: toPip.x + (goal.x - toPip.x) * t, y: toPip.y + (goal.y - toPip.y) * t, z: toPip.z + (goal.z - toPip.z) * t };
  }
  const ca = Math.cos(p.angle ?? 0);
  const sa = Math.sin(p.angle ?? 0);
  const mx = p.left ? -1 : 1;
  return pts.map((q) => {
    const x = q.x * mx;
    const rx = x * ca - q.y * sa;
    const ry = x * sa + q.y * ca;
    return { x: (p.wx + rx * p.hs) / fw, y: (p.wy + ry * p.hs) / fh, z: (q.z * p.hs) / fw };
  });
}

/** The same hand as MediaPipe's world landmarks would give it: metres around the hand (a hand size is about 9 cm). */
export function syntheticWorld(lm: Landmark[], p: HandPose, fw: number, fh: number): Landmark[] {
  const m = 0.09 / p.hs;
  return lm.map((q) => ({ x: (q.x * fw - p.wx) * m, y: (q.y * fh - p.wy) * m, z: q.z * fw * m }));
}

const smooth = (a: number, b: number, t: number) => {
  const u = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return u * u * (3 - 2 * u);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** One loop of the script, in ms. */
export const MOCK_GESTURE_LOOP_MS = 25000;

/**
 * The scripted hands at `t` ms into the loop (frame 1280 x 720). Hands come up from the bottom
 * of the frame, as the wearer's own hands do with a head camera.
 */
export function mockGestureHands(t: number, fw = 1280, fh = 720): RawHand[] {
  const k = ((t % MOCK_GESTURE_LOOP_MS) + MOCK_GESTURE_LOOP_MS) % MOCK_GESTURE_LOOP_MS;
  const s = k / 1000;
  const hs = 0.14 * fw;
  const below = fh + 1.2 * hs; // out of view
  const hands: RawHand[] = [];
  const add = (pose: HandPose) => {
    if (pose.wy - 2 * pose.hs > fh) return; // fully below the frame: not detected
    const landmarks = syntheticHand(pose, fw, fh);
    hands.push({ handedness: pose.left ? 'left' : 'right', score: 0.97, landmarks, world: syntheticWorld(landmarks, pose, fw, fh) });
  };
  if (s < 3.6) {
    // 1. 0.0-3.6 s: two-finger pan: index and middle together, ring and pinky curled; right and up, back, open, down.
    const up = smooth(0.2, 0.7, s) * (1 - smooth(3.0, 3.6, s));
    const pose = smooth(0.7, 0.9, s) * (1 - smooth(2.95, 3.1, s));
    const move = smooth(1.2, 2.0, s) * (1 - smooth(2.2, 2.9, s));
    add({
      wx: 0.45 * fw + 1.6 * hs * move,
      wy: lerp(below, 0.84 * fh, up) - 0.7 * hs * move,
      hs,
      curl: 0.1,
      fingers: [0.05, 0.05, 0.1 + 0.9 * pose, 0.1 + 0.9 * pose],
      pair: pose,
      pinch: 0,
      left: false,
      angle: -0.15,
    });
  } else if (s < 9.6) {
    // 2. 3.8-9.6 s: both hands pinch, pull apart (zoom in), hold, come together (zoom out), let go.
    const up = smooth(3.8, 4.4, s) * (1 - smooth(9.0, 9.6, s));
    const apart = smooth(5.0, 6.4, s) * (1 - smooth(7.4, 8.6, s));
    const half = lerp(1.1 * hs, 2.6 * hs, apart);
    const pinch = smooth(4.5, 4.75, s) * (1 - smooth(8.7, 8.9, s));
    const wy = lerp(below, 0.86 * fh, up);
    add({ wx: fw / 2 - half - 0.4 * hs, wy, hs, curl: 0.15, pinch, left: true, angle: 0.25 });
    add({ wx: fw / 2 + half + 0.4 * hs, wy, hs, curl: 0.15, pinch, left: false, angle: -0.25 });
  } else if (s >= 10.0 && s < 15.6) {
    // 3. 10.0-15.6 s: two open hands (the globe): right together, back left, then the left hand
    // comes closer while the right moves away, and back; then down.
    const up = smooth(10.0, 10.6, s) * (1 - smooth(15.0, 15.6, s));
    const side = 1.1 * hs * (smooth(11.2, 12.0, s) - smooth(12.4, 13.2, s));
    const depth = 0.2 * (smooth(13.5, 14.1, s) - smooth(14.3, 14.9, s));
    const wy = lerp(below, 0.84 * fh, up);
    add({ wx: fw / 2 - 1.7 * hs + side, wy, hs: hs * (1 + depth), curl: 0.12, pinch: 0, left: true, angle: 0.15 });
    add({ wx: fw / 2 + 1.7 * hs + side, wy, hs: hs * (1 - depth), curl: 0.12, pinch: 0, left: false, angle: -0.15 });
  } else if (s >= 16.0 && s < 18.8) {
    // 4. 16.0-18.8 s: thumb on the middle fingertip, held, then the snap (middle finger into the palm).
    const up = smooth(16.0, 16.6, s) * (1 - smooth(18.2, 18.8, s));
    const snapped = s >= 17.4;
    add({
      wx: 0.6 * fw,
      wy: lerp(below, 0.84 * fh, up),
      hs,
      curl: 0.2,
      rest: snapped ? 1 : 0.3,
      pinch: snapped ? 0 : smooth(16.3, 16.7, s),
      pinchTo: 12,
      left: false,
      angle: -0.1,
    });
  } else if (s >= 19.2 && s < 20.8) {
    // 5. 19.2-20.8 s: a flat open hand at the top of the view sweeps down and out (puts it away).
    const down = smooth(20.0, 20.6, s);
    add({ wx: 0.55 * fw, wy: lerp(0.42 * fh, 1.3 * fh, down), hs, curl: 0.05, pinch: 0, left: false, angle: -0.05 });
  }
  return hands;
}
