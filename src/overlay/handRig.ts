/**
 * Hand anchor (biology): an anatomical overlay rebuilt every frame from the tracked hand's
 * landmarks (viewport px). Layers lift apart up-left with explodeAmount; pressing fingers glow warm
 * orange (#FF9F45) on their flexor tendon + FDS/FDP (thumb: FPL + thenar); quick extensions glow
 * extensor-digitorum.
 * Look (PROJECT.md section 2): soft, semi-transparent shapes with feathered edges (see ribbon.ts),
 * mostly white with a hint of each tissue's colour, so the real hand stays visible underneath;
 * the part the tutor talks about turns accent blue. Nothing pulses.
 *
 * The rig's root is flipped (scale y = -1) so local coordinates ARE viewport pixels (y down).
 */
import * as THREE from 'three';
import type { Teardown } from '../../shared/teardown';
import type { FingerName } from '../state/store';
import type { TrackedHand } from '../detect/handTracker';
import { FINGERS, FINGER_CHAINS } from '../detect/handTracker';
import { frameToView } from '../camera/frame';
import type { CoverMap } from '../camera/frame';
import { ExplodeAnimator, smoothstep } from './explodeAnimator';
import { Ribbon, bone, spindle } from './ribbon';
import type { Path, V2 } from './ribbon';
import type { LabelItem, StackBounds } from './labels';

export const HAND_PART_IDS = [
  'skin',
  'extensor-digitorum',
  'bones',
  'interossei',
  'lumbricals',
  'fdp',
  'fpl',
  'flexor-tendons',
  'fds',
  'thenar',
  'hypothenar',
] as const;
export type HandPartId = (typeof HAND_PART_IDS)[number];

const DEFAULTS: Record<HandPartId, { layer: number; color: string; name: string; ribbons: number; fill: number }> = {
  skin: { layer: 0, color: '#e8b89a', name: 'Skin', ribbons: 1, fill: 0.55 },
  'extensor-digitorum': { layer: 1, color: '#d96c5f', name: 'Extensor digitorum', ribbons: 5, fill: 0.42 },
  bones: { layer: 2, color: '#efe6cf', name: 'Bones', ribbons: 1, fill: 0.6 },
  interossei: { layer: 2, color: '#c0504d', name: 'Interossei', ribbons: 1, fill: 0.38 },
  lumbricals: { layer: 3, color: '#e07b67', name: 'Lumbricals', ribbons: 4, fill: 0.42 },
  fdp: { layer: 3, color: '#a93226', name: 'FDP', ribbons: 1, fill: 0.34 },
  fpl: { layer: 3, color: '#b03a2e', name: 'FPL', ribbons: 1, fill: 0.36 },
  'flexor-tendons': { layer: 4, color: '#f2efe6', name: 'Flexor tendons', ribbons: 5, fill: 0.6 },
  fds: { layer: 4, color: '#c0392b', name: 'FDS', ribbons: 1, fill: 0.34 },
  thenar: { layer: 5, color: '#cd6155', name: 'Thenar muscles', ribbons: 1, fill: 0.34 },
  hypothenar: { layer: 5, color: '#d98880', name: 'Hypothenar muscles', ribbons: 1, fill: 0.34 },
};

/** Parts shown (faintly) in the biology lens before anything is exploded, so tracking is visible. */
const PREVIEW_PARTS = new Set<HandPartId>(['bones', 'flexor-tendons', 'extensor-digitorum']);

const UP_LEFT = { x: -0.48, y: -0.88 };
const WHITE = new THREE.Color('#ffffff');
const ACCENT = new THREE.Color('#4DA3FF');
/** How much of a tissue's own colour tints the soft white shapes. */
const TISSUE_TINT = 0.35;

function tissueColor(css: string): THREE.Color {
  return WHITE.clone().lerp(new THREE.Color(css), TISSUE_TINT);
}

interface PartRig {
  id: HandPartId;
  name: string;
  layer: number;
  base: THREE.Color;
  fill: number;
  group: THREE.Group;
  ribbons: Ribbon[];
  inTeardown: boolean;
  hl: number;
  dim: number;
  /** scratch colour: base tinted towards the accent when highlighted */
  shown: THREE.Color;
}

