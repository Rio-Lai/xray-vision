/**
 * Hand gestures for the model on stage (#55, #107, #109, #121). Pure: tracked hands in, gesture
 * state and per-frame actions out (no store, no DOM), so it can be simulated in Node with synthetic
 * landmarks. Allocation-free per frame once the hands are known (the output and its arrays are reused).
 *
 * Every distance is in hand sizes (wrist -> middle MCP, px; TrackedHand.handSize), so it works at
 * any distance from the camera. Per hand, on every new camera frame (GestureHandInput.seenAt):
 *  - palm centre    = mean of the wrist and the four knuckles (they do not move when the fingers open)
 *  - pinch distance = |thumb tip - index tip| / hand size (2D plus half the MediaPipe depth)
 *  - openness       = mean |fingertip - wrist| / hand size over all five fingers (open hand ~1.6, fist ~0.8)
 *  - reach          = |index tip - wrist| / hand size (a pinch ~1.2-1.4: the index reaches out; a fist ~0.75)
 * The palm centre, hand size, openness, pinch distance and pinch point are smoothed with a One Euro
 * filter per hand (calm when still, quick when moving), so tracking jitter does not start or end a gesture.
 *
 * Hands are followed by position, not by MediaPipe's left / right label (which flips): a new camera
 * frame's hand continues the nearest tracked hand within MATCH_HS. A hand with no new frame keeps its
 * state for HOLD_MS (a few dropped frames do not end a gesture; nothing moves meanwhile), then it is
 * gone; found again where a pinching hand was lost (REFOUND_MS), it must let go and pinch again.
 *
 * Shapes: pinch (hysteresis + hold: starts when the distance stays below pinchOn for holdMs while
 * reach >= pinchReachMin, so a natural pinch counts with the other fingers relaxed or curled but a
 * fist never does; ends above pinchOff for releaseMs), fist (openness <= fistMax), open
 * (openness >= globeOpenMin), other.
 *
 * World landmarks (Rio, 15 Nov): when the hand tracker has MediaPipe's metric 3D landmarks
 * (GestureHandInput.world) and `world` is on, the pinch distance, the reach and a second openness
 * (openW) come from them instead of the image: the hand's real shape, so a pinch seen from behind the
 * hand or a hand pointing away from the head camera still counts. Positions always come from the image.
 *
 * Gestures (only while `enabled`, i.e. a model is on stage):
 *  - drag: one hand pinching moves the model with the pinch point (panX / panY since the pinch began,
 *    panGain times), or with `pinchTurns` turns it like a globe, rotGain radians per hand size its palm
 *    moves (right = turn right, down = tip the top towards you; on release the caller coasts). A
 *    lone pinch waits DRAG_DELAY_MS for a second one (and while the other hand has no new frame).
 *  - grab: an open hand over the model (GestureContext.modelBox) that closes to a fist within
 *    GRAB_ARM_MS holds the model: it follows the fist (panX / panY since the grab, panGain times)
 *    until the hand opens again.
 *  - sweep: a flat open hand moved down from the top of the frame (palm from above SWEEP_TOP to below
 *    SWEEP_BOTTOM, at least SWEEP_MIN_DY, within SWEEP_MAX_MS of leaving the top, mostly straight
 *    down) -> `sweep`: the caller closes the exploded view.
 *  - two hands pinching: undecided ('two') until the hands have moved TWO_DECIDE_HS. Then locked for
 *    that pinch: apart / together ('spread') -> spreadDelta = spreadGain * log2(distance / distance at
 *    the start), which opens, then zooms (spreadExplodeZoom, #109); moved together in the same direction
 *    ('pan') -> panX / panY, the pinch points' common move since the start (frame px). Let go to switch.
 *  - globe: both hands raised, free and open (not pinching, not fists), held up nearly still
 *    (GLOBE_STILL) for GLOBE_ENGAGE_MS; their common sideways motion turns the model, common up / down
 *    tips it, and opposite changes in hand size (one hand pushed away, the other pulled in) turn it
 *    too. A dead zone (globeDeadZone hand sizes per second) keeps still hands still. Ends when either
 *    hand pinches, closes or leaves; leaving the frame gives back the last GLOBE_UNDO_MS of tipping
 *    (lowering both hands after a turn does not tip the model).
 *  - burst (off by default since the grab): one raised, free hand, held as a fist for FIRM_MS, opens to a spread hand (openness >=
 *    spreadMin) within burstMs -> 'open'; a held spread hand closing to a fist within burstMs -> 'close'.
 *    The openness must change at BURST_MIN_RATE or faster at some point (a flick, not a relax) and the
 *    new shape must hold BURST_CONFIRM_MS. Not from a hand moving faster than BURST_MAX_SPEED (a wave),
 *    at the frame edge (entering or leaving), within BURST_REFRACTORY_MS of the last burst, from a shape
 *    held while in another gesture, or within BURST_QUIET_MS of another gesture moving the model.
 *
 * Only a deliberate, free hand gestures (#107): a judge typing on the laptop in full view must not
 * turn the model. A hand small in the frame (wrist to middle knuckle below restHandMax of the frame
 * height: on the desk at arm's length, not raised towards the head camera) is blocked (no pinch
 * starts, a held pinch goes stale, no marker) while
 *  - 'typing':  it pressed a key within typingMs (GestureHandInput.lastPressAt, from the hand tracker);
 *  - 'resting': its palm centre is inside a laptop or keyboard box (GestureContext.restBoxes).
 * A raised hand is never 'typing' or 'resting'. Any hand is blocked while
 *  - 'new':     it has been tracked for less than MIN_TRACKED_MS (just come into view, or re-found).
 * The globe and the burst also need raised hands (at least restHandMax; 0 = any hand). A hand already
 * in a gesture keeps counting as raised down to KEEP_SIZE of it (pushed away, it looks smaller).
 */

export interface GestureLandmark {
  x: number;
  y: number;
  z: number;
}

export interface GestureHandInput {
  id: string;
  /** 21 smoothed MediaPipe landmarks, normalised frame coords */
  lm: GestureLandmark[];
  /** wrist -> middle MCP in frame px */
  handSize: number;
  /** 21 metric 3D landmarks (MediaPipe worldLandmarks), when known: the shapes come from these (`world`) */
  world?: GestureLandmark[] | null;
  /** when this hand last pressed a key (same clock as `now`): a typing hand does not gesture */
  lastPressAt?: number;
  /**
   * when these landmarks came from a camera frame (TrackedHand.lastSeen). Older than `now` = no new
   * frame for this hand this tick (the tracker keeps a lost hand a moment): its gestures hold still.
   * Leave it out when every call is a new frame (simulations).
   */
  seenAt?: number;
}

export interface GestureTuning {
  /** master switch (debug panel, ?gestures=0) */
  enabled: boolean;
  /** pinch starts below this many hand sizes (thumb tip to index tip) */
  pinchOn: number;
  /** pinch ends above this */
  pinchOff: number;
  /** a pinch must hold this long before it counts (ms) */
  holdMs: number;
  /** a pinch must stay open this long before it is released (ms): tracking noise does not drop it */
  releaseMs: number;
  /** the index fingertip must reach at least this far from the wrist (hand sizes) for a pinch: not a fist */
  pinchReachMin: number;
  /** pinch, reach and openness from the 3D world landmarks when the tracker has them (else the image) */
  world: boolean;
  /** one-hand pinch turns the model (true) instead of moving it (false, the default) */
  pinchTurns: boolean;
  /** radians per hand size of pinch-drag */
  rotGain: number;
  /** explode change per doubling of the two-hand distance */
  spreadGain: number;
  /** two-hand pinch: apart / together opens and zooms */
  twoHand: boolean;
  /** two-hand pinch moved together in the same direction moves the model */
  pan: boolean;
  /** the model moves this many times the hand's on-screen motion (pinch, grab, two-hand pan) */
  panGain: number;
  /** open hand over the model, then a fist: grab it and move it */
  grab: boolean;
  /** flat hand swept down from the top of the frame: close the exploded view */
  sweep: boolean;
  /** one-hand fist -> spread opens (spread -> fist closes) */
  burst: boolean;
  /** openness at or below this is a fist */
  fistMax: number;
  /** openness at or above this is a spread hand */
  spreadMin: number;
  /** fist -> spread (or back) must happen within this (ms) */
  burstMs: number;
  /** two open hands turn the model like a globe */
  globe: boolean;
  /** openness at or above this is an open hand for the globe */
  globeOpenMin: number;
  /** radians per hand size the two hands move together */
  globeGain: number;
  /** two-hand motion slower than this (hand sizes per second) does not turn the model */
  globeDeadZone: number;
  /** a hand that pressed a key this recently is typing and does not gesture (ms; 0 = off) */
  typingMs: number;
  /**
   * a hand smaller than this share of the frame height (wrist -> middle MCP) is on the desk, not raised
   * towards the camera: it does not gesture while typing or with its palm on a laptop or keyboard, and
   * never makes a globe or a burst (0 = off)
   */
  restHandMax: number;
}

