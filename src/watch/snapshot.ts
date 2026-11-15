/**
 * The watch snapshot (`?watch=1`, the big-screen view): everything the overlay, the HUD and the captions
 * read, as compact JSON, built on the phone (./publish.ts) and applied on the watch page (./follow.ts).
 * Pure: type imports only, so it runs anywhere (tests too); the callers pass the store, `live` and the rest.
 *
 * What goes in (docs/CONTRACTS.md "The big-screen view"):
 *  - `store`: every store field holding a plain value (number, string, boolean, null), found by itself,
 *    so a new primitive field is mirrored with no change here; numbers rounded to 4 decimals. A store field
 *    holding an object or an array that is small goes in EXTRA_STORE_KEYS (one list).
 *  - large fields (BIG_KEYS + `saved`): sent only when they change (a new object, as the store makes on
 *    every change), else only their version in `ver`. The server keeps the latest of each, so a watcher
 *    that comes late gets them all with its first snapshot (server/lib/watchHub.ts).
 *  - the frame size, the tracked objects (with their names) and hands (landmarks, finger glows and press
 *    times), the gesture markers and cue word, the busy text, when the model was last touched, push-to-talk.
 * Times (press times, last input) are the phone's performance.now(); the watch maps them onto its own clock
 * with one steady offset, so a press is seen once.
 */
import type { AppState, FingerName, HandState, SceneObject } from '../state/store';
import type { FingerDyn, TrackedHand } from '../detect/handTracker';
import type { GestureMark } from '../detect/gestures';
import type { SavedItem } from '../lib/saved';

export const WATCH_VERSION = 1;

/** Store fields that can be large: sent only when they change. */
export const BIG_STORE_KEYS = ['teardown', 'detail', 'transcript'] as const satisfies readonly (keyof AppState)[];
/** Every large field: the store's, plus the saved models (src/lib/saved.ts) for the HUD's row of pills. */
export const BIG_KEYS = [...BIG_STORE_KEYS, 'saved'] as const;
export type BigKey = (typeof BIG_KEYS)[number];

/**
 * Store fields holding a small object or array, sent with every snapshot. Plain-value fields need no entry
 * (they are all sent); add a field here when it holds an object and the overlay or the HUD reads it.
 */
export const EXTRA_STORE_KEYS: readonly (keyof AppState)[] = [];

/** Never sent: the camera API, and what `objects` / `hands` carry below. */
const SKIP_KEYS = new Set<string>(['camera', 'objects', 'hands', ...BIG_STORE_KEYS]);

const FINGER_ORDER: FingerName[] = ['thumb', 'index', 'middle', 'ring', 'pinky'];

export interface WireHand {
  id: TrackedHand['id'];
  handedness: 'left' | 'right';
  score: number;
  /** 21 landmarks as x, y, z, x, y, z, ... (normalised frame coords) */
  lm: number[];
  /** per finger, thumb to pinky: curl, pressing (0 / 1), flexGlow, extendGlow */
  f: number[];
  /** per finger, thumb to pinky: when it last pressed / last lifted quickly (phone ms) */
  press: number[];
  lift: number[];
  active: FingerName | null;
  activeAt: number;
  size: number;
}

export interface WatchSnapshot {
  v: typeof WATCH_VERSION;
  /** this phone page's id (a reload is a new one) */
  sid: string;
  seq: number;
  /** the phone's performance.now() when it was built */
  t: number;
  /** the phone's camera frame size (frameSize()): the watch's cover map uses it */
  frame: { w: number; h: number };
  store: Record<string, unknown>;
  /** the version of every large field; `big` has the ones sent this time */
  ver: Record<BigKey, string>;
  big?: Partial<Record<BigKey, unknown>>;
  objects: SceneObject[];
  hands: WireHand[];
  marks: GestureMark[];
  hint: string | null;
  busy: string | null;
  /** modelControl.lastInputAt (phone ms): the overlay's idle drift waits for quiet */
  inputAt: number;
  /** push-to-talk: the microphone is muted until held (the voice pill says "Hold to talk") */
  micHold: boolean;
  /** set by the server on a watcher's first snapshot: ms since the phone sent it */
  age?: number;
}

