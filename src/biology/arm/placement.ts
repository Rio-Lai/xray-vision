/**
 * Where each fal mesh sits on the tracked arm.
 *
 * Every mesh is normalised to y = 0 (proximal) .. 1 (distal) (scripts/arm/normalise.ts). A placement gives a
 * path of anchors: 2 anchors = the mesh is placed rigidly between them; 3+ = the mesh is bent along the path
 * (nerves, arteries, tendons, which run round the elbow and wrist).
 *
 * Anchor offsets are in units of the local limb radius:
 *   a = anterior (+, palm side / front)  vs posterior (-)
 *   l = lateral  (+, thumb side / away from the body in anatomical position)  vs medial (-)
 * Frames: 'upper' = upper arm, 'fore' = forearm (blends elbow -> hand frame), 'hand' = palm frame.
 * Because the proximal ends of forearm parts use the elbow frame and the distal ends use the hand frame,
 * the radius and ulna cross over by themselves when the hand turns palm-down.
 */
import type { FingerId } from './types';

export interface Anchor {
  /** teardown-style ref: pose.shoulder, pose.elbow>wrist@0.5, hand.index_mcp, hand.wrist>middle_mcp@0.3 */
  p: string;
  f?: 'upper' | 'fore' | 'hand';
  a?: number;
  l?: number;
}

export interface Placement {
  /** mesh id (public/cache/arm-hand/<mesh>.glb) */
  mesh: string;
  part: string;
  /** instance label, e.g. "index" for per-finger copies */
  key: string;
  path: Anchor[];
  /**
   * Sideways size as a fraction of the upper-arm length (keeps muscle thickness sensible whatever shape
   * fal returned). Omit for uniform scaling (bones keep their own proportions).
   */
  girth?: number;
  /** which limb direction the mesh's wide side (its x axis) lies along */
  xAlong?: 'lateral' | 'anterior' | 'axis';
  /** finger this instance belongs to (keystroke pulses) */
  finger?: FingerId;
}

const FOUR: FingerId[] = ['index', 'middle', 'ring', 'little'];
const ALL: FingerId[] = ['thumb', 'index', 'middle', 'ring', 'little'];
/** spread of the finger tendons across the carpal tunnel / back of the wrist (lateral offset) */
const SPREAD: Record<FingerId, number> = { thumb: 0.55, index: 0.3, middle: 0.1, ring: -0.1, little: -0.3 };

function fingerJoints(f: FingerId) {
  return f === 'thumb'
    ? { base: 'hand.thumb_cmc', mcp: 'hand.thumb_mcp', pip: 'hand.thumb_ip', dip: 'hand.thumb_ip', tip: 'hand.thumb_tip' }
    : { base: `hand.wrist>${f}_mcp@0.14`, mcp: `hand.${f}_mcp`, pip: `hand.${f}_pip`, dip: `hand.${f}_dip`, tip: `hand.${f}_tip` };
}