export const GESTURE_TUNING_DEFAULTS: GestureTuning = {
  enabled: true,
  pinchOn: 0.3,
  pinchOff: 0.45,
  holdMs: 90,
  releaseMs: 100,
  pinchReachMin: 1.0,
  world: true,
  pinchTurns: false,
  rotGain: 1.1,
  spreadGain: 1.0,
  twoHand: true,
  pan: false,
  panGain: 1,
  grab: true,
  sweep: true,
  burst: false,
  fistMax: 0.95,
  spreadMin: 1.4,
  burstMs: 400,
  globe: true,
  globeOpenMin: 1.15,
  globeGain: 1.3,
  globeDeadZone: 0.35,
  typingMs: 1500,
  restHandMax: 0.22,
};

/** A fist (or a spread hand) must be held this long, raised, free and in frame, before a burst can start from it. */
const FIRM_MS = 150;
/** The new shape of a burst must hold this long (2 camera frames at 30 fps) before it fires. */
const BURST_CONFIRM_MS = 50;
/** After a burst, no other for this long (ms): to close twice (zoom back, then analysed), close, reopen, close. */
const BURST_REFRACTORY_MS = 800;
/** No burst this soon after another gesture moved the model (ms): closing a hand to end a globe is not a burst. */
const BURST_QUIET_MS = 300;
/** A palm moving faster than this (hand sizes per second) during the change is a wave, not a burst. */
const BURST_MAX_SPEED = 4;
/**
 * The openness must change at least this fast at some point of a burst (openness units per second):
 * a quick flick open peaks at 5 or more, a hand relaxing open over a second at about 1.
 */
const BURST_MIN_RATE = 2.5;
/** Openness hysteresis: a fist ends above fistMax + this, a spread hand below spreadMin - this. */
const OPEN_HYST = 0.06;
/** Both hands must hold the globe pose this long, and be nearly still (GLOBE_STILL), before it turns the model (ms). */
const GLOBE_ENGAGE_MS = 200;
/** Hand sizes per second: hands still coming up into view do not start the globe (no tip as they rise). */
const GLOBE_STILL = 1.2;
/** The globe's hands must keep their palm centre this far inside the frame (share of the frame). */
const GLOBE_EDGE = 0.02;
/** A hand in a gesture keeps counting as raised while at least this share of restHandMax (pushed away, it shrinks). */
const KEEP_SIZE = 0.7;
/** Globe: radians per unit of opposite log-size change (one hand pushed away, the other pulled in). */
const GLOBE_DEPTH_GAIN = 2.5;
/**
 * A globe that ends with a hand leaving the frame (dropped out of view) gives back the tipping of its
 * last this-many ms, so lowering both hands after a turn does not tip the model.
 */
const GLOBE_UNDO_MS = 450;
const GLOBE_HISTORY = 32;
/** Two-hand pinch: decided (apart / together vs. same direction) once the hands moved this far (hand sizes). */
const TWO_DECIDE_HS = 0.3;
/** Pitch follows the drag a little less than yaw (tipping is the rarer move). */
const PITCH_FACTOR = 0.8;
/** Depth counts this much in the pinch distance (MediaPipe z is noisy). */
const Z_WEIGHT = 0.5;
/** A single frame's step is capped (hand sizes): a tracking jump never flings the model. */
const MAX_STEP_HS = 0.6;
/** A lone pinch waits this long for a second one before it starts turning the model. */
const DRAG_DELAY_MS = 150;
/** A fist grabs the model if the hand was open over it at most this long before (ms). */
const GRAB_ARM_MS = 900;
/** Sweep: the palm starts above this share of the frame height, ends below SWEEP_BOTTOM, moves at least SWEEP_MIN_DY. */
const SWEEP_TOP = 0.38;
const SWEEP_BOTTOM = 0.6;
const SWEEP_MIN_DY = 0.28;
/** ...within this long of leaving the top (ms): lowering a hand slowly is not a sweep. */
const SWEEP_MAX_MS = 1100;
/** ...and mostly straight down: sideways at most this share of the way down. */
const SWEEP_STRAIGHT = 0.8;
/** No second sweep this soon (ms), and none just after another gesture moved the model. */
const SWEEP_REFRACTORY_MS = 1000;
const SWEEP_QUIET_MS = 500;
const WHY_SWEEP = 'sweep: CLOSE fired';
const WHY_GRAB = 'grab: holding (open the hand to let go)';
/** Palm centre: wrist and the four knuckles (they do not move when the fingers open or close). */
const PALM = [0, 5, 9, 13, 17];
const TIPS = [4, 8, 12, 16, 20];
const REST_TIPS = [12, 16, 20];
/** A hand must have been tracked this long before it gestures (ms). */
export const MIN_TRACKED_MS = 300;
/**
 * A hand with no new camera frame keeps its gesture state this long (ms; 7 frames at 30 fps, as long as
 * the hand tracker keeps a lost hand): a few dropped frames do not end a gesture, and nothing moves meanwhile.
 */
export const HOLD_MS = 250;
/** A hand found again within this long (ms) where a pinching hand was lost must let go and pinch again. */
const REFOUND_MS = 1000;
/** A new frame's hand continues the nearest tracked hand within this many hand sizes (palm centre). */
const MATCH_HS = 1.6;
/** Knuckles and fingertips within this margin of the frame edge: the hand is entering or leaving (no burst). */
const EDGE = 0.01;
/** "What it is doing" stays on a hand this long after a burst (ms), and after a globe turn moved the model. */
const BURST_SHOW_MS = 600;
const GLOBE_SHOW_MS = 300;
/** A hand in a globe that is not turning anything (its marker stays hollow). */
const GLOBE_STILL_DOING = 'globe (still)';

export type GestureMode = 'idle' | 'drag' | 'grab' | 'two' | 'spread' | 'pan' | 'globe';
export type GestureEvent =
  | 'pinch'
  | 'unpinch'
  | 'drag-start'
  | 'drag-end'
  | 'two-start'
  | 'spread-start'
  | 'pan-start'
  | 'two-end'
  | 'globe-start'
  | 'globe-end'
  | 'grab-start'
  | 'grab-end'
  | 'sweep'
  | 'burst-open'
  | 'burst-close';
/** The coarse shape of a hand. */
export type HandShape = 'fist' | 'open' | 'pinch' | 'other';
/** Why a hand does not count for gestures right now (null = it does). */
export type HandBlock = 'typing' | 'resting' | 'new' | null;

export interface HandGestureInfo {
  /** this recogniser's own name for the hand (stable while it is tracked; MediaPipe's label can flip) */
  key: string;
  /** the tracker's id for it this frame */
  id: string;
  pinchDist: number;
  open: number;
  /** openness from the world landmarks (= open without them) */
  openW: number;
  /** the pinch, reach and openW came from the world landmarks this frame */
  world: boolean;
  restOpen: number;
  reach: number;
  pinched: boolean;
  /** pinched but waiting for a fresh pinch (held when gestures began, or left from a two-hand pinch) */
  stale: boolean;
  shape: HandShape;
  /** wrist -> middle MCP as a share of the frame height (compare restHandMax) */
  size: number;
  /** at least restHandMax: may make a globe or a burst */
  raised: boolean;
  /** knuckles and fingertips inside the frame */
  inFrame: boolean;
  blocked: HandBlock;
  /** no new camera frame for it right now: its state is being held (HOLD_MS) */
  held: boolean;
  /** what it is doing now ('' = nothing) */
  doing: string;
  /** the last reason a gesture did or did not start with this hand, and when (same clock as `now`) */
  why: string;
  whyAt: number;
  /** the last fist <-> spread change took this long (ms; compare burstMs), and its fastest openness change (per second) */
  lastChangeMs: number;
  lastChangeRate: number;
}