export interface SnapshotSource {
  state: AppState;
  liveObjects: SceneObject[];
  liveHands: TrackedHand[];
  marks: GestureMark[];
  hint: string | null;
  busy: string | null;
  saved: SavedItem[];
  inputAt: number;
  micHold: boolean;
  frame: { w: number; h: number };
  now: number;
}

const r4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const r3 = (n: number): number => Math.round(n * 1e3) / 1e3;
/** Times: whole ms, the "never" sentinels (-1e9) kept. */
const rt = (n: number): number => (Number.isFinite(n) ? Math.round(n) : -1e9);
const num = (n: unknown, d = 0): number => (typeof n === 'number' && Number.isFinite(n) ? n : d);

function wireObject(o: SceneObject, name: string | undefined): SceneObject {
  const out: SceneObject = {
    id: o.id,
    label: o.label,
    confidence: r3(o.confidence),
    box: { x: r4(o.box.x), y: r4(o.box.y), w: r4(o.box.w), h: r4(o.box.h) },
    lens: o.lens,
    anchor: o.anchor,
  };
  const n = o.name ?? name;
  if (n) out.name = n;
  return out;
}

function wireHand(h: TrackedHand): WireHand {
  const lm: number[] = [];
  for (const p of h.lm) lm.push(r4(p.x), r4(p.y), r4(p.z));
  const f: number[] = [];
  const press: number[] = [];
  const lift: number[] = [];
  for (const k of FINGER_ORDER) {
    const d = h.dyn[k];
    f.push(r3(d.curl), d.pressing ? 1 : 0, r3(d.flexGlow), r3(d.extendGlow));
    press.push(rt(d.lastPressAt));
    lift.push(rt(d.extendStart));
  }
  return { id: h.id, handedness: h.handedness, score: r3(h.score), lm, f, press, lift, active: h.activeFinger, activeAt: rt(h.activeAt), size: r3(h.handSize) };
}

/** The store's plain values (and EXTRA_STORE_KEYS), rounded. */
export function storeFields(state: AppState): Record<string, unknown> {
  const src = state as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(src)) {
    if (SKIP_KEYS.has(k)) continue;
    const v = src[k];
    if (typeof v === 'number') {
      if (Number.isFinite(v)) out[k] = r4(v);
    } else if (typeof v === 'string' || typeof v === 'boolean' || v === null) {
      out[k] = v;
    }
  }
  for (const k of EXTRA_STORE_KEYS) {
    const v = src[k];
    if (v !== undefined && typeof v !== 'function') out[k] = v;
  }
  return out;
}

/**
 * The phone's side of the large fields: a version per field that changes when its value is a new object,
 * and which versions the server has (after a post that worked). `resendAll` when the server asks.
 */
export class BigFields {
  private readonly refs = new Map<BigKey, unknown>();
  private readonly vers = new Map<BigKey, string>();
  private acked: Partial<Record<BigKey, string>> = {};
  private n = 0;

  constructor(private readonly sid: string) {}

  /** Versions for these values, and the values the server does not have yet. */
  prepare(values: Record<BigKey, unknown>): { ver: Record<BigKey, string>; big: Partial<Record<BigKey, unknown>> } {
    const ver = {} as Record<BigKey, string>;
    const big: Partial<Record<BigKey, unknown>> = {};
    for (const k of BIG_KEYS) {
      const value = values[k];
      if (!this.vers.has(k) || this.refs.get(k) !== value) {
        this.n += 1;
        this.refs.set(k, value);
        this.vers.set(k, `${this.sid}.${this.n}`);
      }
      const v = this.vers.get(k) as string;
      ver[k] = v;
      if (this.acked[k] !== v) big[k] = value ?? null;
    }
    return { ver, big };
  }

  /** The server has these versions now. */
  ack(ver: Record<BigKey, string>): void {
    this.acked = { ...ver };
  }

  /** Send every large field again with the next snapshot. */
  resendAll(): void {
    this.acked = {};
  }
}