export function placements(): Placement[] {
  const out: Placement[] = [
    // ---- layer 2: superficial muscles
    // deltoid caps the head of the humerus: starts just above the shoulder point
    // deltoid: a cupped shell over the shoulder, origin around the acromion, insertion at the deltoid tuberosity
    { mesh: 'deltoid', part: 'deltoid', key: '', girth: 0.3, xAlong: 'anterior', path: [{ p: 'pose.elbow>shoulder@1.04', f: 'upper', l: 0.3 }, { p: 'pose.shoulder>elbow@0.45', f: 'upper', l: 0.7 }] },
    { mesh: 'biceps', part: 'biceps', key: '', girth: 0.17, path: [{ p: 'pose.shoulder>elbow@0.06', f: 'upper', a: 0.45 }, { p: 'pose.elbow>wrist@0.1', f: 'fore', a: 0.5 }] },
    { mesh: 'triceps', part: 'triceps', key: '', girth: 0.2, path: [{ p: 'pose.shoulder>elbow@0.1', f: 'upper', a: -0.5 }, { p: 'pose.elbow', f: 'upper', a: -0.65 }] },
    { mesh: 'brachioradialis', part: 'brachioradialis', key: '', girth: 0.08, xAlong: 'anterior', path: [{ p: 'pose.shoulder>elbow@0.75', f: 'upper', l: 0.75 }, { p: 'pose.wrist', f: 'hand', l: 0.75, a: 0.1 }] },
    // flexors: common origin on the MEDIAL epicondyle, bellies on the palm side
    { mesh: 'forearm-flexors', part: 'forearm-flexors', key: '', girth: 0.17, path: [{ p: 'pose.elbow', f: 'fore', l: -0.6, a: 0.25 }, { p: 'pose.wrist', f: 'hand', a: 0.55, l: -0.05 }] },
    // extensors: common origin on the LATERAL epicondyle, on the back of the forearm
    { mesh: 'forearm-extensors', part: 'forearm-extensors', key: '', girth: 0.16, path: [{ p: 'pose.elbow', f: 'fore', l: 0.6, a: -0.2 }, { p: 'pose.wrist', f: 'hand', a: -0.55, l: 0.05 }] },
    { mesh: 'thenar', part: 'thenar', key: '', girth: 0.05, path: [{ p: 'hand.wrist', f: 'hand', l: 0.45, a: 0.7 }, { p: 'hand.thumb_mcp', f: 'hand', a: 0.6 }] },
    { mesh: 'hypothenar', part: 'hypothenar', key: '', girth: 0.04, path: [{ p: 'hand.wrist', f: 'hand', l: -0.5, a: 0.7 }, { p: 'hand.little_mcp', f: 'hand', a: 0.6 }] },
    // ---- layer 3: deep muscles
    { mesh: 'brachialis', part: 'brachialis', key: '', girth: 0.15, path: [{ p: 'pose.shoulder>elbow@0.5', f: 'upper', a: 0.2 }, { p: 'pose.elbow>wrist@0.08', f: 'fore', a: 0.3 }] },
    // pronator teres: medial epicondyle -> lateral side of the mid radius (oblique)
    { mesh: 'pronator-teres', part: 'pronators', key: 'teres', girth: 0.065, path: [{ p: 'pose.elbow', f: 'fore', l: -0.6, a: 0.3 }, { p: 'pose.elbow>wrist@0.5', f: 'fore', l: 0.45, a: 0.25 }] },
    // pronator quadratus: a square sheet ACROSS the distal radius and ulna
    { mesh: 'pronator-quadratus', part: 'pronators', key: 'quadratus', girth: 0.05, xAlong: 'axis', path: [{ p: 'pose.elbow>wrist@0.88', f: 'fore', l: -0.6, a: 0.45 }, { p: 'pose.elbow>wrist@0.88', f: 'fore', l: 0.6, a: 0.45 }] },
    // ---- layer 5: nerves and arteries (bent along the limb)
    {
      mesh: 'median-nerve', part: 'median-nerve', key: '', girth: 0.022,
      path: [
        { p: 'pose.shoulder', f: 'upper', a: 0.35, l: -0.35 },
        { p: 'pose.shoulder>elbow@0.6', f: 'upper', a: 0.45, l: -0.3 },
        { p: 'pose.elbow', f: 'fore', a: 0.5 },
        { p: 'pose.elbow>wrist@0.6', f: 'fore', a: 0.4 },
        { p: 'pose.wrist', f: 'hand', a: 0.6 }, // carpal tunnel, with the flexor tendons
        { p: 'hand.middle_mcp', f: 'hand', a: 0.55 },
        { p: 'hand.middle_tip', f: 'hand', a: 0.3 },
      ],
    },
    {
      mesh: 'ulnar-nerve', part: 'ulnar-nerve', key: '', girth: 0.02,
      path: [
        { p: 'pose.shoulder', f: 'upper', a: 0.2, l: -0.45 },
        { p: 'pose.shoulder>elbow@0.6', f: 'upper', a: -0.1, l: -0.6 },
        { p: 'pose.elbow', f: 'upper', a: -0.35, l: -0.8 }, // behind the medial epicondyle: the "funny bone"
        { p: 'pose.elbow>wrist@0.5', f: 'fore', a: 0.3, l: -0.6 },
        { p: 'pose.wrist', f: 'hand', a: 0.5, l: -0.6 },
        { p: 'hand.little_mcp', f: 'hand', a: 0.5 },
        { p: 'hand.little_tip', f: 'hand', a: 0.3 },
      ],
    },
    {
      mesh: 'radial-nerve', part: 'radial-nerve', key: '', girth: 0.02,
      path: [
        { p: 'pose.shoulder', f: 'upper', a: -0.2 },
        { p: 'pose.shoulder>elbow@0.45', f: 'upper', a: -0.75, l: 0.1 }, // radial groove, behind the humerus
        { p: 'pose.shoulder>elbow@0.8', f: 'upper', l: 0.75, a: 0.1 },
        { p: 'pose.elbow', f: 'fore', l: 0.6, a: 0.25 },
        { p: 'pose.elbow>wrist@0.6', f: 'fore', l: 0.6 },
        { p: 'pose.wrist', f: 'hand', l: 0.65, a: -0.3 },
        { p: 'hand.thumb_mcp', f: 'hand', a: -0.3 },
      ],
    },
    {
      mesh: 'arteries', part: 'arteries', key: '', girth: 0.06,
      path: [
        { p: 'pose.shoulder', f: 'upper', a: 0.3, l: -0.25 },
        { p: 'pose.shoulder>elbow@0.6', f: 'upper', a: 0.45, l: -0.2 },
        { p: 'pose.elbow', f: 'fore', a: 0.55 },
        { p: 'pose.elbow>wrist@0.6', f: 'fore', a: 0.4 },
        { p: 'pose.wrist', f: 'hand', a: 0.55 },
      ],
    },
    // ---- layer 6: bones (uniform scale: they keep fal's proportions)
    // humerus head sits in the glenoid just below and behind the shoulder point, under the deltoid
    { mesh: 'humerus', part: 'humerus', key: '', path: [{ p: 'pose.shoulder>elbow@0.05', f: 'upper', a: -0.1 }, { p: 'pose.elbow', f: 'upper' }] },
    // radius: lateral epicondyle side at the elbow -> THUMB side at the wrist; ulna: medial (olecranon) -> little-finger side
    // slimmer than fal's proportions (its wide ends made each bone ~6 cm across and hid the gap between them)
    { mesh: 'radius', part: 'radius-ulna', key: 'radius', girth: 0.075, path: [{ p: 'pose.elbow', f: 'fore', l: 0.55 }, { p: 'pose.wrist', f: 'hand', l: 0.62 }] },
    { mesh: 'ulna', part: 'radius-ulna', key: 'ulna', girth: 0.075, path: [{ p: 'pose.elbow', f: 'fore', l: -0.55, a: -0.2 }, { p: 'pose.wrist', f: 'hand', l: -0.62 }] },
    // carpal cluster lies ACROSS the wrist
    { mesh: 'carpals', part: 'hand-bones', key: 'carpals', xAlong: 'axis', girth: 0.06, path: [{ p: 'hand.wrist>middle_mcp@0.2', f: 'hand', l: -0.6 }, { p: 'hand.wrist>middle_mcp@0.2', f: 'hand', l: 0.6 }] },
  ];

  for (const f of ALL) {
    const j = fingerJoints(f);
    // bones: metacarpal, proximal, (middle), distal. The thumb has no middle phalanx.
    out.push({ mesh: 'metacarpal', part: 'hand-bones', key: `${f}-metacarpal`, finger: f, path: [{ p: j.base, f: 'hand' }, { p: j.mcp, f: 'hand' }] });
    out.push({ mesh: 'phalanx-proximal', part: 'hand-bones', key: `${f}-proximal`, finger: f, path: [{ p: j.mcp, f: 'hand' }, { p: j.pip, f: 'hand' }] });
    if (f !== 'thumb') out.push({ mesh: 'phalanx-middle', part: 'hand-bones', key: `${f}-middle`, finger: f, path: [{ p: j.pip, f: 'hand' }, { p: j.dip, f: 'hand' }] });
    out.push({ mesh: 'phalanx-distal', part: 'hand-bones', key: `${f}-distal`, finger: f, path: [{ p: j.dip, f: 'hand' }, { p: j.tip, f: 'hand' }] });
    // tendons: forearm -> (flexors through the carpal tunnel) -> finger, bent along the path
    out.push({
      mesh: 'flexor-tendon', part: 'flexor-tendons', key: f, finger: f, girth: 0.012,
      path: [
        { p: 'pose.elbow>wrist@0.62', f: 'fore', a: 0.45, l: SPREAD[f] * 0.6 },
        { p: 'pose.wrist', f: 'hand', a: 0.6, l: SPREAD[f] * 0.5 },
        { p: j.mcp, f: 'hand', a: 0.55 },
        { p: j.pip, f: 'hand', a: 0.45 },
        { p: j.tip, f: 'hand', a: 0.3 },
      ],
    });
    out.push({
      mesh: 'extensor-tendon', part: 'extensor-tendons', key: f, finger: f, girth: 0.014, xAlong: 'lateral',
      path: [
        { p: 'pose.elbow>wrist@0.62', f: 'fore', a: -0.45, l: SPREAD[f] * 0.7 },
        { p: 'pose.wrist', f: 'hand', a: -0.6, l: SPREAD[f] * 0.7 },
        { p: j.mcp, f: 'hand', a: -0.6 },
        { p: j.pip, f: 'hand', a: -0.5 },
        { p: j.tip, f: 'hand', a: -0.35 },
      ],
    });
  }
  // interossei between neighbouring metacarpals (first dorsal interosseous between thumb and index)
  const pairs: [FingerId, FingerId][] = [['thumb', 'index'], ['index', 'middle'], ['middle', 'ring'], ['ring', 'little']];
  for (const [x, y] of pairs) {
    const jx = fingerJoints(x);
    const jy = fingerJoints(y);
    const base = x === 'thumb' ? 'hand.thumb_mcp>index_mcp@0.15' : `hand.${x}_mcp>${y}_mcp@0.5`;
    out.push({
      mesh: 'interosseous', part: 'interossei-lumbricals', key: `${x}-${y}`, girth: 0.035,
      path: [
        { p: x === 'thumb' ? 'hand.wrist>index_mcp@0.25' : `hand.wrist>${x}_mcp@0.2`, f: 'hand', a: -0.1, l: x === 'thumb' ? 0.35 : SPREAD[x] - 0.1 },
        { p: base, f: 'hand', a: -0.1 },
      ],
    });
    void jx;
    void jy;
  }
  return out;
}

/** Limb radius (world units) at a frame, from the arm's size. Offsets in anchors are multiples of this. */
export function limbRadius(f: 'upper' | 'fore' | 'hand', t: number, upperLen: number, handLen: number): number {
  if (f === 'upper') return 0.16 * upperLen;
  if (f === 'fore') return (0.14 + (0.09 - 0.14) * t) * upperLen;
  return 0.085 * handLen;
}

export { FOUR, ALL as ALL_FINGERS, SPREAD as SPREAD_FOR_SLIPS };