/** A small marker for each free hand (the on-screen cue). */
export interface GestureMark {
  key: string;
  /** between the thumb and index fingertips (the palm centre for a fist), normalised frame coords */
  x: number;
  y: number;
  /** filled: the hand is doing something */
  active: boolean;
}

export interface GestureOutput {
  mode: GestureMode;
  /** radians to turn by this frame (drag or globe) */
  dYaw: number;
  dPitch: number;
  /** a drag or globe turn ended this frame: 'release' = let go (coast), 'cancel' = stop dead */
  dragEnd: 'release' | 'cancel' | null;
  /**
   * While two hands pinch apart / together (mode 'spread'): spreadGain * log2(distance / distance at
   * the start), unclamped; spreadExplodeZoom turns it into the explode amount and the zoom.
   */
  spreadDelta: number | null;
  /**
   * While one hand pinches (mode 'drag', not pinchTurns), a fist holds it (mode 'grab') or two hands
   * pinch and move together (mode 'pan'): the move since that gesture began, frame px.
   */
  panX: number;
  panY: number;
  pan: boolean;
  /** the drag or globe had a new camera frame this frame (dYaw / dPitch are a real step, maybe 0) */
  moved: boolean;
  /** a burst fired this frame */
  burst: 'open' | 'close' | null;
  /** a sweep down fired this frame: close the exploded view */
  sweep: boolean;
  events: GestureEvent[];
  /** markers for the on-screen cue: free raised hands (and any hand doing something) */
  marks: GestureMark[];
  hands: HandGestureInfo[];
}

export interface GestureContext {
  enabled: boolean;
  /** current store.explodeAmount (kept for callers; the driver reads the store itself) */
  explode: number;
  /** lowest explode amount gestures go to (the analyse state) */
  minExplode: number;
  /** laptop and keyboard boxes in view, normalised frame coords: a small hand resting on one does not gesture */
  restBoxes?: { x: number; y: number; w: number; h: number }[];
  /** where the model on stage is, normalised frame coords (with a margin): an open hand here can grab it */
  modelBox?: { x: number; y: number; w: number; h: number } | null;
}

/** One Euro filter for one value: cutoff (Hz) = minCut + beta * |speed / scale|. */
class Euro {
  x = 0;
  dx = 0;
  private init = false;
  constructor(
    private readonly minCut: number,
    private readonly beta: number,
    private readonly dCut = 1,
  ) {}
  reset(v: number): void {
    this.x = v;
    this.dx = 0;
    this.init = true;
  }
  step(raw: number, dt: number, scale = 1): number {
    if (!this.init) {
      this.reset(raw);
      return raw;
    }
    const ad = euroAlpha(this.dCut, dt);
    this.dx += ad * ((raw - this.x) / dt - this.dx);
    this.x += euroAlpha(this.minCut + (this.beta * Math.abs(this.dx)) / Math.max(1e-6, scale), dt) * (raw - this.x);
    return this.x;
  }
}

function euroAlpha(cutoff: number, dt: number): number {
  return 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
}

interface HandTrack {
  key: string;
  id: string;
  /** has had its first camera frame (filters started) */
  init: boolean;
  bornAt: number;
  /** time of its last new camera frame */
  freshAt: number;
  /** got a new frame this update */
  fresh: boolean;
  matched: boolean;
  lastPressAt: number | undefined;
  // smoothed features
  fx: Euro;
  fy: Euro;
  fs: Euro;
  fo: Euro;
  fp: Euro;
  /** openW */
  fw: Euro;
  fpx: Euro;
  fpy: Euro;
  cx: number;
  cy: number;
  hs: number;
  /** ln(hand size), smoothed (the globe's depth cue) */
  lnS: number;
  open: number;
  openW: number;
  world: boolean;
  pinchDist: number;
  px: number;
  py: number;
  reach: number;
  restOpen: number;
  size: number;
  /** last time it was open over the model (a fist soon after grabs it) */
  armedAt: number;
  /** the sweep in progress: where (normalised) and when it began, -1 = none */
  sweepAt: number;
  sweepX0: number;
  sweepY0: number;
  sweepReady: boolean;
  raised: boolean;
  inFrame: boolean;
  /** palm centre inside the frame (GLOBE_EDGE) */
  palmIn: boolean;
  blocked: HandBlock;
  /** palm speed, hand sizes per second (smoothed) */
  speed: number;
  // pinch
  pinched: boolean;
  stale: boolean;
  /** found again where a pinching hand was just lost: its next pinch is stale until it opens */
  mustReopen: boolean;
  closeSince: number | null;
  openSince: number | null;
  pinchAt: number;
  // openness states (hysteresis) and the burst
  isFist: boolean;
  isSpread: boolean;
  fistSince: number;
  spreadSince: number;
  firmFist: boolean;
  firmSpread: boolean;
  /** when it last left a firmly held fist / spread (-1e9 = none since) */
  fistLeftAt: number;
  spreadLeftAt: number;
  /** fastest palm speed since it left the firm shape */
  changeSpeed: number;
  /** fastest openness change since it left the firm shape (units per second), and the openness before */
  changeRate: number;
  prevOpen: number;
  cand: 'open' | 'close' | null;
  candAt: number;
  candMs: number;
  /** a confirmed burst waiting for the mode check */
  ready: 'open' | 'close' | null;
  burstAt: number;
  // previous palm / size for the drag and the globe
  gx: number;
  gy: number;
  gln: number;
  info: HandGestureInfo;
  mark: GestureMark;
}

function capStep(v: number): number {
  return Math.max(-MAX_STEP_HS, Math.min(MAX_STEP_HS, v));
}

function dist2(a: GestureLandmark, b: GestureLandmark, fw: number, fh: number): number {
  return Math.hypot((a.x - b.x) * fw, (a.y - b.y) * fh);
}

/** Whether (x, y) (normalised frame coords) is inside any of the boxes. */
function onBox(x: number, y: number, boxes: GestureContext['restBoxes']): boolean {
  if (!boxes) return false;
  for (const b of boxes) if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return true;
  return false;
}

interface Features {
  pinchDist: number;
  open: number;
  openW: number;
  /** pinch, reach and openW are from the world landmarks */
  world: boolean;
  restOpen: number;
  reach: number;
  px: number;
  py: number;
  cx: number;
  cy: number;
}

const d3 = (a: GestureLandmark, b: GestureLandmark) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

function featuresInto(f: Features, lm: GestureLandmark[], handSize: number, fw: number, fh: number, world?: GestureLandmark[] | null): Features {
  const hs = Math.max(8, handSize);
  const t = lm[4];
  const i = lm[8];
  f.pinchDist = Math.hypot((t.x - i.x) * fw, (t.y - i.y) * fh, (t.z - i.z) * fw * Z_WEIGHT) / hs;
  let open = 0;
  for (const k of TIPS) open += dist2(lm[k], lm[0], fw, fh);
  f.open = open / (TIPS.length * hs);
  let rest = 0;
  for (const k of REST_TIPS) rest += dist2(lm[k], lm[0], fw, fh);
  f.restOpen = rest / (REST_TIPS.length * hs);
  f.reach = dist2(lm[8], lm[0], fw, fh) / hs;
  let cx = 0;
  let cy = 0;
  for (const k of PALM) {
    cx += lm[k].x;
    cy += lm[k].y;
  }
  f.cx = (cx / PALM.length) * fw;
  f.cy = (cy / PALM.length) * fh;
  f.px = ((t.x + i.x) / 2) * fw;
  f.py = ((t.y + i.y) / 2) * fh;
  f.openW = f.open;
  f.world = false;
  // The hand's real 3D shape, whichever way it faces the camera (metres; wrist -> middle MCP ~ 9 cm).
  const wsz = world && world.length >= 21 ? d3(world[0], world[9]) : 0;
  if (wsz > 0.02 && wsz < 0.3) {
    f.world = true;
    f.pinchDist = d3(world![4], world![8]) / wsz;
    f.reach = d3(world![8], world![0]) / wsz;
    let ow = 0;
    for (const k of TIPS) ow += d3(world![k], world![0]);
    f.openW = ow / (TIPS.length * wsz);
  }
  return f;
}

/** Features of one hand: pinch distance, openness, rest openness, reach (hand sizes), pinch point and palm centre (frame px). */
export function handFeatures(lm: GestureLandmark[], handSize: number, fw: number, fh: number, world?: GestureLandmark[] | null): Features {
  return featuresInto({ pinchDist: 0, open: 0, openW: 0, world: false, restOpen: 0, reach: 0, px: 0, py: 0, cx: 0, cy: 0 }, lm, handSize, fw, fh, world);
}

