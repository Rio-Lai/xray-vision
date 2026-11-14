/**
 * Make a plausible SYNTHETIC typing trace (right arm), so the arm can be built and tested before the rig works.
 * Replace it with a real recording (record mode, R key in /arm-demo) as soon as the camera rig runs.
 *
 *   npx tsx scripts/arm/make-trace.ts  ->  public/cache/arm-hand/typing-trace.json
 *
 * Geometry in metres, in the CAMERA frame: x right, y down (image), z away from the camera. The head camera
 * looks down at the desk at ~45 degrees from the typist's right. Then mapped to MediaPipe-style normalised
 * coords (x, y in 0..1 of a 16:9 frame, z on the x scale; hand z relative to the hand's wrist).
 */
import fs from 'node:fs';
import path from 'node:path';

type V = [number, number, number];
const add = (...vs: V[]): V => vs.reduce((a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], [0, 0, 0] as V);
const mul = (v: V, s: number): V => [v[0] * s, v[1] * s, v[2] * s];
const unit = (v: V): V => {
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
};

// desk axes in the camera frame
const up = unit([0, -0.72, -0.69]); // world up: image-up and towards the camera
const fwd: V = [1, 0, 0]; // forearm points to the right of the image, towards the keys
const left = unit([up[1] * fwd[2] - up[2] * fwd[1], up[2] * fwd[0] - up[0] * fwd[2], up[0] * fwd[1] - up[1] * fwd[0]]); // typist's left (body midline)

// seeded random so the trace is reproducible
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

const FPS = 30;
const SECONDS = 10;
const FINGERS = ['thumb', 'index', 'middle', 'ring', 'little'] as const;
type F = (typeof FINGERS)[number];

// keystroke schedule: ~5 presses/s across the four fingers, thumb on the space bar every ~1.2 s
const presses: { f: F; t: number }[] = [];
for (let t = 300; t < SECONDS * 1000 - 200; t += 140 + rnd() * 120) {
  const f = (['index', 'middle', 'ring', 'little', 'index', 'middle'] as F[])[Math.floor(rnd() * 6)];
  presses.push({ f, t });
}
for (let t = 900; t < SECONDS * 1000 - 200; t += 1000 + rnd() * 500) presses.push({ f: 'thumb', t });

/** extra flexion (radians) of a finger at time t: a quick dip of ~100 ms per press */
function press(f: F, t: number): number {
  let a = 0;
  for (const p of presses) {
    if (p.f !== f) continue;
    const d = t - p.t;
    if (d >= 0 && d < 110) a = Math.max(a, Math.sin((Math.PI * d) / 110) * (f === 'thumb' ? 0.22 : 0.3));
  }
  return a;
}