interface Glow {
  flex: Record<FingerName, number>;
  ext: Record<FingerName, number>;
}

interface Geo {
  paths: Path[][];
  anchor: V2;
}

export interface HandFrameInput {
  now: number;
  dt: number;
  vw: number;
  vh: number;
  map: CoverMap;
  hands: TrackedHand[];
  preferredId: string | null;
  /** hand-anchor teardown, or null for the preview skeleton */
  teardown: Teardown | null;
  preview: boolean;
  explodeTarget: number;
  highlighted: Set<string>;
}

// ---------- small vector helpers ----------
const add = (a: V2, b: V2): V2 => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: V2, b: V2): V2 => ({ x: a.x - b.x, y: a.y - b.y });
const mul = (a: V2, s: number): V2 => ({ x: a.x * s, y: a.y * s });
const lerp = (a: V2, b: V2, t: number): V2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const len = (a: V2): number => Math.hypot(a.x, a.y);
const norm = (a: V2): V2 => {
  const l = len(a) || 1;
  return { x: a.x / l, y: a.y / l };
};
const avg = (pts: V2[]): V2 => {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
  }
  return { x: x / pts.length, y: y / pts.length };
};

function convexHull(points: V2[]): V2[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const cross = (o: V2, a: V2, b: V2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: V2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: V2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** All part geometry for one hand, in viewport px. */
function buildGeometry(P: V2[]): Record<HandPartId, Geo> {
  const Wr = P[0];
  const hs = Math.max(12, len(sub(P[9], P[0])));
  const handLen = hs * 1.9;
  const L = 0.6 * handLen;
  const fdir = norm(sub(P[0], P[9])); // toward the forearm
  let perp: V2 = { x: -fdir.y, y: fdir.x };
  if (perp.x * (P[2].x - P[0].x) + perp.y * (P[2].y - P[0].y) < 0) perp = mul(perp, -1); // thumb side
  const F = (t: number, side: number): V2 => ({
    x: Wr.x + fdir.x * t + perp.x * side,
    y: Wr.y + fdir.y * t + perp.y * side,
  });
  const C = lerp(P[0], P[9], 0.12); // carpal tunnel
  const palmC = avg([P[0], P[5], P[9], P[13], P[17]]);
  const dorsal = { x: -0.035 * hs, y: -0.05 * hs }; // fake depth: toward the viewer
  const palmar = { x: 0.03 * hs, y: 0.04 * hs };
  const shift = (pts: V2[], o: V2): V2[] => pts.map((p) => add(p, o));
  const shiftPath = (p: Path, o: V2): Path => ({ ...p, pts: shift(p.pts, o) });
  const tendonW = Math.max(3, 0.04 * hs);

  // Flexor tendons: tip -> along the finger -> carpal tunnel -> forearm.
  const flexor: Path[][] = FINGERS.map((f, k) => {
    const [a, b, c, d] = FINGER_CHAINS[f];
    let pts: V2[];
    if (f === 'thumb') {
      pts = [P[d], P[c], P[b], P[a], lerp(P[a], C, 0.6), add(C, mul(perp, 0.07 * hs)), F(L * 0.85, 0.3 * hs)];
    } else {
      const side = (2.5 - k) * 0.035 * hs;
      pts = [P[d], P[c], P[b], P[a], lerp(P[a], C, 0.6), add(C, mul(perp, side)), F(L, (2.5 - k) * 0.06 * hs)];
    }
    return [{ pts: shift(pts, palmar), widths: tendonW }];
  });

  const fds = spindle(F(0.1 * L, 0.04 * hs), F(L, 0.04 * hs), 0.3 * hs);
  const fdp = spindle(F(0.16 * L, -0.2 * hs), F(0.95 * L, -0.2 * hs), 0.26 * hs);
  const fpl = spindle(F(0.25 * L, 0.32 * hs), F(0.85 * L, 0.32 * hs), 0.14 * hs);

  const extBelly = shiftPath(spindle(F(0.06 * L, -0.06 * hs), F(0.95 * L, -0.06 * hs), 0.3 * hs), dorsal);
  const extSlips: Path[][] = (['index', 'middle', 'ring', 'pinky'] as FingerName[]).map((f, i) => {
    const [a, b, c, d] = FINGER_CHAINS[f];
    const pts = [P[d], P[c], P[b], P[a], lerp(P[a], Wr, 0.75), F(0.06 * L, -0.06 * hs + (1.5 - i) * 0.04 * hs)];
    return [{ pts: shift(pts, dorsal), widths: Math.max(2.5, 0.032 * hs) }];
  });

  const boneW = Math.max(4, 0.085 * hs);
  const bones: Path[] = [];
  bones.push(bone(lerp(Wr, P[1], 0.35), P[1], boneW), bone(P[1], P[2], boneW), bone(P[2], P[3], boneW), bone(P[3], P[4], boneW));
  for (const f of ['index', 'middle', 'ring', 'pinky'] as FingerName[]) {
    const [a, b, c, d] = FINGER_CHAINS[f];
    bones.push(bone(lerp(Wr, P[a], 0.2), P[a], boneW * 1.05), bone(P[a], P[b], boneW), bone(P[b], P[c], boneW * 0.9), bone(P[c], P[d], boneW * 0.8));
  }
  bones.push(bone(F(0.04 * L, 0.16 * hs), F(L, 0.2 * hs), boneW * 1.4)); // radius
  bones.push(bone(F(0.04 * L, -0.18 * hs), F(L, -0.16 * hs), boneW * 1.3)); // ulna

  const inter: Path[] = [];
  const pairs: [number, number][] = [
    [5, 9],
    [9, 13],
    [13, 17],
  ];
  for (const [a, b] of pairs) {
    const start = avg([lerp(Wr, P[a], 0.3), lerp(Wr, P[b], 0.3)]);
    const end = lerp(start, avg([P[a], P[b]]), 0.92);
    inter.push(spindle(start, end, 0.1 * hs, 9));
  }
  inter.push(spindle(lerp(P[1], P[5], 0.45), lerp(P[2], P[5], 0.55), 0.13 * hs, 9));

  const lumb: Path[][] = (['index', 'middle', 'ring', 'pinky'] as FingerName[]).map((f) => {
    const m = P[FINGER_CHAINS[f][0]];
    const o = add(palmar, mul(perp, 0.045 * hs));
    return [shiftPath(spindle(lerp(C, m, 0.4), lerp(C, m, 0.93), 0.075 * hs, 9), o)];
  });

  const thenar = shiftPath(spindle(lerp(P[1], palmC, 0.2), lerp(P[2], palmC, 0.35), 0.42 * hs), palmar);
  const hypo = shiftPath(
    spindle(sub(lerp(Wr, P[17], 0.2), mul(perp, 0.12 * hs)), sub(lerp(Wr, P[17], 0.85), mul(perp, 0.08 * hs)), 0.3 * hs),
    palmar,
  );

  const hullSrc = P.concat([F(0.35 * L, 0.3 * hs), F(0.35 * L, -0.3 * hs)]);
  const hull = convexHull(hullSrc);
  const hc = avg(hull);
  const skinPts = hull.map((p) => {
    const d = sub(p, hc);
    return add(add(hc, mul(d, 1.06)), mul(norm(d), 0.06 * hs));
  });
  const skinPath: Path = { pts: shift(skinPts, mul(dorsal, 1.4)), widths: Math.max(2.5, 0.025 * hs), closed: true };

  const mid = (p: Path): V2 => p.pts[Math.floor(p.pts.length / 2)];
  return {
    skin: { paths: [[skinPath]], anchor: add(sub(lerp(P[17], P[18], 0.5), mul(perp, 0.2 * hs)), dorsal) },
    'extensor-digitorum': { paths: [[extBelly], ...extSlips], anchor: mid(extBelly) },
    bones: { paths: [bones], anchor: lerp(P[6], P[7], 0.5) },
    interossei: { paths: [inter], anchor: mid(inter[0]) },
    lumbricals: { paths: lumb, anchor: mid(lumb[0][0]) },
    fdp: { paths: [[fdp]], anchor: mid(fdp) },
    fpl: { paths: [[fpl]], anchor: mid(fpl) },
    'flexor-tendons': { paths: flexor, anchor: add(C, palmar) },
    fds: { paths: [[fds]], anchor: mid(fds) },
    thenar: { paths: [[thenar]], anchor: mid(thenar) },
    hypothenar: { paths: [[hypo]], anchor: mid(hypo) },
  };
}

function glowFor(id: HandPartId, i: number, g: Glow): number {
  const fingersMax = (r: Record<FingerName, number>) => Math.max(r.index, r.middle, r.ring, r.pinky);
  switch (id) {
    case 'flexor-tendons':
      return g.flex[FINGERS[i]] ?? 0;
    case 'fds':
    case 'fdp':
      return fingersMax(g.flex);
    case 'fpl':
    case 'thenar':
      return g.flex.thumb;
    case 'extensor-digitorum':
      return i === 0 ? fingersMax(g.ext) : g.ext[FINGERS[i]] ?? 0;
    case 'lumbricals':
      return 0.6 * (g.flex[FINGERS[i + 1]] ?? 0);
    default:
      return 0;
  }
}

function zeroGlow(): Glow {
  return {
    flex: { thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0 },
    ext: { thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0 },
  };
}

export class HandRig {
  readonly root = new THREE.Group();
  private parts: PartRig[] = [];
  private anim = new ExplodeAnimator();
  private teardownKey: string | null = null;
  private lastLm: { x: number; y: number }[] | null = null;
  private lastId: string | null = null;
  private lostFor = 0;
  private presence = 0;
  private glow: Glow = zeroGlow();
  private labelAnchors = new Map<HandPartId, V2>();

  constructor(scene: THREE.Scene) {
    for (const id of HAND_PART_IDS) {
      const d = DEFAULTS[id];
      const group = new THREE.Group();
      const ribbons: Ribbon[] = [];
      for (let i = 0; i < d.ribbons; i++) {
        const r = new Ribbon(id === 'bones' ? 600 : 160);
        ribbons.push(r);
        group.add(r.group);
      }
      this.root.add(group);
      this.parts.push({
        id,
        name: d.name,
        layer: d.layer,
        base: tissueColor(d.color),
        fill: d.fill,
        group,
        ribbons,
        inTeardown: false,
        hl: 0,
        dim: 0,
        shown: new THREE.Color(),
      });
    }
    this.anim.setLayers(this.parts.map((p) => p.layer));
    this.root.visible = false;
    scene.add(this.root);
  }

  private applyTeardown(td: Teardown | null): void {
    const key = td ? td.object_id + '|' + td.parts.map((p) => `${p.id}:${p.layer}:${p.color}`).join(',') : null;
    if (key === this.teardownKey) return;
    this.teardownKey = key;
    for (const rig of this.parts) {
      const d = DEFAULTS[rig.id];
      const tp = td?.parts.find((p) => p.id === rig.id);
      rig.inTeardown = !!tp;
      rig.name = tp?.name ?? d.name;
      rig.layer = tp?.layer ?? d.layer;
      let color = d.color;
      if (tp && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(tp.color.trim())) color = tp.color.trim();
      rig.base = tissueColor(color);
    }
    this.anim.setLayers(this.parts.map((p) => p.layer));
  }

  /** Nearest part label anchor within `radius` px of (x, y), for clicks and gaze dwell. */
  pickAt(x: number, y: number, radius: number): string | null {
    if (!this.root.visible || this.anim.max() < 0.3) return null;
    let best: string | null = null;
    let bestD = radius;
    for (const rig of this.parts) {
      if (!rig.inTeardown) continue;
      const a = this.labelAnchors.get(rig.id);
      if (!a) continue;
      const d = Math.hypot(a.x - x, a.y - y);
      if (d < bestD) {
        bestD = d;
        best = rig.id;
      }
    }
    return best;
  }

  explodeLevel(): number {
    return this.anim.max();
  }

  update(input: HandFrameInput): { labels: LabelItem[]; bounds: StackBounds } | null {
    const { now, dt, vw, vh, map } = input;
    const empty = null;
    const active = !!input.teardown || input.preview;
    this.applyTeardown(input.teardown);
    this.anim.update(now, dt, input.teardown ? input.explodeTarget : 0);

    // Pick the hand: preferred id, then the one we followed last, then any.
    const hand =
      input.hands.find((h) => h.id === input.preferredId) ??
      (this.lastId ? input.hands.find((h) => h.id === this.lastId) : undefined) ??
      input.hands[0];
    const decay = Math.exp(-dt / 0.35);
    if (hand) {
      this.lastId = hand.id;
      this.lastLm = hand.lm.map((p) => ({ x: p.x, y: p.y }));
      this.lostFor = 0;
      for (const f of FINGERS) {
        this.glow.flex[f] = hand.dyn[f].flexGlow;
        this.glow.ext[f] = hand.dyn[f].extendGlow;
      }
    } else {
      this.lostFor += dt;
      for (const f of FINGERS) {
        this.glow.flex[f] *= decay;
        this.glow.ext[f] *= decay;
      }
    }
    const presTarget = !active || !this.lastLm ? 0 : this.lostFor < 1 ? 1 : Math.max(0, 1 - (this.lostFor - 1) / 0.4);
    this.presence += (presTarget - this.presence) * (1 - Math.exp(-dt * 10));
    if (!this.lastLm || this.presence < 0.004) {
      this.root.visible = false;
      this.labelAnchors.clear();
      return empty;
    }
    this.root.visible = true;
    this.root.position.set(-vw / 2, vh / 2, 0);
    this.root.scale.set(1, -1, 1);

    const P: V2[] = this.lastLm.map((p) => frameToView(map, p.x, p.y));
    const geo = buildGeometry(P);
    const hs = Math.max(12, len(sub(P[9], P[0])));
    const lift = 0.9 * hs * 1.9;
    const anyHl = input.highlighted.size > 0;
    const kHl = 1 - Math.exp(-dt * 10);
    const labels: LabelItem[] = [];
    this.labelAnchors.clear();

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of P) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }

    for (const rig of this.parts) {
      const shown = input.teardown ? rig.inTeardown : PREVIEW_PARTS.has(rig.id);
      if (!shown) {
        rig.group.visible = false;
        continue;
      }
      rig.group.visible = true;
      const e = this.anim.get(rig.layer);
      const t = this.anim.outerness(rig.layer);
      const off = { x: UP_LEFT.x * lift * t * e, y: UP_LEFT.y * lift * t * e };
      rig.group.position.set(off.x, off.y, 0);

      const isHl = input.highlighted.has(rig.id);
      rig.hl += ((isHl ? 1 : 0) - rig.hl) * kHl;
      rig.dim += ((anyHl && !isHl ? 1 : 0) - rig.dim) * kHl;
      const base = input.teardown ? rig.fill : rig.fill * 0.6;
      const opacity = this.presence * (base + rig.hl * 0.35) * (1 - 0.7 * rig.dim);
      rig.shown.copy(rig.base).lerp(ACCENT, 0.6 * rig.hl);
      const order = 100 + (this.anim.layerCount - this.anim.rankOf(rig.layer)) * 3;
      const g = geo[rig.id];
      rig.ribbons.forEach((rb, i) => {
        const paths = g.paths[i] ?? [];
        const glow = glowFor(rig.id, i, this.glow) * this.presence;
        rb.setPaths(paths, glow);
        rb.setStyle(rig.shown, opacity, glow, order);
      });

      const anchor = add(g.anchor, off);
      this.labelAnchors.set(rig.id, anchor);
      minX = Math.min(minX, anchor.x);
      maxX = Math.max(maxX, anchor.x);
      minY = Math.min(minY, anchor.y);
      maxY = Math.max(maxY, anchor.y);
      if (input.teardown) {
        labels.push({
          id: rig.id,
          text: rig.name,
          ax: anchor.x,
          ay: anchor.y,
          opacity: this.presence * smoothstep(0.35, 0.8, e) * (rig.dim > 0.5 ? 0.55 : 1),
          highlighted: rig.hl > 0.5,
        });
      }
    }
    return { labels, bounds: { left: minX, right: maxX, top: minY, bottom: maxY } };
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const rig of this.parts) for (const r of rig.ribbons) r.dispose();
    this.parts = [];
  }
}