/** Remember the palm and size now (the next drag / globe step is measured from here). */
function markPalm(t: HandTrack): void {
  t.gx = t.cx;
  t.gy = t.cy;
  t.gln = t.lnS;
}

function inFrame(lm: GestureLandmark[]): boolean {
  for (let k = 5; k < 21; k++) {
    const p = lm[k];
    if (p.x < EDGE || p.x > 1 - EDGE || p.y < EDGE || p.y > 1 - EDGE) return false;
  }
  return true;
}

/** Past fully open, the zoom doubles for every this much more spread (spreadDelta units, #109). */
export const SPREAD_ZOOM_GAIN = 0.5;

/**
 * The two-hand spread as one motion (#109): from the explode amount e0 and zoom z0 at the start of
 * the spread, a spread of `delta` (spreadDelta) first opens the model up to 1, then zooms in
 * (doubling per SPREAD_ZOOM_GAIN); bringing the hands together first zooms back to 1, then closes
 * it (down to minExplode). A zoom below 1 (mouse, voice) is left alone until the model is fully
 * open. Continuous and monotone in delta; at delta 0 it is (e0, z0). Pure.
 */
export function spreadExplodeZoom(
  e0: number,
  z0: number,
  delta: number,
  minExplode: number,
  maxZoom: number,
): { explode: number; zoom: number } {
  const e = Math.min(1, Math.max(minExplode, e0));
  if (!Number.isFinite(delta)) return { explode: e, zoom: z0 };
  if (delta >= 0) {
    const open = Math.min(delta, 1 - e);
    const zoom = z0 * Math.pow(2, (delta - open) / SPREAD_ZOOM_GAIN);
    return { explode: e + open, zoom: Math.min(Math.max(z0, maxZoom), zoom) };
  }
  const unzoomRoom = z0 > 1 ? SPREAD_ZOOM_GAIN * Math.log2(z0) : 0;
  const unzoom = Math.min(-delta, unzoomRoom);
  const zoom = z0 <= 1 ? z0 : unzoom >= unzoomRoom ? 1 : z0 * Math.pow(2, -unzoom / SPREAD_ZOOM_GAIN);
  return { explode: Math.max(minExplode, e + delta + unzoom), zoom };
}

/** A burst open on a model that is already fully open zooms in by this factor. */
export const BURST_ZOOM_STEP = 1.5;

/**
 * What a burst does (#121), from the explode amount and zoom now. Open: analysed (or partly open) ->
 * fully open (1); already open -> a zoom step in. Close: zoomed in -> back to the normal size;
 * open -> analysed (minExplode). A hand never opens something from nothing and never puts it away
 * (voice does that): at the ends it does nothing. Pure.
 */
export function burstAction(
  kind: 'open' | 'close',
  explode: number,
  zoom: number,
  minExplode: number,
  maxZoom: number,
): { explode: number | null; zoom: number | null; hint: 'Opening' | 'Closing' | 'Zooming' | null } {
  if (kind === 'open') {
    if (explode < 0.99) return { explode: 1, zoom: null, hint: 'Opening' };
    if (zoom < maxZoom - 1e-3) return { explode: null, zoom: Math.min(maxZoom, Math.max(1, zoom) * BURST_ZOOM_STEP), hint: 'Zooming' };
    return { explode: null, zoom: null, hint: null };
  }
  if (zoom > 1.01) return { explode: null, zoom: 1, hint: 'Zooming' };
  if (explode > minExplode + 0.01) return { explode: minExplode, zoom: null, hint: 'Closing' };
  return { explode: null, zoom: null, hint: null };
}

// Reasons shown in the debug panel (constant strings: nothing is built per frame).
const WHY_PINCH_FIST = 'pinch: fingers too closed (fist?), index reach low';
const WHY_BURST_SLOW = 'burst: change too slow (burstMs)';
const WHY_BURST_MOVING = 'burst: hand moving too fast';
const WHY_BURST_SOON = 'burst: too soon after the last one';
const WHY_BURST_QUIET = 'burst: just after another gesture';
const WHY_BURST_BUSY = 'burst: another gesture is on';
const WHY_BURST_OFF = 'burst: off (?burst=0)';
const WHY_BURST_STAGE = 'burst: nothing on stage';
const WHY_BURST_LOW = 'burst: hand low (on the desk)';
const WHY_BURST_EDGE = 'burst: hand at the frame edge';
const WHY_BURST_OPEN = 'burst: OPEN fired';
const WHY_BURST_CLOSE = 'burst: CLOSE fired';
const WHY_GLOBE_WAIT = 'globe: holding both hands open...';
const WHY_GLOBE_ON = 'globe: on (move both hands)';
const WHY_GLOBE_OTHER = 'globe: other hand not open';
const WHY_GLOBE_LOW = 'globe: hand low (on the desk)';
const WHY_GLOBE_OFF = 'globe: off (?globe=0)';
const WHY_TWO_WAIT = 'two hands: apart = zoom, same way = move';
const WHY_TWO_SPREAD = 'two hands: apart / together (open, zoom)';
const WHY_TWO_PAN = 'two hands: moving together (pan)';
const WHY_DRAG = 'pinch: turning';
const WHY_DRAG_PAN = 'pinch: moving';
const WHY_STALE = 'pinch: let go and pinch again';

export class GestureRecognizer {
  private tracks: HandTrack[] = [];
  private pool: HandTrack[] = [];
  private nextKey = 1;
  private mode: GestureMode = 'idle';
  private dragKey = '';
  /** the current drag moves the model (one-hand pinch) rather than turning it */
  private dragPans = false;
  private dragX0 = 0;
  private dragY0 = 0;
  private grabKey = '';
  private grabX0 = 0;
  private grabY0 = 0;
  private lastSweepAt = -1e9;
  private twoA: HandTrack | null = null;
  private twoB: HandTrack | null = null;
  private twoD0 = 1;
  private twoCx0 = 0;
  private twoCy0 = 0;
  private globeA: HandTrack | null = null;
  private globeB: HandTrack | null = null;
  private globeSince = -1;
  private globeAt = 0;
  private globeVYaw = 0;
  private globeVPitch = 0;
  /** the globe's recent pitch steps (ring buffer), for the undo when its hands drop out of view */
  private readonly globeHistT = new Float64Array(GLOBE_HISTORY);
  private readonly globeHistP = new Float64Array(GLOBE_HISTORY);
  private globeHistI = 0;
  /** when a globe turn last turned the model (the cue shows "Turning" only while it does) */
  globeMovedAt = -1e9;
  /** when a gesture last moved the model (drag, globe, two-hand) */
  private actionAt = -1e9;
  private lastBurstAt = -1e9;
  /** where (and when) a pinching hand was last lost, so the same hand found again does not resume as a fresh pinch */
  private lostAt = -1e9;
  private lostX = 0;
  private lostY = 0;
  private lostHs = 1;
  private wasEnabled = false;
  private readonly used: boolean[] = [];
  private readonly f: Features = { pinchDist: 0, open: 0, openW: 0, world: false, restOpen: 0, reach: 0, px: 0, py: 0, cx: 0, cy: 0 };
  private readonly out: GestureOutput = {
    mode: 'idle',
    dYaw: 0,
    dPitch: 0,
    dragEnd: null,
    spreadDelta: null,
    panX: 0,
    panY: 0,
    pan: false,
    moved: false,
    burst: null,
    sweep: false,
    events: [],
    marks: [],
    hands: [],
  };

  reset(): void {
    for (const t of this.tracks) this.pool.push(t);
    this.tracks.length = 0;
    this.mode = 'idle';
    this.dragKey = '';
    this.grabKey = '';
    this.twoA = this.twoB = this.globeA = this.globeB = null;
    this.globeSince = -1;
  }

  getMode(): GestureMode {
    return this.mode;
  }

