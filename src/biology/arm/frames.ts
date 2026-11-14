/**
 * Landmarks -> 3D points and local anatomical directions.
 *
 * World space (shared with ArmXray): pixels of the overlay canvas, origin at the centre,
 * +x right, +y up, +z towards the viewer. MediaPipe gives x, y in 0..1 (y down) and z with
 * "smaller = closer to the camera" on roughly the x scale, so: X = (x-0.5)W, Y = (0.5-y)H, Z = -zW.
 * Hand landmark z is relative to the hand's wrist, so the hand is hung off the pose wrist.
 */
import * as THREE from 'three';
import type { ArmFrame, FingerId, Landmark } from './types';

export const POSE = { shoulder: 12, elbow: 14, wrist: 16 } as const; // right arm (left: 11, 13, 15)
export const POSE_LEFT = { shoulder: 11, elbow: 13, wrist: 15 } as const;
export const HAND: Record<FingerId, [number, number, number, number]> = {
  thumb: [1, 2, 3, 4],
  index: [5, 6, 7, 8],
  middle: [9, 10, 11, 12],
  ring: [13, 14, 15, 16],
  little: [17, 18, 19, 20],
};

export interface Points {
  shoulder: THREE.Vector3;
  elbow: THREE.Vector3;
  wrist: THREE.Vector3;
  /** 21 hand points in world space (hand wrist moved onto the pose wrist) */
  hand: THREE.Vector3[];
}

/** Local directions at a place along the limb. Unit vectors, mutually perpendicular to `axis`. */
export interface Frame {
  axis: THREE.Vector3;
  /** anterior = palm side / front of the arm */
  anterior: THREE.Vector3;
  /** lateral = thumb side / away from the body (anatomical position) */
  lateral: THREE.Vector3;
}

export interface ArmGeometry {
  p: Points;
  upper: Frame;
  /** frame at the elbow, used for the proximal ends of forearm parts (epicondyles) */
  elbowFrame: Frame;
  /** frame at the wrist from the hand: anterior = out of the palm, lateral = thumb side */
  hand: Frame;
  upperLen: number;
  foreLen: number;
  handLen: number;
  /** 1 = palm fully down (pronated), -1 = palm up (supinated) */
  pronation: number;
}

const toWorld = (l: Landmark, W: number, H: number) => new THREE.Vector3((l.x - 0.5) * W, (0.5 - l.y) * H, -l.z * W);

const perp = (v: THREE.Vector3, axis: THREE.Vector3) => v.clone().sub(axis.clone().multiplyScalar(v.dot(axis))).normalize();

/**
 * Build points and frames. Returns null if the frame has no usable pose or hand.
 * `side` = which arm ('right' uses pose 12/14/16).
 */