function frameAt(tMs: number) {
  const sway = (k: number, a: number) => a * Math.sin(tMs * 0.0011 * k + k);
  const S: V = [-0.17, -0.2, 0.62]; // right shoulder, metres from the camera axis
  const E = add(S, mul(up, -0.27), mul(fwd, 0.06), mul(left, -0.02), [sway(1, 0.002), sway(2, 0.002), 0]);
  const W = add(E, mul(fwd, 0.25), mul(up, 0.035), mul(left, 0.03), [sway(3, 0.0015), sway(4, 0.0015), 0]);
  const hand: V[] = new Array(21);
  hand[0] = W;
  // knuckles: index on the thumb side (= towards the body midline when the palm faces down)
  const mcpSide: Record<Exclude<F, 'thumb'>, number> = { index: 0.032, middle: 0.009, ring: -0.013, little: -0.033 };
  const mcpFwd: Record<Exclude<F, 'thumb'>, number> = { index: 0.088, middle: 0.093, ring: 0.088, little: 0.078 };
  const seg: Record<Exclude<F, 'thumb'>, [number, number, number]> = {
    index: [0.044, 0.026, 0.021],
    middle: [0.048, 0.03, 0.022],
    ring: [0.045, 0.028, 0.021],
    little: [0.035, 0.021, 0.019],
  };
  const ids: Record<F, number[]> = { thumb: [1, 2, 3, 4], index: [5, 6, 7, 8], middle: [9, 10, 11, 12], ring: [13, 14, 15, 16], little: [17, 18, 19, 20] };
  for (const f of ['index', 'middle', 'ring', 'little'] as const) {
    const mcp = add(W, mul(fwd, mcpFwd[f]), mul(left, mcpSide[f]), mul(up, 0.012));
    const extra = press(f, tMs);
    // curled fingers: MCP ~20, PIP ~45, DIP ~25 degrees; a press adds flexion at the MCP and PIP
    const angles = [0.35 + extra, 0.8 + extra * 0.6, 0.45];
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
  // thumb: CMC near the wrist on the thumb side, tip down on the space bar
  const te = press('thumb', tMs);
  const cmc = add(W, mul(fwd, 0.028), mul(left, 0.03), mul(up, -0.008));
  const tmcp = add(cmc, mul(fwd, 0.03), mul(left, 0.022), mul(up, -0.016));
  const tip1 = add(tmcp, mul(fwd, 0.026), mul(left, 0.006), mul(up, -0.018 - te * 0.03));
  const tip2 = add(tip1, mul(fwd, 0.022), mul(left, -0.002), mul(up, -0.012 - te * 0.04));
  [cmc, tmcp, tip1, tip2].forEach((v, k) => (hand[ids.thumb[k]] = v));

  // camera-frame metres -> normalised image coords (simple pinhole, focal ~ 0.9 of the width)
  const fx = 0.9;
  const aspect = 16 / 9;
  const toN = (v: V) => ({ x: 0.5 + (fx * v[0]) / v[2], y: 0.5 + (fx * v[1] * aspect) / v[2], z: 0 });
  const jitter = () => (rnd() - 0.5) * 0.0016;
  const pose = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0 }));
  const S2 = add(S, mul(left, 0.36));
  const posePts: Record<number, V> = { 12: S, 14: E, 16: W, 11: S2 };
  for (const [i, v] of Object.entries(posePts)) {
    const n = toN(v);
    // pose z: depth relative to the hips, on the x scale (MediaPipe convention); smaller = closer
    pose[Number(i)] = { x: n.x + jitter(), y: n.y + jitter(), z: (v[2] - 0.62) * fx, visibility: 0.98 };
  }
  const handN = hand.map((v) => {
    const n = toN(v);
    return { x: n.x + jitter() * 0.5, y: n.y + jitter() * 0.5, z: (v[2] - W[2]) * fx };
  });
  const r4 = (o: { x: number; y: number; z: number; visibility?: number }) => ({
    x: Math.round(o.x * 1e4) / 1e4,
    y: Math.round(o.y * 1e4) / 1e4,
    z: Math.round(o.z * 1e4) / 1e4,
    ...(o.visibility !== undefined ? { visibility: o.visibility } : {}),
  });
  return { t: Math.round(tMs), pose: pose.map(r4), hand: handN.map(r4), handedness: 'right' as const };
}

const frames = Array.from({ length: FPS * SECONDS }, (_, i) => frameAt((i * 1000) / FPS));
const out = {
  source: 'synthetic',
  note: 'Generated by scripts/arm/make-trace.ts. Replace with a real recording from the rig (R in /arm-demo).',
  fps: FPS,
  side: 'right',
  aspect: 16 / 9,
  presses: presses.sort((a, b) => a.t - b.t).map((p) => ({ finger: p.f === 'little' ? 'little' : p.f, t: Math.round(p.t) })),
  frames,
};
const file = path.resolve('public/cache/arm-hand/typing-trace.json');
fs.writeFileSync(file, JSON.stringify(out));
console.log(`${file}: ${frames.length} frames, ${presses.length} presses, ${(fs.statSync(file).size / 1e3).toFixed(0)} KB`);