  private newTrack(id: string, now: number): HandTrack {
    const t =
      this.pool.pop() ??
      ({
        key: '',
        fx: new Euro(1.2, 0.8),
        fy: new Euro(1.2, 0.8),
        fs: new Euro(1.0, 2),
        fo: new Euro(1.5, 0.6),
        fp: new Euro(2.5, 0.5),
        fw: new Euro(1.5, 0.6),
        fpx: new Euro(1.2, 0.8),
        fpy: new Euro(1.2, 0.8),
        info: {} as HandGestureInfo,
        mark: { key: '', x: 0, y: 0, active: false },
      } as HandTrack);
    t.key = `h${this.nextKey++}`;
    t.id = id;
    t.bornAt = now;
    t.freshAt = now;
    t.fresh = false;
    t.matched = false;
    t.lastPressAt = undefined;
    t.init = false;
    t.cx = t.cy = t.px = t.py = 0;
    t.hs = 8;
    t.lnS = Math.log(8);
    t.open = 1.2;
    t.openW = 1.2;
    t.world = false;
    t.armedAt = -1e9;
    t.sweepAt = -1;
    t.sweepX0 = t.sweepY0 = 0;
    t.sweepReady = false;
    t.pinchDist = 1;
    t.reach = 1.2;
    t.restOpen = 1.2;
    t.size = 0;
    t.raised = false;
    t.inFrame = false;
    t.palmIn = false;
    t.blocked = 'new';
    t.speed = 0;
    t.pinched = false;
    t.stale = false;
    t.mustReopen = false;
    t.closeSince = null;
    t.openSince = null;
    t.pinchAt = now;
    t.isFist = false;
    t.isSpread = false;
    t.fistSince = now;
    t.spreadSince = now;
    t.firmFist = false;
    t.firmSpread = false;
    t.fistLeftAt = -1e9;
    t.spreadLeftAt = -1e9;
    t.changeSpeed = 0;
    t.changeRate = 0;
    t.prevOpen = 1.2;
    t.cand = null;
    t.candAt = 0;
    t.candMs = 0;
    t.ready = null;
    t.burstAt = -1e9;
    t.gx = t.gy = t.gln = 0;
    t.info = {
      key: t.key,
      id,
      pinchDist: 0,
      open: 0,
      openW: 0,
      world: false,
      restOpen: 0,
      reach: 0,
      pinched: false,
      stale: false,
      shape: 'other',
      size: 0,
      raised: false,
      inFrame: false,
      blocked: 'new',
      held: false,
      doing: '',
      why: '',
      whyAt: -1e9,
      lastChangeMs: 0,
      lastChangeRate: 0,
    };
    t.mark.key = t.key;
    t.mark.active = false;
    return t;
  }

  private find(key: string): HandTrack | undefined {
    for (const t of this.tracks) if (t.key === key) return t;
    return undefined;
  }

  private why(t: HandTrack, text: string, now: number): void {
    t.info.why = text;
    t.info.whyAt = now;
  }

  /** One new camera frame for a hand: smoothed features, eligibility, pinch and openness states. */
  private sample(t: HandTrack, h: GestureHandInput, ts: number, fw: number, fh: number, ctx: GestureContext, tu: GestureTuning, enabled: boolean, justEnabled: boolean): void {
    const f = featuresInto(this.f, h.lm, h.handSize, fw, fh, tu.world ? h.world : null);
    const first = !t.init;
    const dt = first ? 1 / 30 : Math.min(0.1, Math.max(1 / 240, (ts - t.freshAt) / 1000));
    const hsRaw = Math.max(8, h.handSize);
    if (first) {
      t.init = true;
      t.fx.reset(f.cx);
      t.fy.reset(f.cy);
      t.fs.reset(Math.log(hsRaw));
      t.fo.reset(f.open);
      t.fw.reset(f.openW);
      t.fp.reset(f.pinchDist);
      t.fpx.reset(f.px);
      t.fpy.reset(f.py);
    }
    t.fresh = true;
    t.freshAt = ts;
    t.id = h.id;
    t.lastPressAt = h.lastPressAt;
    t.lnS = t.fs.step(Math.log(hsRaw), dt);
    t.hs = Math.exp(t.lnS);
    t.cx = t.fx.step(f.cx, dt, t.hs);
    t.cy = t.fy.step(f.cy, dt, t.hs);
    t.prevOpen = first ? f.open : t.open;
    t.open = t.fo.step(f.open, dt);
    // (switching between image and world shapes, e.g. ?world toggled, starts the filters again)
    if (f.world !== t.world) {
      t.fw.reset(f.openW);
      t.fp.reset(f.pinchDist);
      t.world = f.world;
    }
    t.openW = t.fw.step(f.openW, dt);
    t.pinchDist = t.fp.step(f.pinchDist, dt);
    t.px = t.fpx.step(f.px, dt, t.hs);
    t.py = t.fpy.step(f.py, dt, t.hs);
    t.reach = f.reach;
    t.restOpen = f.restOpen;
    t.speed = Math.hypot(t.fx.dx, t.fy.dx) / t.hs;
    t.inFrame = inFrame(h.lm);
    t.palmIn = t.cx > GLOBE_EDGE * fw && t.cx < (1 - GLOBE_EDGE) * fw && t.cy > GLOBE_EDGE * fh && t.cy < (1 - GLOBE_EDGE) * fh;

    // Only a deliberate, free hand (#107): not one on the desk typing or resting on the laptop, not one just come into view.
    const size = h.handSize / Math.max(1, fh);
    t.size = size;
    // (a hand already in a gesture keeps counting while it is pushed a little further away: hysteresis)
    const onDesk = size < (this.busyWith(t) ? KEEP_SIZE : 1) * tu.restHandMax;
    t.raised = !onDesk;
    t.blocked =
      onDesk && h.lastPressAt !== undefined && tu.typingMs > 0 && ts - h.lastPressAt < tu.typingMs
        ? 'typing'
        : onDesk && onBox(t.cx / fw, t.cy / fh, ctx.restBoxes)
          ? 'resting'
          : ts - t.bornAt < MIN_TRACKED_MS
            ? 'new'
            : null;

    // Pinch with hysteresis and hold times; a natural pinch (other fingers relaxed or curled) counts, a fist does not.
    const wasPinched = t.pinched;
    const near = t.pinchDist < tu.pinchOn;
    const closeEnough = t.blocked === null && near && t.reach >= tu.pinchReachMin;
    if (near && t.blocked === null && !closeEnough && !t.pinched) this.why(t, WHY_PINCH_FIST, ts);
    if (!t.pinched) {
      t.openSince = null;
      if (closeEnough) {
        if (t.closeSince === null) t.closeSince = ts;
        if (ts - t.closeSince >= tu.holdMs) {
          t.pinched = true;
          t.stale = !enabled || justEnabled || t.mustReopen;
          t.pinchAt = ts;
          t.fpx.reset(f.px);
          t.fpy.reset(f.py);
          t.px = f.px;
          t.py = f.py;
        }
      } else {
        t.closeSince = null;
      }
    } else {
      t.closeSince = null;
      if (t.pinchDist > tu.pinchOff) {
        if (t.openSince === null) t.openSince = ts;
        if (ts - t.openSince >= tu.releaseMs) t.pinched = false;
      } else {
        t.openSince = null;
      }
    }
    if (t.pinchDist > tu.pinchOff) t.mustReopen = false;
    // A pinch held while gestures were off, or by a hand that starts typing or resting, must be made again.
    if (t.pinched && (justEnabled || !enabled || t.blocked !== null)) t.stale = true;
    if (!t.pinched) t.stale = false;
    if (t.pinched && !wasPinched) this.out.events.push('pinch');
    if (!t.pinched && wasPinched) this.out.events.push('unpinch');

    // Openness states with hysteresis, and the burst: a firmly held fist (or spread hand) changing quickly.
    const o = t.open;
    const ok = enabled && t.blocked === null && t.raised && t.inFrame && !t.pinched;
    const rate = Math.abs(o - t.prevOpen) / dt;
    if (t.isFist) {
      if (o > tu.fistMax + OPEN_HYST) {
        t.isFist = false;
        if (t.firmFist) {
          t.fistLeftAt = ts;
          t.changeSpeed = t.speed;
          t.changeRate = rate;
        }
        t.firmFist = false;
      }
    } else if (o <= tu.fistMax) {
      t.isFist = true;
      t.fistSince = ts;
      t.fistLeftAt = -1e9;
      if (t.spreadLeftAt > -1e8) this.candidate(t, 'close', ts - t.spreadLeftAt, ts, tu);
    }
    if (t.isSpread) {
      if (o < tu.spreadMin - OPEN_HYST) {
        t.isSpread = false;
        if (t.firmSpread) {
          t.spreadLeftAt = ts;
          t.changeSpeed = t.speed;
          t.changeRate = rate;
        }
        t.firmSpread = false;
      }
    } else if (o >= tu.spreadMin) {
      t.isSpread = true;
      t.spreadSince = ts;
      t.spreadLeftAt = -1e9;
      if (t.fistLeftAt > -1e8) this.candidate(t, 'open', ts - t.fistLeftAt, ts, tu);
    }
    // Firm only while raised, free, fully in frame (a hand entering or leaving never is) and not part of
    // another gesture (closing a hand to end a globe turn is not a burst).
    if (!ok || this.busyWith(t)) {
      if (t.isFist) t.fistSince = ts;
      if (t.isSpread) t.spreadSince = ts;
      t.firmFist = t.firmSpread = false;
      if (t.cand !== null) {
        this.why(t, !t.raised ? WHY_BURST_LOW : !t.inFrame ? WHY_BURST_EDGE : !enabled ? WHY_BURST_STAGE : t.info.why, ts);
        t.cand = null;
      }
      t.fistLeftAt = t.spreadLeftAt = -1e9;
    } else {
      if (t.isFist && ts - t.fistSince >= FIRM_MS) t.firmFist = true;
      if (t.isSpread && ts - t.spreadSince >= FIRM_MS) t.firmSpread = true;
    }
    if (t.fistLeftAt > -1e8 || t.spreadLeftAt > -1e8 || t.cand !== null) {
      t.changeSpeed = Math.max(t.changeSpeed, t.speed);
      t.changeRate = Math.max(t.changeRate, rate);
    }
    // A change that has not arrived long after burstMs was a relax, not a burst: forget it (one that
    // arrives a little late is reported as too slow, for tuning).
    if (t.fistLeftAt > -1e8 && ts - t.fistLeftAt > 3 * tu.burstMs) t.fistLeftAt = -1e9;
    if (t.spreadLeftAt > -1e8 && ts - t.spreadLeftAt > 3 * tu.burstMs) t.spreadLeftAt = -1e9;
    // Confirm: the new shape held BURST_CONFIRM_MS.
    if (t.cand !== null) {
      const holding = t.cand === 'open' ? t.isSpread : t.isFist;
      if (!holding) t.cand = null;
      else if (ts - t.candAt >= BURST_CONFIRM_MS) {
        // fast enough at some point (a quick flick, not a hand relaxing open), and not a wave
        t.info.lastChangeRate = t.changeRate;
        if (t.changeRate < BURST_MIN_RATE) this.why(t, WHY_BURST_SLOW, ts);
        else if (t.changeSpeed > BURST_MAX_SPEED) this.why(t, WHY_BURST_MOVING, ts);
        else t.ready = t.cand;
        t.cand = null;
      }
    }

    // Open over the model: a fist soon after grabs it.
    const nx = t.cx / fw;
    const ny = t.cy / fh;
    const openNow = !t.pinched && !this.fistNow(t, tu) && Math.max(t.open, t.openW) >= tu.globeOpenMin;
    const mb = ctx.modelBox;
    if (openNow && mb && nx >= mb.x && nx <= mb.x + mb.w && ny >= mb.y && ny <= mb.y + mb.h) t.armedAt = ts;

    // The sweep: a flat open hand from the top of the frame down (a hand just come into view counts).
    const flat = openNow && t.blocked !== 'typing' && t.blocked !== 'resting';
    if (!tu.sweep || !enabled || !flat) {
      t.sweepAt = -1;
    } else if (ny <= SWEEP_TOP) {
      // at the top: a sweep starts from here (the last moment it was up here)
      t.sweepAt = ts;
      t.sweepX0 = nx;
      t.sweepY0 = ny;
    } else if (t.sweepAt >= 0) {
      const down = ny - t.sweepY0;
      if (ts - t.sweepAt > SWEEP_MAX_MS) {
        t.sweepAt = -1;
      } else if (ny >= SWEEP_BOTTOM && down >= SWEEP_MIN_DY && Math.abs(nx - t.sweepX0) * fw <= SWEEP_STRAIGHT * down * fh) {
        t.sweepReady = true;
        t.sweepAt = -1;
      }
    }
  }