/** One snapshot of the phone's view. `ver` / `big` from BigFields.prepare. */
export function buildSnapshot(
  src: SnapshotSource,
  sid: string,
  seq: number,
  fields: { ver: Record<BigKey, string>; big: Partial<Record<BigKey, unknown>> },
): WatchSnapshot {
  const names = new Map<string, string | undefined>();
  for (const o of src.state.objects) if (o.name) names.set(o.id, o.name);
  const snap: WatchSnapshot = {
    v: WATCH_VERSION,
    sid,
    seq,
    t: rt(src.now),
    frame: { w: Math.round(src.frame.w), h: Math.round(src.frame.h) },
    store: storeFields(src.state),
    ver: fields.ver,
    objects: src.liveObjects.map((o) => wireObject(o, names.get(o.id))),
    hands: src.liveHands.filter((h) => h.lm.length >= 21).map(wireHand),
    marks: src.marks.map((m) => ({ key: m.key, x: r4(m.x), y: r4(m.y), active: m.active, label: m.label })),
    hint: src.hint,
    busy: src.busy,
    inputAt: rt(src.inputAt),
    micHold: src.micHold,
  };
  if (Object.keys(fields.big).length > 0) snap.big = fields.big;
  return snap;
}

/** The values BigFields.prepare wants, from a store state and the saved list. */
export function bigValues(state: AppState, saved: SavedItem[]): Record<BigKey, unknown> {
  return { teardown: state.teardown, detail: state.detail, transcript: state.transcript, saved };
}

/* ------------------------------------ the watch page ------------------------------------ */

/** Where a snapshot goes on the watch page (./follow.ts gives the store, `live` and the rest). */
export interface ApplyTarget {
  getState: () => Record<string, unknown>;
  setState: (patch: Record<string, unknown>) => void;
  setLive: (objects: SceneObject[], hands: TrackedHand[]) => void;
  setGesture: (marks: GestureMark[], hint: string | null) => void;
  setBusy: (text: string | null) => void;
  setSaved: (items: SavedItem[]) => void;
  setInputAt: (t: number) => void;
  setFrame: (w: number, h: number) => void;
  setMicHold: (held: boolean) => void;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Enough of a snapshot to apply (anything else is ignored). */
export function isSnapshot(v: unknown): v is WatchSnapshot {
  return (
    isRecord(v) &&
    v.v === WATCH_VERSION &&
    typeof v.sid === 'string' &&
    typeof v.t === 'number' &&
    isRecord(v.store) &&
    isRecord(v.ver) &&
    Array.isArray(v.objects) &&
    Array.isArray(v.hands)
  );
}

const isPlain = (v: unknown): boolean =>
  v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const NEVER = -1e8;

/** At most this many of each list is applied (more is a broken or hostile snapshot). */
export const WATCH_CAPS = { objects: 32, hands: 2, marks: 4, transcript: 20, saved: 12 } as const;

/**
 * Checks for the large fields that the watch page passes in (./follow.ts: the zod schemas of
 * shared/teardown.ts and shared/detail.ts); true = apply it. A value that fails is ignored and the
 * previous one kept. Without a check a value is applied as it is (tests).
 */
export type BigChecks = Partial<Record<BigKey, (value: unknown) => boolean>>;

/** fal's own domains, as server/lib/fal.ts allows for generated models (https only). */
const FAL_HOSTS = ['fal.media', 'fal.ai', 'fal.run'];
const PAGE = 'http://watch.invalid';

/**
 * A URL from the phone that the watch page may load (a part's mesh_url): a same-origin path ("/cache/...",
 * never "//host" or "/\host"), or an https URL on fal's domains (what /api/generate-part returns). Else null.
 */
export function safeAssetUrl(u: unknown): string | null {
  if (typeof u !== 'string' || u.length === 0 || u.length > 2048) return null;
  try {
    if (u.startsWith('/')) {
      if (u.startsWith('//') || u.startsWith('/\\')) return null;
      const r = new URL(u, PAGE);
      return r.origin === PAGE ? u : null;
    }
    const r = new URL(u);
    return r.protocol === 'https:' && FAL_HOSTS.some((h) => r.hostname === h || r.hostname.endsWith(`.${h}`)) ? r.href : null;
  } catch {
    return null;
  }
}

/** A saved pill's picture: only a small inline JPEG / PNG / WebP (what src/lib/saved.ts makes). */
function safeThumb(u: unknown): string | null {
  return typeof u === 'string' && u.length < 200_000 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]*$/.test(u) ? u : null;
}

