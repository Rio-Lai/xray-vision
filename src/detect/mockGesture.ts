/**
 * Synthetic hands for `?mock=gesture` (and the Node simulations of gestures.ts): a hand seen from
 * the back by the head camera, fingers pointing up the image, posed by a few numbers (wrist
 * position, size, curl, pinch), and a scripted loop that analyses nothing by itself but plays:
 *   right hand comes up, pinches, drags right (turns the model) and lets go with a flick (coasts);
 *   both hands come up, pinch, pull apart (explodes to 1), hold, come together (back to 0.12), let go;
 *   right hand makes a fist and opens it quickly (the burst gesture: only does something with burst on).
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
  /** 0 = apart, 1 = thumb tip on index tip */
  pinch: number;
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
  CHAINS.forEach((chain, k) => {
    const c = k === 0 ? Math.max(curl, 0.35 * pinch) : curl;
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
  // Thumb: folds over the index when curled; meets the index tip when pinching.
  const idxTip = pts[8];
  const idxPip = pts[6];
  const fold = 0.85 * curl;
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

const smooth = (a: number, b: number, t: number) => {
  const u = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return u * u * (3 - 2 * u);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** One loop of the script, in ms. */
export const MOCK_GESTURE_LOOP_MS = 14000;

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
    hands.push({ handedness: pose.left ? 'left' : 'right', score: 0.97, landmarks: syntheticHand(pose, fw, fh) });
  };
  // 0.0-3.4 s: one-hand pinch-drag (turn), flick release at 2.4 s.
  if (s < 3.4) {
    const up = smooth(0.2, 0.8, s) * (1 - smooth(2.8, 3.4, s));
    const drag = smooth(1.1, 2.4, s);
    add({
      wx: lerp(0.38 * fw, 0.38 * fw + 2.6 * hs, drag),
      wy: lerp(below, 0.82 * fh, up) + 0.25 * hs * smooth(1.6, 2.4, s),
      hs,
      curl: 0.15,
      pinch: smooth(0.8, 1.0, s) * (1 - smooth(2.36, 2.46, s)),
      left: false,
      angle: -0.1,
    });
  } else if (s < 9.2) {
    // 3.4-9.2 s: both hands pinch, pull apart (explode), hold, come together, let go.
    const up = smooth(3.4, 4.0, s) * (1 - smooth(8.6, 9.2, s));
    const apart = smooth(4.6, 6.0, s) * (1 - smooth(7.0, 8.2, s));
    const half = lerp(1.1 * hs, 2.6 * hs, apart);
    const pinch = smooth(4.1, 4.35, s) * (1 - smooth(8.3, 8.5, s));
    const wy = lerp(below, 0.86 * fh, up);
    add({ wx: fw / 2 - half - 0.4 * hs, wy, hs, curl: 0.15, pinch, left: true, angle: 0.25 });
    add({ wx: fw / 2 + half + 0.4 * hs, wy, hs, curl: 0.15, pinch, left: false, angle: -0.25 });
  } else {
    // 9.2-14 s: right hand fist, opens quickly (burst open), holds, closes quickly (burst close).
    const up = smooth(9.2, 9.8, s) * (1 - smooth(13.4, 14.0, s));
    const curl = 1 - smooth(10.6, 10.85, s) * (1 - smooth(12.2, 12.45, s));
    add({ wx: 0.56 * fw, wy: lerp(below, 0.84 * fh, up), hs, curl, pinch: 0, left: false, angle: -0.1 });
  }
  return hands;
}