  /** A fist by the image or by the 3D shape. */
  private fistNow(t: HandTrack, tu: GestureTuning): boolean {
    return t.isFist || (t.world && t.openW <= tu.fistMax);
  }

  /** Still a fist, with hysteresis (a grab ends only when both say the hand opened). */
  private stillFist(t: HandTrack, tu: GestureTuning): boolean {
    return t.open <= tu.fistMax + OPEN_HYST || (t.world && t.openW <= tu.fistMax + OPEN_HYST);
  }

  /** The hand reached the other shape `ms` after leaving a firm one: a burst candidate, or a reason it is not. */
  private candidate(t: HandTrack, kind: 'open' | 'close', ms: number, ts: number, tu: GestureTuning): void {
    t.info.lastChangeMs = ms;
    t.info.lastChangeRate = t.changeRate;
    if (kind === 'open') t.fistLeftAt = -1e9;
    else t.spreadLeftAt = -1e9;
    if (!tu.burst) return this.why(t, WHY_BURST_OFF, ts);
    if (ms > tu.burstMs) return this.why(t, WHY_BURST_SLOW, ts);
    if (Math.max(t.changeSpeed, t.speed) > BURST_MAX_SPEED) return this.why(t, WHY_BURST_MOVING, ts);
    t.cand = kind;
    t.candAt = ts;
    t.candMs = ms;
  }

  update(hands: GestureHandInput[], now: number, fw: number, fh: number, ctx: GestureContext, tu: GestureTuning): GestureOutput {
    const out = this.out;
    out.mode = 'idle';
    out.dYaw = 0;
    out.dPitch = 0;
    out.dragEnd = null;
    out.spreadDelta = null;
    out.panX = 0;
    out.panY = 0;
    out.pan = false;
    out.moved = false;
    out.burst = null;
    out.sweep = false;
    out.events.length = 0;
    out.marks.length = 0;
    out.hands.length = 0;
    const enabled = ctx.enabled && tu.enabled;
    const justEnabled = enabled && !this.wasEnabled;
    this.wasEnabled = enabled;

    // 1. Each hand from a new camera frame continues the nearest tracked hand (MediaPipe's label can flip).
    for (const t of this.tracks) {
      t.matched = false;
      t.fresh = false;
    }
    const used = this.used;
    used.length = hands.length;
    for (let i = 0; i < hands.length; i++) {
      const h = hands[i];
      used[i] = !h.lm || h.lm.length < 21 || (h.seenAt !== undefined && h.seenAt < now - 0.5);
    }
    for (;;) {
      let bi = -1;
      let bt: HandTrack | null = null;
      let bd = Infinity;
      for (let i = 0; i < hands.length; i++) {
        if (used[i]) continue;
        const lm = hands[i].lm;
        let x = 0;
        let y = 0;
        for (const k of PALM) {
          x += lm[k].x;
          y += lm[k].y;
        }
        x = (x / PALM.length) * fw;
        y = (y / PALM.length) * fh;
        for (const t of this.tracks) {
          if (t.matched) continue;
          const d = Math.hypot(x - t.cx, y - t.cy) / Math.max(8, t.hs, hands[i].handSize);
          if (d < bd) {
            bd = d;
            bi = i;
            bt = t;
          }
        }
      }
      if (!bt || bd > MATCH_HS) break;
      used[bi] = true;
      bt.matched = true;
      this.sample(bt, hands[bi], now, fw, fh, ctx, tu, enabled, justEnabled);
    }
    for (let i = 0; i < hands.length; i++) {
      if (used[i]) continue;
      const t = this.newTrack(hands[i].id, now);
      this.tracks.push(t);
      t.matched = true;
      this.sample(t, hands[i], now, fw, fh, ctx, tu, enabled, justEnabled);
      if (now - this.lostAt < REFOUND_MS && Math.hypot(t.cx - this.lostX, t.cy - this.lostY) < 2 * Math.max(t.hs, this.lostHs)) t.mustReopen = true;
    }
    // Hands with no new frame keep their state for HOLD_MS, then they are gone.
    for (let i = this.tracks.length - 1; i >= 0; i--) {
      const t = this.tracks[i];
      if (t.fresh || now - t.freshAt <= HOLD_MS) continue;
      if (t.pinched) {
        out.events.push('unpinch');
        this.lostAt = now;
        this.lostX = t.cx;
        this.lostY = t.cy;
        this.lostHs = t.hs;
      }
      this.tracks.splice(i, 1);
      this.pool.push(t);
    }

    // 2. Mode.
    this.updateMode(now, fw, fh, enabled, tu, ctx);

    // 3. Burst (idle only).
    for (const t of this.tracks) {
      if (t.ready === null) continue;
      const kind = t.ready;
      t.ready = null;
      if (!enabled) this.why(t, WHY_BURST_STAGE, now);
      else if (this.mode !== 'idle') this.why(t, WHY_BURST_BUSY, now);
      else if (now - this.lastBurstAt < BURST_REFRACTORY_MS) this.why(t, WHY_BURST_SOON, now);
      else if (now - this.actionAt < BURST_QUIET_MS) this.why(t, WHY_BURST_QUIET, now);
      else {
        this.lastBurstAt = now;
        t.burstAt = now;
        out.burst = kind;
        out.events.push(kind === 'open' ? 'burst-open' : 'burst-close');
        this.why(t, kind === 'open' ? WHY_BURST_OPEN : WHY_BURST_CLOSE, now);
        this.globeSince = -1;
      }
    }

    // 3b. Sweep down (idle only): close the exploded view.
    for (const t of this.tracks) {
      if (!t.sweepReady) continue;
      t.sweepReady = false;
      if (!enabled || this.mode !== 'idle' || now - this.lastSweepAt < SWEEP_REFRACTORY_MS || now - this.actionAt < SWEEP_QUIET_MS) continue;
      this.lastSweepAt = now;
      out.sweep = true;
      out.events.push('sweep');
      this.why(t, WHY_SWEEP, now);
      this.globeSince = -1;
    }

    // 4. Per-hand info and the markers.
    out.mode = this.mode;
    for (const t of this.tracks) {
      const inf = t.info;
      inf.key = t.key;
      inf.id = t.id;
      inf.pinchDist = t.pinchDist;
      inf.open = t.open;
      inf.openW = t.openW;
      inf.world = t.world;
      inf.restOpen = t.restOpen;
      inf.reach = t.reach;
      inf.pinched = t.pinched;
      inf.stale = t.stale;
      inf.shape = t.pinched ? 'pinch' : this.fistNow(t, tu) ? 'fist' : Math.max(t.open, t.openW) >= tu.globeOpenMin ? 'open' : 'other';
      inf.size = t.size;
      inf.raised = t.raised;
      inf.inFrame = t.inFrame;
      inf.blocked = t.blocked;
      inf.held = !t.fresh && now - t.freshAt > 45;
      inf.doing = this.doing(t, now);
      out.hands.push(inf);
      if (enabled && t.blocked === null) {
        // At the fingertips (where the pinch happens); at the palm for a fist (the grab).
        const atPalm = (this.mode === 'grab' && t.key === this.grabKey) || inf.shape === 'fist';
        t.mark.x = (atPalm ? t.cx : t.px) / fw;
        t.mark.y = (atPalm ? t.cy : t.py) / fh;
        // filled as soon as a pinch counts, and while the hand is doing something
        t.mark.active = (inf.doing !== '' && inf.doing !== GLOBE_STILL_DOING) || (t.pinched && !t.stale);
        out.marks.push(t.mark);
      }
    }
    return out;
  }