/** The teardown with every part's mesh_url that is not safeAssetUrl set to null. */
function withSafeMeshes(td: unknown): unknown {
  if (!isRecord(td) || !Array.isArray(td.parts)) return td;
  return {
    ...td,
    parts: td.parts.map((p: unknown) => {
      if (!isRecord(p) || p.mesh_url === undefined || p.mesh_url === null) return p;
      return { ...p, mesh_url: safeAssetUrl(p.mesh_url) };
    }),
  };
}

function cleanTranscript(v: unknown): unknown[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((l) => isRecord(l) && (l.role === 'user' || l.role === 'agent') && typeof l.text === 'string')
    .slice(-WATCH_CAPS.transcript);
}

const GLYPHS = new Set(['eye', 'hand', 'object']);
function cleanSaved(v: unknown): SavedItem[] {
  if (!Array.isArray(v)) return [];
  const out: SavedItem[] = [];
  for (const it of v) {
    if (!isRecord(it) || typeof it.id !== 'string' || typeof it.name !== 'string' || !validBox(it.box)) continue;
    if (!GLYPHS.has(String(it.glyph))) continue;
    out.push({ ...(it as unknown as SavedItem), thumb: safeThumb(it.thumb) });
    if (out.length >= WATCH_CAPS.saved) break;
  }
  return out;
}

function newDyn(): FingerDyn {
  return { prevRel: null, vel: 0, signal: 0, pressing: false, pressStart: 0, lastPressAt: -1e9, extending: false, extendStart: 0, peak: 0, flexGlow: 0, extendGlow: 0, curl: 0 };
}

function validBox(b: unknown): boolean {
  return isRecord(b) && isNum(b.x) && isNum(b.y) && isNum(b.w) && isNum(b.h);
}

function validObject(o: unknown): o is SceneObject {
  return isRecord(o) && typeof o.id === 'string' && typeof o.label === 'string' && isNum(o.confidence) && validBox(o.box);
}

function validMark(m: unknown): m is GestureMark {
  return isRecord(m) && typeof m.key === 'string' && isNum(m.x) && isNum(m.y) && typeof m.active === 'boolean' && typeof m.label === 'string';
}

/** A check that throws counts as a failed check. */
function safeCheck(check: (value: unknown) => boolean, value: unknown): boolean {
  try {
    return check(value) === true;
  } catch {
    return false;
  }
}

/** Applies snapshots in order, on the watch page. Keeps which large-field versions it has and the clock offset. */
export class SnapshotApplier {
  private readonly applied = new Map<BigKey, string>();
  private offset: number | null = null;
  private sid = '';

  constructor(private readonly checks: BigChecks = {}) {}

  /** The phone's time t on this page's clock. */
  private local(t: number): number {
    return t <= NEVER || this.offset === null ? t : t + this.offset;
  }

