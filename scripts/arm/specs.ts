/**
 * What fal generates for the arm: ONE isolated structure per mesh, never a whole arm
 * (image-to-3D only sees outsides, so a whole arm would come back as a sculpted skin).
 * Shared shapes (finger bones, tendons, interossei) are generated once and reused per finger by ArmXray.
 */

export type Tissue = 'muscle' | 'tendon' | 'nerve' | 'vessel' | 'bone';

export interface MeshSpec {
  /** mesh id = file name public/cache/arm-hand/<id>.glb */
  id: string;
  /** teardown part this mesh belongs to */
  part_id: string;
  tissue: Tissue;
  /** anatomical name (for people; NOT sent to the image model) */
  what: string;
  /**
   * Shape-only description sent to the image model. It must avoid words like arm, forearm, hand, finger,
   * skeleton: with them, flux draws a whole limb (tested: "isolated biceps" gave a full arm with a hand).
   */
  looks: string;
  /**
   * Which end of the long axis is wider, used to point the mesh proximal (towards the shoulder) at y = 0.
   * 'manual' = no reliable rule; checked by eye on the contact sheet (see FLIP in normalise.ts).
   */
  wideEnd: 'proximal' | 'distal' | 'manual';
}

const STYLE: Record<Tissue, string> = {
  muscle: 'realistic muscle red with fine striations and glistening fascia',
  tendon: 'glossy pearly white tendon',
  nerve: 'smooth yellow nerve',
  vessel: 'glossy red artery',
  bone: 'realistic ivory bone',
};

export function imagePrompt(s: MeshSpec): string {
  return (
    `Studio product photograph of one single object on a plain white background: ${s.looks}. ` +
    `${STYLE[s.tissue]}, medical illustration style 3D render. The object lies horizontally, long axis left to right, ` +
    `entirely in frame with space around it. Only this one object, nothing else in the image, no labels, no text.`
  );
}

