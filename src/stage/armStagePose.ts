/**
 * The fixed pose of Kash's arm on stage: a right arm typing, elbow bent, palm down, fingers
 * curled over the keys. No pose tracking: the arm floats in the middle of the view like the
 * MacBook model and is turned by hand or voice, so it only needs one natural pose.
 *
 * The pose is the rest frame of his synthetic typing trace (scripts/arm/make-trace.ts, no key
 * pressed, no sway), built in metres in a camera frame (x right, y down, z away; the camera looks
 * down at the desk from the typist's right), then turned into MediaPipe-style landmarks for a
 * W x H canvas so that his renderer (frames.ts: X = (x - 0.5) W, Y = (0.5 - y) H, Z = -z W) gets
 * exactly these proportions, at `pxPerM` pixels per metre, with the arm's turning centre (his
 * pivot: the mean of shoulder, elbow, wrist and middle fingertip) at `centre` (px from the
 * canvas centre, +y up).
 */
import type { ArmFrame, Landmark } from '../biology/arm/types';

type V = [number, number, number];
const add = (...vs: V[]): V => vs.reduce<V>((a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], [0, 0, 0]);
const mul = (v: V, s: number): V => [v[0] * s, v[1] * s, v[2] * s];
const unit = (v: V): V => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const dist = (a: V, b: V) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

type Finger = 'index' | 'middle' | 'ring' | 'little';

interface ArmPoints {
  shoulder: V;
  leftShoulder: V;
  elbow: V;
  wrist: V;
  /** 21 hand landmarks (MediaPipe order), wrist first */
  hand: V[];
}

/** Same construction as scripts/arm/make-trace.ts frameAt(), at rest. */
function restPose(): ArmPoints {
  const up = unit([0, -0.72, -0.69]); // world up: image-up and towards the camera
  const fwd: V = [1, 0, 0]; // forearm points to the right of the image, towards the keys
  const left = unit([up[1] * fwd[2] - up[2] * fwd[1], up[2] * fwd[0] - up[0] * fwd[2], up[0] * fwd[1] - up[1] * fwd[0]]);
  const S: V = [-0.2, -0.17, 0.9];
  const E = add(S, mul(up, -0.27), mul(fwd, 0.06), mul(left, -0.02));
  const W = add(E, mul(fwd, 0.25), mul(up, 0.035), mul(left, 0.03));
  const hand: V[] = new Array<V>(21).fill([0, 0, 0]);
  hand[0] = W;
  const mcpSide: Record<Finger, number> = { index: 0.032, middle: 0.009, ring: -0.013, little: -0.033 };
  const mcpFwd: Record<Finger, number> = { index: 0.088, middle: 0.093, ring: 0.088, little: 0.078 };
  const seg: Record<Finger, [number, number, number]> = {
    index: [0.044, 0.026, 0.021],
    middle: [0.048, 0.03, 0.022],
    ring: [0.045, 0.028, 0.021],
    little: [0.035, 0.021, 0.019],
  };
  const ids: Record<Finger | 'thumb', number[]> = { thumb: [1, 2, 3, 4], index: [5, 6, 7, 8], middle: [9, 10, 11, 12], ring: [13, 14, 15, 16], little: [17, 18, 19, 20] };
  for (const f of ['index', 'middle', 'ring', 'little'] as const) {
    const mcp = add(W, mul(fwd, mcpFwd[f]), mul(left, mcpSide[f]), mul(up, 0.012));
    // curled fingers: MCP ~20, PIP ~45, DIP ~25 degrees
    const angles = [0.35, 0.8, 0.45];
    let theta = 0;
    let p = mcp;
    const pts: V[] = [mcp];
    for (let k = 0; k < 3; k++) {
      theta += angles[k];
      const dir = add(mul(fwd, Math.cos(theta)), mul(up, -Math.sin(theta)), mul(left, mcpSide[f] * 0.35));
      p = add(p, mul(unit(dir), seg[f][k]));
      pts.push(p);
    }
    ids[f].forEach((id, k) => (hand[id] = pts[k]));
  }
  // thumb: CMC near the wrist on the thumb side, tip resting on the space bar
  const cmc = add(W, mul(fwd, 0.028), mul(left, 0.03), mul(up, -0.008));
  const tmcp = add(cmc, mul(fwd, 0.03), mul(left, 0.022), mul(up, -0.016));
  const tip1 = add(tmcp, mul(fwd, 0.026), mul(left, 0.006), mul(up, -0.018));
  const tip2 = add(tip1, mul(fwd, 0.022), mul(left, -0.002), mul(up, -0.012));
  [cmc, tmcp, tip1, tip2].forEach((v, k) => (hand[ids.thumb[k]] = v));
  return { shoulder: S, leftShoulder: add(S, mul(left, 0.36)), elbow: E, wrist: W, hand };
}

const REST = restPose();
/** The turning centre, as ArmXrayView computes it (shoulder, elbow, wrist, middle fingertip). */
const CENTRE: V = mul(add(REST.shoulder, REST.elbow, REST.wrist, REST.hand[12]), 0.25);
const UPPER_LEN = dist(REST.shoulder, REST.elbow);

/**
 * Radius (metres) of the arm about its turning centre, whatever way it faces: the furthest
 * landmark plus the soft tissue around the bones (the skin sleeve is 0.2 x the upper-arm length
 * at the shoulder). Sizes the arm like the MacBook model (a disc that fits at any yaw).
 */
export const ARM_RADIUS_M: number =
  Math.max(...[REST.shoulder, REST.elbow, REST.wrist, ...REST.hand].map((p) => dist(p, CENTRE))) + 0.12 * UPPER_LEN;

/**
 * MediaPipe-style landmarks (pose: 33 points, right arm at 12 / 14 / 16; hand: 21 points) that
 * put the resting arm on a W x H canvas at `pxPerM`, its turning centre at `centre` px from the
 * canvas centre (+x right, +y up).
 */
export function armStageFrame(W: number, H: number, pxPerM: number, centre: { x: number; y: number }): ArmFrame {
  const w = Math.max(1, W);
  const h = Math.max(1, H);
  const toLm = (v: V): Landmark => ({
    x: 0.5 + (pxPerM * (v[0] - CENTRE[0]) + centre.x) / w,
    y: 0.5 + (pxPerM * (v[1] - CENTRE[1]) - centre.y) / h,
    z: (pxPerM * (v[2] - CENTRE[2])) / w,
  });
  const pose: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0 }));
  pose[11] = { ...toLm(REST.leftShoulder), visibility: 0.98 };
  pose[12] = { ...toLm(REST.shoulder), visibility: 0.98 };
  pose[14] = { ...toLm(REST.elbow), visibility: 0.98 };
  pose[16] = { ...toLm(REST.wrist), visibility: 0.98 };
  return { t: 0, pose, hand: REST.hand.map(toLm), handedness: 'right' };
}