export function armGeometry(f: ArmFrame, W: number, H: number, side: 'right' | 'left' = 'right'): ArmGeometry | null {
  if (!f.pose || !f.hand || f.pose.length < 17 || f.hand.length < 21) return null;
  const P = side === 'right' ? POSE : POSE_LEFT;
  const shoulder = toWorld(f.pose[P.shoulder], W, H);
  const elbow = toWorld(f.pose[P.elbow], W, H);
  const wrist = toWorld(f.pose[P.wrist], W, H);
  const handRaw = f.hand.map((l) => toWorld(l, W, H));
  const shift = wrist.clone().sub(handRaw[0]);
  const hand = handRaw.map((v) => v.add(shift));

  const upperAxis = elbow.clone().sub(shoulder).normalize();
  const foreAxis = wrist.clone().sub(elbow).normalize();
  const sign = side === 'right' ? 1 : -1;

  // Hand frame: palm normal from the knuckles. World space here keeps MediaPipe's handedness (y and z are both
  // flipped), and for a RIGHT hand (index MCP - wrist) x (little MCP - wrist) points out of the PALM.
  const a = hand[5].clone().sub(hand[0]);
  const b = hand[17].clone().sub(hand[0]);
  const palm = new THREE.Vector3().crossVectors(a, b).normalize().multiplyScalar(sign);
  const handAxis = hand[9].clone().sub(hand[0]).normalize();
  const handAnterior = perp(palm, handAxis);
  const handLateral = perp(hand[5].clone().sub(hand[17]), handAxis); // thumb side

  // Upper arm: with the elbow bent the forearm points forwards, so "anterior" = forearm direction across the
  // upper arm. If the elbow is nearly straight, fall back to the palm direction.
  let upperAnterior = perp(foreAxis.clone(), upperAxis);
  if (Math.abs(foreAxis.dot(upperAxis)) > 0.97) upperAnterior = perp(handAnterior.clone(), upperAxis);
  // Lateral (away from the body). For a right arm, axis (down the arm) x anterior points laterally.
  // (Checked against the synthetic trace: the other order pointed to the body midline, i.e. medially.)
  const upperLateral = new THREE.Vector3().crossVectors(upperAxis, upperAnterior).normalize().multiplyScalar(sign);

  // At the elbow the epicondyles follow the humerus: same lateral, re-orthogonalised to the forearm.
  const elbowLateral = perp(upperLateral.clone(), foreAxis);
  const elbowAnterior = new THREE.Vector3().crossVectors(elbowLateral, foreAxis).normalize().multiplyScalar(sign);

  // Pronation for the overlay: with the head camera looking down at a keyboard, "palm down" = the palm normal
  // points away from the camera (-z). 1 = palm fully down, -1 = palm facing the camera.
  const pronation = -handAnterior.z;

  return {
    p: { shoulder, elbow, wrist, hand },
    upper: { axis: upperAxis, anterior: upperAnterior, lateral: upperLateral },
    elbowFrame: { axis: foreAxis, anterior: elbowAnterior, lateral: elbowLateral },
    hand: { axis: handAxis, anterior: handAnterior, lateral: handLateral },
    upperLen: shoulder.distanceTo(elbow),
    foreLen: elbow.distanceTo(wrist),
    handLen: hand[0].distanceTo(hand[12]),
    pronation: THREE.MathUtils.clamp(pronation, -1, 1),
  };
}

/** Normalised lerp of two frames (for points along the forearm between the elbow and the wrist). */
export function blendFrames(a: Frame, b: Frame, t: number, axis: THREE.Vector3): Frame {
  const ant = perp(a.anterior.clone().lerp(b.anterior, t), axis);
  const lat = perp(a.lateral.clone().lerp(b.lateral, t), axis);
  // keep them perpendicular to each other
  const lat2 = perp(lat.clone().sub(ant.clone().multiplyScalar(lat.dot(ant))), axis);
  return { axis, anterior: ant, lateral: lat2 };
}

/** Point named like the teardown JSON: "pose.shoulder", "pose.elbow>wrist@0.1", "hand.index_tip", "hand.wrist"... */
export function namedPoint(g: ArmGeometry, ref: string): THREE.Vector3 {
  // split on the FIRST dot only: "pose.shoulder>elbow@0.75" has another dot in the fraction
  const dot = ref.indexOf('.');
  const space = ref.slice(0, dot);
  const rest = ref.slice(dot + 1);
  if (space === 'pose') {
    const m = rest.match(/^(\w+)(?:>(\w+)@([\d.]+))?$/);
    if (!m) throw new Error(`bad landmark ref ${ref}`);
    const pick = (n: string) => (g.p as unknown as Record<string, THREE.Vector3>)[n];
    const a = pick(m[1]);
    if (!m[2]) return a.clone();
    return a.clone().lerp(pick(m[2]), Number(m[3]));
  }
  if (space === 'hand') {
    const lerpM = rest.match(/^(\w+)>(\w+)@([\d.]+)$/);
    if (lerpM) return namedPoint(g, `hand.${lerpM[1]}`).lerp(namedPoint(g, `hand.${lerpM[2]}`), Number(lerpM[3]));
    if (rest === 'wrist') return g.p.hand[0].clone();
    if (rest === 'fingertips') return g.p.hand[12].clone();
    const m = rest.match(/^(thumb|index|middle|ring|little)_(cmc|mcp|pip|dip|ip|tip)$/);
    if (!m) throw new Error(`bad landmark ref ${ref}`);
    const ids = HAND[m[1] as FingerId];
    const k = { cmc: 0, mcp: m[1] === 'thumb' ? 1 : 0, pip: 1, ip: 2, dip: 2, tip: 3 }[m[2]]!;
    return g.p.hand[ids[k]].clone();
  }
  throw new Error(`bad landmark ref ${ref}`);
}