export const SPECS: MeshSpec[] = [
  // superficial muscles
  { id: 'deltoid', part_id: 'deltoid', tissue: 'muscle', what: 'deltoid muscle, the thick triangular shoulder muscle, broad at the top tapering to a point', looks: 'a thick curved shell of red muscle shaped like a rounded triangle or a shield, about as wide as it is long, convex on one side and hollow on the other like a cupped hand, its fibres converging from a wide curved top edge down to one short white tendon at the lower point', wideEnd: 'proximal' },
  { id: 'biceps', part_id: 'biceps', tissue: 'muscle', what: 'biceps brachii muscle with both heads and its tendons', looks: 'a red spindle-shaped muscle belly that splits into two rounded heads with two thin white tendons at one end and narrows into one short white tendon at the other end', wideEnd: 'proximal' },
  { id: 'triceps', part_id: 'triceps', tissue: 'muscle', what: 'triceps brachii muscle with its three heads joining a flat tendon', looks: 'a large long red muscle made of three fleshy heads lying SIDE BY SIDE along their length and merging into one broad flat white tendon at one end, overall shaped like a long thick spindle, not stacked balls', wideEnd: 'proximal' },
  { id: 'brachioradialis', part_id: 'brachioradialis', tissue: 'muscle', what: 'brachioradialis muscle, a long slender muscle belly ending in a long thin tendon', looks: 'a long slender red muscle belly at one end that becomes a long thin white tendon over its second half', wideEnd: 'proximal' },
  { id: 'forearm-flexors', part_id: 'forearm-flexors', tissue: 'muscle', what: 'forearm flexor muscles as one bundle, fleshy bellies from a common origin narrowing into several long thin tendons', looks: 'a bundle of several long red muscle bellies starting together from one short white tendon at one end and separating into five long thin white tendons at the other end', wideEnd: 'proximal' },
  { id: 'forearm-extensors', part_id: 'forearm-extensors', tissue: 'muscle', what: 'forearm extensor muscles as one bundle, fleshy bellies from a common origin narrowing into several long thin tendons', looks: 'a bundle of several long darker red muscle bellies starting together from one short white tendon at one end and separating into several long thin white tendons at the other end', wideEnd: 'proximal' },
  { id: 'thenar', part_id: 'thenar', tissue: 'muscle', what: 'thenar muscle group of the thumb, one small rounded fleshy muscle mound', looks: 'a small rounded mound of red muscle, slightly oval, with a short white tendon at one end', wideEnd: 'manual' },
  { id: 'hypothenar', part_id: 'hypothenar', tissue: 'muscle', what: 'hypothenar muscle group of the little finger, one small elongated fleshy muscle', looks: 'a small elongated red muscle about the size of a thumb, with short white tendons at both ends', wideEnd: 'manual' },
  // deep muscles
  { id: 'brachialis', part_id: 'brachialis', tissue: 'muscle', what: 'brachialis muscle, a broad flat muscle narrowing to a short thick tendon', looks: 'a broad flat red muscle, wide at one end and narrowing to a short thick white tendon at the other', wideEnd: 'proximal' },
  { id: 'pronator-teres', part_id: 'pronators', tissue: 'muscle', what: 'pronator teres muscle, a short spindle-shaped muscle with a flat tendon at one end', looks: 'a short thick red spindle-shaped muscle with a short white tendon at each end', wideEnd: 'proximal' },
  { id: 'pronator-quadratus', part_id: 'pronators', tissue: 'muscle', what: 'pronator quadratus muscle, a small flat square sheet of muscle', looks: 'a small flat square sheet of red muscle with parallel fibres running across it', wideEnd: 'manual' },
  { id: 'interosseous', part_id: 'interossei-lumbricals', tissue: 'muscle', what: 'dorsal interosseous muscle of the hand, a small slender feather-shaped muscle', looks: 'a small slender red muscle shaped like an elongated leaf, with fine fibres angled towards a thin white tendon that runs along its centre and out of one end', wideEnd: 'proximal' },
  // tendons (one each, reused per finger)
  { id: 'flexor-tendon', part_id: 'flexor-tendons', tissue: 'tendon', what: 'single finger flexor tendon, one long thin round cord', looks: 'one long thin round glossy white cord, like a strand of cooked spaghetti, slightly curved, with tapered ends', wideEnd: 'manual' },
  { id: 'extensor-tendon', part_id: 'extensor-tendons', tissue: 'tendon', what: 'single finger extensor tendon, one long thin flat band widening slightly at one end', looks: 'one long thin flat glossy white ribbon that widens slightly into a thin fan at one end', wideEnd: 'distal' },
  // nerves and arteries
  { id: 'median-nerve', part_id: 'median-nerve', tissue: 'nerve', what: 'median nerve, one long thin cord dividing into a few small branches at one end', looks: 'one long thin smooth yellow cord that splits into four small thin branches at one end', wideEnd: 'distal' },
  { id: 'ulnar-nerve', part_id: 'ulnar-nerve', tissue: 'nerve', what: 'ulnar nerve, one long thin cord dividing into two small branches at one end', looks: 'one long thin smooth yellow cord that splits into two small thin branches at one end', wideEnd: 'distal' },
  { id: 'radial-nerve', part_id: 'radial-nerve', tissue: 'nerve', what: 'radial nerve, one long thin cord dividing into a superficial and a deep branch at one end', looks: 'one long thin smooth yellow cord that splits into two thin branches at one end', wideEnd: 'distal' },
  { id: 'arteries', part_id: 'arteries', tissue: 'vessel', what: 'brachial artery dividing into the radial and ulnar arteries, one Y-shaped branching tube', looks: 'one long glossy red tube that splits into a Y shape, two thinner red tubes continuing side by side', wideEnd: 'distal' },
  // bones (finger bones reused per finger)
  { id: 'humerus', part_id: 'humerus', tissue: 'bone', what: 'humerus bone, the upper arm bone, with its rounded head at one end and the elbow condyles at the other', looks: 'a single human humerus bone, museum bone specimen: one long ivory bone with a smooth round ball-shaped head at one end and a wide end with two side knobs at the other', wideEnd: 'manual' },
  { id: 'radius', part_id: 'radius-ulna', tissue: 'bone', what: 'radius', looks: 'a single human radius bone, museum bone specimen: a long slender ivory bone with a small round disc-shaped head at one end, widening into a broad flat end at the other', wideEnd: 'distal' },
  { id: 'ulna', part_id: 'radius-ulna', tissue: 'bone', what: 'ulna', looks: 'a single human ulna bone, museum bone specimen: a long slender ivory bone with a large hook-shaped notch at one end, tapering to a small rounded knob at the other', wideEnd: 'proximal' },
  { id: 'carpals', part_id: 'hand-bones', tissue: 'bone', what: 'eight carpal bones of the wrist as one compact articulated cluster', looks: 'the eight human carpal bones, museum bone specimen: a compact cluster of small rounded ivory bones fitted together like pebbles, about the size of a walnut', wideEnd: 'manual' },
  { id: 'metacarpal', part_id: 'hand-bones', tissue: 'bone', what: 'single metacarpal bone of the hand, long and slim with a wider base and a rounded head', looks: 'a single human metacarpal bone, museum bone specimen: one small slim ivory bone with a slightly wider flat base and a smooth round head', wideEnd: 'manual' },
  { id: 'phalanx-proximal', part_id: 'hand-bones', tissue: 'bone', what: 'single proximal phalanx finger bone', looks: 'a single human proximal phalanx bone, museum bone specimen: one small ivory bone with a slightly wider concave base and a pulley-shaped head', wideEnd: 'proximal' },
  { id: 'phalanx-middle', part_id: 'hand-bones', tissue: 'bone', what: 'single middle phalanx finger bone', looks: 'a single human middle phalanx bone, museum bone specimen: one short small ivory bone, waisted in the middle', wideEnd: 'proximal' },
  { id: 'phalanx-distal', part_id: 'hand-bones', tissue: 'bone', what: 'single distal phalanx fingertip bone with a small flared tip', looks: 'a single human distal phalanx bone, museum bone specimen: one very small short ivory bone, wider at its base and narrowing to a small rounded rough tip shaped like a tiny spade', wideEnd: 'proximal' },
];