  private doing(t: HandTrack, now: number): string {
    if (now - t.burstAt < BURST_SHOW_MS) return 'burst';
    switch (this.mode) {
      case 'drag':
        return t.key === this.dragKey ? (this.dragPans ? 'moving' : 'turning') : '';
      case 'grab':
        return t.key === this.grabKey ? 'grabbing' : '';
      case 'two':
      case 'spread':
      case 'pan':
        return t === this.twoA || t === this.twoB ? (this.mode === 'two' ? 'two-hand' : this.mode === 'spread' ? 'opening' : 'moving') : '';
      case 'globe':
        // filled only while the globe is actually turning the model
        return t === this.globeA || t === this.globeB ? (now - this.globeMovedAt < GLOBE_SHOW_MS ? 'globe' : GLOBE_STILL_DOING) : '';
      default:
        return '';
    }
  }

  /** The hand takes part in the current drag, two-hand pinch or globe turn. */
  private busyWith(t: HandTrack): boolean {
    return (
      (this.mode === 'drag' && t.key === this.dragKey) ||
      (this.mode === 'grab' && t.key === this.grabKey) ||
      ((this.mode === 'two' || this.mode === 'spread' || this.mode === 'pan') && (t === this.twoA || t === this.twoB)) ||
      (this.mode === 'globe' && (t === this.globeA || t === this.globeB))
    );
  }

  private present(t: HandTrack | null): t is HandTrack {
    return t !== null && this.tracks.indexOf(t) >= 0;
  }

  /** After a two-hand pinch, a hand still pinching must let go and pinch again. */
  private staleAfterTwo(t: HandTrack | null): void {
    if (!t || !t.pinched) return;
    t.stale = true;
    this.why(t, WHY_STALE, t.freshAt);
  }

  /**
   * The globe pose for one hand: raised, free, open, not pinching, not a fist. Once the globe is on, a
   * hand pushed away (smaller) stays raised down to KEEP_SIZE of restHandMax.
   */
  private globePose(t: HandTrack, tu: GestureTuning): boolean {
    return t.blocked === null && t.raised && t.palmIn && !t.pinched && !t.isFist && t.open >= tu.globeOpenMin;
  }

  private endMode(now: number, reason: 'release' | 'cancel'): void {
    const out = this.out;
    if (this.mode === 'drag' || this.mode === 'globe') {
      // (a pinch that moved the model just stops: nothing coasts)
      if (!(this.mode === 'drag' && this.dragPans)) out.dragEnd = reason;
      out.events.push(this.mode === 'drag' ? 'drag-end' : 'globe-end');
    } else if (this.mode === 'grab') {
      out.events.push('grab-end');
    } else if (this.mode !== 'idle') {
      out.events.push('two-end');
    }
    this.mode = 'idle';
    this.dragKey = '';
    this.dragPans = false;
    this.grabKey = '';
    this.twoA = this.twoB = this.globeA = this.globeB = null;
    this.globeSince = -1;
    void now;
  }

