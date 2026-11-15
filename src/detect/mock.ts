/**
 * ?mock=1 data: a laptop box and an animated right hand (palm down, seen from above,
 * fingers pointing up the image) that "types": one finger presses every second, and every
 * fourth beat a finger lifts quickly (extension) so both glows can be tested without a camera.
 * Both are always in view. `?mock=1` puts the laptop in the centre (it is "this");
 * `?mock=hand` puts the hand in the centre and the laptop off to the left;
 * `?mock=eye` (#94) puts a face in the centre (its nearer eye is "this"), the laptop off to the left
 * and the hand off to the right. The face blinks every few seconds and looks around, so get_pose's
 * `eyes` can be checked too.
 */
import type { SceneObject } from '../state/store';
import type { FingerName } from '../state/store';
import type { Landmark } from './handTracker';
import { FINGER_CHAINS } from './handTracker';
import type { FaceMeasure } from './faceTracker';

export function mockLaptop(centred: boolean): SceneObject {
  return {
    id: 'laptop-1',
    label: 'laptop',
    confidence: 0.93,
    box: centred ? { x: 0.3, y: 0.26, w: 0.4, h: 0.48 } : { x: 0.03, y: 0.3, w: 0.28, h: 0.34 },
    lens: 'engineering',
    anchor: 'box',
  };
}

/**
 * #124: a plastic bottle, an object that is not stored, so "analyse this" on it shows a solid sketch.
 * On the right in `?mock=1` (select it, or say "explode bottle-1"); in the middle with `?mock=bottle`.
 * Its look is built in (src/lib/look.ts): no camera and no key needed.
 */
export function mockBottle(centred: boolean): SceneObject {
  return {
    id: 'bottle-1',
    label: 'bottle',
    confidence: 0.88,
    box: centred ? { x: 0.45, y: 0.25, w: 0.1, h: 0.42 } : { x: 0.8, y: 0.3, w: 0.07, h: 0.3 },
    lens: 'engineering',
    anchor: 'box',
  };
}

/** A small phone at the lower left, so "everything is labelled" can be seen in mock mode. */
export function mockPhone(): SceneObject {
  return {
    id: 'cell-phone-1',
    label: 'cell phone',
    confidence: 0.81,
    box: { x: 0.12, y: 0.7, w: 0.08, h: 0.16 },
    lens: 'engineering',
    anchor: 'box',
  };
}

/** Base pose in px of a 1280x720 frame. Index = MediaPipe landmark index. */
const BASE_PX: [number, number][] = [
  [640, 600], // 0 wrist
  [588, 572], // 1 thumb cmc
  [545, 532], // 2 thumb mcp
  [514, 497], // 3 thumb ip
  [494, 466], // 4 thumb tip
  [586, 432], // 5 index mcp
  [576, 368], // 6
  [571, 328], // 7
  [568, 296], // 8 index tip
  [640, 422], // 9 middle mcp
  [640, 350], // 10
  [640, 306], // 11
  [640, 270], // 12 middle tip
  [690, 432], // 13 ring mcp
  [697, 368], // 14
  [701, 328], // 15
  [704, 298], // 16 ring tip
  [734, 452], // 17 pinky mcp
  [747, 402], // 18
  [754, 372], // 19
  [759, 347], // 20 pinky tip
];

const SEQUENCE: { finger: FingerName; kind: 'press' | 'extend' }[] = [
  { finger: 'index', kind: 'press' },
  { finger: 'middle', kind: 'press' },
  { finger: 'ring', kind: 'press' },
  { finger: 'index', kind: 'extend' },
  { finger: 'pinky', kind: 'press' },
  { finger: 'thumb', kind: 'press' },
  { finger: 'middle', kind: 'press' },
  { finger: 'middle', kind: 'extend' },
];

const BEAT_MS = 1000;
const HAND_SIZE_PX = 178; // |wrist - middle mcp| in BASE_PX

/** Displacement in hand sizes (+ = down the image) for a beat phase in ms. */
function profile(kind: 'press' | 'extend', t: number): number {
  if (kind === 'press') {
    if (t < 100) return 0.2 * Math.sin((t / 100) * (Math.PI / 2)); // fast down
    if (t < 450) return 0.2 * Math.cos(((t - 100) / 350) * (Math.PI / 2)); // slow up
    return 0;
  }
  if (t < 100) return -0.25 * Math.sin((t / 100) * (Math.PI / 2)); // fast lift
  if (t < 950) return -0.25 * Math.cos(((t - 100) / 850) * (Math.PI / 2)); // slow return (stays under the press threshold)
  return 0;
}

/** `dx`: horizontal shift as a fraction of the frame width (0 = centred). */
export function mockHandLandmarks(now: number, dx = 0): Landmark[] {
  const beat = Math.floor(now / BEAT_MS);
  const t = now - beat * BEAT_MS;
  const step = SEQUENCE[beat % SEQUENCE.length];
  const chain = FINGER_CHAINS[step.finger];
  const d = profile(step.kind, t) * HAND_SIZE_PX;
  const sway = Math.sin(now / 1700) * 6; // tiny drift so it looks alive
  return BASE_PX.map(([x, y], i) => {
    let dy = 0;
    if (i === chain[3]) dy = d;
    else if (i === chain[2]) dy = d * 0.5;
    else if (i === chain[1]) dy = d * 0.15;
    return { x: (x + sway) / 1280 + dx, y: (y + dy) / 720, z: 0 };
  });
}

/** px of a 1280x720 frame -> frame-normalised box */
const pxBox = (cx: number, cy: number, w: number, h: number) => ({ x: (cx - w / 2) / 1280, y: (cy - h / 2) / 720, w: w / 1280, h: h / 720 });

/** Gaze script for the mock face (ms into a 12 s loop): straight ahead, to the image's right, down (reading), up. */
function mockGaze(t: number): { gazeX: number; up: number; down: number } {
  const k = t % 12000;
  if (k < 4000) return { gazeX: 0, up: 0, down: 0 };
  if (k < 6500) return { gazeX: 0.12, up: 0, down: 0 };
  if (k < 9500) return { gazeX: 0, up: 0, down: 0.6 };
  if (k < 11000) return { gazeX: 0, up: 0.5, down: 0 };
  return { gazeX: -0.12, up: 0, down: 0 };
}

/**
 * ?mock=eye: a face in the middle of the view, a little left of centre so its right eye (on the
 * image's left) is the nearer one. Blinks for 150 ms every 4 s.
 */
export function mockFace(now: number): FaceMeasure {
  const sway = Math.sin(now / 1900) * 5;
  const cx = 652 + sway;
  const cy = 345;
  const closed = now % 4000 < 150 ? 1 : 0;
  const g = mockGaze(now);
  return {
    outline: pxBox(cx, cy, 230, 300),
    eyes: {
      // camera not mirrored: the person's right eye is on the image's left
      right: { box: pxBox(cx - 40, cy - 28, 62, 40), closed, gazeX: g.gazeX },
      left: { box: pxBox(cx + 40, cy - 28, 62, 40), closed, gazeX: g.gazeX },
    },
    up: g.up,
    down: g.down,
    headYaw: 0,
    headPitch: 0,
    score: 0.95,
  };
}