  apply(snap: WatchSnapshot, localNow: number, target: ApplyTarget): void {
    // One steady offset between the two clocks (the smallest seen: the least delay), reset on a jump or a new phone page.
    const est = localNow - snap.t;
    if (this.offset === null || snap.sid !== this.sid || Math.abs(est - this.offset) > 1000) this.offset = est;
    else if (est < this.offset) this.offset = est;
    this.sid = snap.sid;

    const state = target.getState();
    const patch: Record<string, unknown> = {};
    const extra = new Set<string>(EXTRA_STORE_KEYS);
    for (const [k, v] of Object.entries(snap.store)) {
      if (SKIP_KEYS.has(k) || !(k in state) || typeof state[k] === 'function') continue;
      if (!isPlain(v) && !extra.has(k)) continue;
      if (state[k] !== v) patch[k] = v;
    }
    const big = isRecord(snap.big) ? snap.big : {};
    for (const k of BIG_KEYS) {
      const v = snap.ver[k];
      if (typeof v !== 'string' || this.applied.get(k) === v || !(k in big)) continue;
      this.applied.set(k, v);
      const value = big[k] ?? null;
      if (k === 'saved') target.setSaved(cleanSaved(value));
      else if (k === 'transcript') patch.transcript = cleanTranscript(value);
      else {
        // an invalid teardown / detail is ignored: the previous one stays
        const check = this.checks[k];
        if (value !== null && check && !safeCheck(check, value)) continue;
        patch[k] = k === 'teardown' ? withSafeMeshes(value) : value;
      }
    }

    const objects = snap.objects.filter(validObject).slice(0, WATCH_CAPS.objects);
    const tracked: TrackedHand[] = [];
    const states: HandState[] = [];
    for (const w of snap.hands) {
      if (tracked.length >= WATCH_CAPS.hands) break;
      const h = this.hand(w, localNow);
      if (!h) continue;
      tracked.push(h);
      const fingers = {} as HandState['fingers'];
      for (const f of FINGER_ORDER) fingers[f] = { curl: h.dyn[f].curl, pressing: h.dyn[f].pressing };
      states.push({ handedness: h.handedness, landmarks: h.lm.map((p) => ({ x: p.x, y: p.y, z: p.z })), fingers, activeFinger: h.activeFinger });
    }
    patch.objects = objects;
    patch.hands = states;
    const marks = Array.isArray(snap.marks) ? snap.marks.filter(validMark).slice(0, WATCH_CAPS.marks) : [];

    if (isRecord(snap.frame) && isNum(snap.frame.w) && isNum(snap.frame.h) && snap.frame.w > 0 && snap.frame.h > 0 && snap.frame.w < 20_000 && snap.frame.h < 20_000) {
      target.setFrame(snap.frame.w, snap.frame.h);
    }
    target.setLive(objects, tracked);
    target.setState(patch);
    target.setGesture(marks, typeof snap.hint === 'string' ? snap.hint : null);
    target.setBusy(typeof snap.busy === 'string' ? snap.busy : null);
    target.setInputAt(this.local(num(snap.inputAt, -1e9)));
    target.setMicHold(snap.micHold === true);
  }

  private hand(w: unknown, localNow: number): TrackedHand | null {
    if (!isRecord(w) || !Array.isArray(w.lm) || w.lm.length !== 63 || !Array.isArray(w.f) || w.f.length !== 20) return null;
    // every landmark and finger number must be a finite number, else the hand is dropped
    if (!(w.lm as unknown[]).every(isNum) || !(w.f as unknown[]).every(isNum)) return null;
    const lmIn = w.lm as unknown[];
    const lm: TrackedHand['lm'] = [];
    for (let i = 0; i < 21; i++) lm.push({ x: num(lmIn[i * 3]), y: num(lmIn[i * 3 + 1]), z: num(lmIn[i * 3 + 2]) });
    const f = w.f as unknown[];
    const press = Array.isArray(w.press) ? (w.press as unknown[]) : [];
    const lift = Array.isArray(w.lift) ? (w.lift as unknown[]) : [];
    const dyn = {} as Record<FingerName, FingerDyn>;
    FINGER_ORDER.forEach((k, i) => {
      const d = newDyn();
      d.curl = num(f[i * 4]);
      d.pressing = num(f[i * 4 + 1]) > 0;
      d.flexGlow = num(f[i * 4 + 2]);
      d.extendGlow = num(f[i * 4 + 3]);
      d.lastPressAt = this.local(num(press[i], -1e9));
      d.extendStart = this.local(num(lift[i], 0));
      dyn[k] = d;
    });
    const active = typeof w.active === 'string' && (FINGER_ORDER as string[]).includes(w.active) ? (w.active as FingerName) : null;
    return {
      id: w.id === 'hand-left' ? 'hand-left' : 'hand-right',
      handedness: w.handedness === 'left' ? 'left' : 'right',
      score: num(w.score, 0.9),
      lm,
      dyn,
      activeFinger: active,
      activeAt: this.local(num(w.activeAt)),
      lastSeen: localNow,
      lastUpdate: localNow,
      handSize: num(w.size, 1),
      world: null,
    };
  }
}