  private updateMode(now: number, fw: number, fh: number, enabled: boolean, tu: GestureTuning, ctx: GestureContext): void {
    const out = this.out;
    void ctx;
    void fw;
    void fh;
    if (!enabled) {
      if (this.mode !== 'idle') this.endMode(now, 'cancel');
      return;
    }
    // Fresh pinches (not stale).
    let la: HandTrack | null = null;
    let lb: HandTrack | null = null;
    let nLive = 0;
    for (const t of this.tracks) {
      if (!t.pinched || t.stale) continue;
      nLive += 1;
      if (!la) la = t;
      else if (!lb) lb = t;
    }

    if (this.mode === 'drag') {
      const t = this.find(this.dragKey);
      if (!t || !t.pinched || t.stale) {
        // Let go: coast. Blocked mid-drag (it started typing or resting): stop dead, no fling.
        this.endMode(now, t && t.pinched && t.blocked !== null ? 'cancel' : 'release');
        if (t && t.pinched) this.why(t, WHY_STALE, now);
      } else if (nLive >= 2 && tu.twoHand && la && lb) {
        this.endMode(now, 'cancel');
        this.startTwo(la, lb, now);
      } else if (this.dragPans) {
        // The model follows the pinch point.
        out.pan = true;
        out.panX = (t.px - this.dragX0) * tu.panGain;
        out.panY = (t.py - this.dragY0) * tu.panGain;
        if (t.fresh) this.actionAt = now;
      } else {
        if (t.fresh) {
          const dx = capStep((t.cx - t.gx) / t.hs);
          const dy = capStep((t.cy - t.gy) / t.hs);
          out.moved = true;
          t.gx = t.cx;
          t.gy = t.cy;
          out.dYaw = dx * tu.rotGain;
          out.dPitch = dy * tu.rotGain * PITCH_FACTOR;
          if (out.dYaw !== 0 || out.dPitch !== 0) this.actionAt = now;
        }
      }
      return;
    }

    if (this.mode === 'grab') {
      const t = this.find(this.grabKey);
      if (!t || !tu.grab || t.blocked !== null || t.pinched || !this.stillFist(t, tu)) {
        this.endMode(now, 'release');
        return;
      }
      out.pan = true;
      out.panX = (t.cx - this.grabX0) * tu.panGain;
      out.panY = (t.cy - this.grabY0) * tu.panGain;
      if (t.fresh) this.actionAt = now;
      return;
    }

    if (this.mode === 'two' || this.mode === 'spread' || this.mode === 'pan') {
      const a = this.twoA;
      const b = this.twoB;
      if (!this.present(a) || !this.present(b) || !a.pinched || !b.pinched || a.stale || b.stale || !tu.twoHand) {
        // One hand let go: the other must pinch again before it turns the model.
        this.staleAfterTwo(a);
        this.staleAfterTwo(b);
        this.endMode(now, 'release');
        return;
      }
      const d = Math.max(1, Math.hypot(a.px - b.px, a.py - b.py));
      const hsm = (a.hs + b.hs) / 2;
      const cx = (a.px + b.px) / 2;
      const cy = (a.py + b.py) / 2;
      if (this.mode === 'two') {
        const sep = Math.abs(d - this.twoD0) / hsm;
        const com = Math.hypot(cx - this.twoCx0, cy - this.twoCy0) / hsm;
        if (Math.max(sep, com) >= TWO_DECIDE_HS) {
          if (sep >= com || !tu.pan) {
            this.mode = 'spread';
            out.events.push('spread-start');
            this.why(a, WHY_TWO_SPREAD, now);
            this.why(b, WHY_TWO_SPREAD, now);
          } else {
            this.mode = 'pan';
            out.events.push('pan-start');
            this.why(a, WHY_TWO_PAN, now);
            this.why(b, WHY_TWO_PAN, now);
          }
        }
      }
      if (this.mode === 'spread') {
        out.spreadDelta = tu.spreadGain * Math.log2(d / this.twoD0);
        this.actionAt = now;
      } else if (this.mode === 'pan') {
        out.pan = true;
        out.panX = (cx - this.twoCx0) * tu.panGain;
        out.panY = (cy - this.twoCy0) * tu.panGain;
        this.actionAt = now;
      }
      return;
    }

    if (this.mode === 'globe') {
      const a = this.globeA;
      const b = this.globeB;
      const exit = !this.present(a) || !this.present(b) || !a.palmIn || !b.palmIn;
      if (exit || !tu.globe || !this.globePose(a, tu) || !this.globePose(b, tu) || nLive > 0) {
        if (exit) {
          // Dropped out of view: give back the tipping of the last moment, and stop dead.
          let p = 0;
          for (let i = 0; i < GLOBE_HISTORY; i++) if (now - this.globeHistT[i] <= GLOBE_UNDO_MS) p += this.globeHistP[i];
          if (p > 0) {
            out.dPitch = -p;
            out.moved = true;
          }
        }
        this.endMode(now, exit || (a && a.blocked !== null) || (b && b.blocked !== null) ? 'cancel' : 'release');
        return;
      }
      if (a.fresh || b.fresh) {
        const dt = Math.min(0.1, Math.max(1 / 240, (now - this.globeAt) / 1000));
        this.globeAt = now;
        // left / right in the image, for the depth cue
        const l = a.cx <= b.cx ? a : b;
        const r = l === a ? b : a;
        const hsm = (a.hs + b.hs) / 2;
        const mx = capStep((l.cx - l.gx + (r.cx - r.gx)) / 2 / hsm);
        const my = capStep((l.cy - l.gy + (r.cy - r.gy)) / 2 / hsm);
        // one hand pulled in (bigger) while the other is pushed away (smaller): the near side of the globe moves
        const depth = Math.max(-0.3, Math.min(0.3, (l.lnS - l.gln - (r.lnS - r.gln)) / 2));
        markPalm(l);
        markPalm(r);
        out.moved = true;
        const yawRate = (mx * tu.globeGain + depth * GLOBE_DEPTH_GAIN) / dt;
        const pitchRate = (my * tu.globeGain * PITCH_FACTOR) / dt;
        this.globeVYaw += (yawRate - this.globeVYaw) * 0.5;
        this.globeVPitch += (pitchRate - this.globeVPitch) * 0.5;
        const rate = Math.hypot(this.globeVYaw, this.globeVPitch);
        const dead = tu.globeDeadZone * tu.globeGain;
        if (rate > dead) {
          const k = (rate - dead) / rate;
          out.dYaw = this.globeVYaw * k * dt;
          out.dPitch = this.globeVPitch * k * dt;
          this.globeMovedAt = now;
          this.actionAt = now;
          this.globeHistT[this.globeHistI] = now;
          this.globeHistP[this.globeHistI] = out.dPitch;
          this.globeHistI = (this.globeHistI + 1) % GLOBE_HISTORY;
        }
      }
      return;
    }

    // Idle: two fresh pinches, one (after DRAG_DELAY_MS), or the globe pose.
    if (nLive >= 2 && tu.twoHand && la && lb) {
      this.startTwo(la, lb, now);
      return;
    }
    // (a lone pinch also waits while another hand has no new frame: it may be pinching too)
    let otherHeld = false;
    for (const t of this.tracks) if (t !== la && !t.fresh && now - t.freshAt > 45) otherHeld = true;
    if (nLive >= 1 && la && now - la.pinchAt >= DRAG_DELAY_MS && !otherHeld) {
      this.mode = 'drag';
      this.dragKey = la.key;
      this.dragPans = !tu.pinchTurns;
      this.dragX0 = la.px;
      this.dragY0 = la.py;
      la.gx = la.cx;
      la.gy = la.cy;
      out.events.push('drag-start');
      this.why(la, this.dragPans ? WHY_DRAG_PAN : WHY_DRAG, now);
      this.globeSince = -1;
      return;
    }
    if (nLive > 0) {
      this.globeSince = -1;
      return;
    }
    // The grab: a hand that was open over the model a moment ago is now a fist.
    if (tu.grab) {
      for (const t of this.tracks) {
        if (t.blocked !== null || t.pinched || !t.fresh || !this.fistNow(t, tu) || now - t.armedAt > GRAB_ARM_MS) continue;
        this.mode = 'grab';
        this.grabKey = t.key;
        this.grabX0 = t.cx;
        this.grabY0 = t.cy;
        t.armedAt = -1e9;
        out.events.push('grab-start');
        this.why(t, WHY_GRAB, now);
        this.globeSince = -1;
        return;
      }
    }
    // The globe: the first two hands that are not blocked.
    let ga: HandTrack | null = null;
    let gb: HandTrack | null = null;
    for (const t of this.tracks) {
      if (t.blocked !== null) continue;
      if (!ga) ga = t;
      else if (!gb) gb = t;
    }
    if (!ga || !gb) {
      this.globeSince = -1;
      return;
    }
    const pa = this.globePose(ga, tu);
    const pb = this.globePose(gb, tu);
    if (!tu.globe) {
      if (pa && pb && this.globeSince < 0) {
        this.why(ga, WHY_GLOBE_OFF, now);
        this.why(gb, WHY_GLOBE_OFF, now);
        this.globeSince = now;
      }
      return;
    }
    if (!pa || !pb) {
      if (this.globeSince >= 0 || pa || pb) {
        // one hand is open: say why the globe does not start
        const bad = pa ? gb : ga;
        const good = pa ? ga : gb;
        if (pa || pb) this.why(good, !bad.raised ? WHY_GLOBE_LOW : WHY_GLOBE_OTHER, now);
      }
      this.globeSince = -1;
      return;
    }
    if (this.globeSince < 0) {
      this.globeSince = now;
      this.why(ga, WHY_GLOBE_WAIT, now);
      this.why(gb, WHY_GLOBE_WAIT, now);
      return;
    }
    if (now - this.globeSince >= GLOBE_ENGAGE_MS && ga.speed < GLOBE_STILL && gb.speed < GLOBE_STILL) {
      this.mode = 'globe';
      this.globeA = ga;
      this.globeB = gb;
      this.globeAt = now;
      this.globeVYaw = this.globeVPitch = 0;
      this.globeHistT.fill(-1e9);
      markPalm(ga);
      markPalm(gb);
      out.events.push('globe-start');
      this.why(ga, WHY_GLOBE_ON, now);
      this.why(gb, WHY_GLOBE_ON, now);
    }
  }

  private startTwo(a: HandTrack, b: HandTrack, now: number): void {
    this.mode = 'two';
    this.twoA = a;
    this.twoB = b;
    this.twoD0 = Math.max(1, Math.hypot(a.px - b.px, a.py - b.py));
    this.twoCx0 = (a.px + b.px) / 2;
    this.twoCy0 = (a.py + b.py) / 2;
    this.globeSince = -1;
    this.out.events.push('two-start');
    this.why(a, WHY_TWO_WAIT, now);
    this.why(b, WHY_TWO_WAIT, now);
  }
}
