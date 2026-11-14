/**
 * Object labels for the live view ("Hey Blowfish, overlay on"): one small frosted-glass pill per
 * recognised thing, joined by a short hairline to a dot on the object, plus a soft glow on the
 * focused thing ("this"). Updated imperatively every frame from detect/live (no React re-renders).
 *
 *  - a label appears only after its object has been tracked for STABLE_MS (no flicker on false hits)
 *  - at most MAX_LABELS at once: the focused thing first, then the largest / most central
 *  - a pill that would overlap another pill or dot goes below its dot, or further out on a longer hairline
 *  - fade and scale in over ~250 ms (CSS), staggered when the overlay is switched on
 *
 * Pure DOM: works even if WebGL is unavailable. Styles: .bf-olabel* in src/hud/styles.ts.
 */
import type { SceneObject } from '../state/store';
import { boxToView } from '../camera/frame';
import type { CoverMap } from '../camera/frame';
import { displayName } from '../hud/names';

const STABLE_MS = 500;
const MAX_LABELS = 6;
const STAGGER_MS = 90;
const STEM_PX = 16;
const DOT_GAP_PX = 4;
const LIFT_STEP_GAP = 8;
const REMOVE_AFTER_MS = 400;
const EDGE_PX = 10;

export interface ObjectLabelInput {
  now: number;
  dt: number;
  vw: number;
  vh: number;
  map: CoverMap;
  /** live tracked things (boxes every frame) */
  objects: SceneObject[];
  /** names patched onto store objects by /api/identify, by id */
  names: Map<string, string | undefined>;
  focusedId: string | null;
  /** ids allowed to show; null = all */
  only: Set<string> | null;
  /** false hides everything (overlay off, or something is exploded) */
  visible: boolean;
}

interface LabelNode {
  root: HTMLDivElement;
  inner: HTMLDivElement;
  stem: HTMLElement;
  pill: HTMLDivElement;
  text: string;
  w: number;
  h: number;
  x: number;
  y: number;
  lift: number;
  /** 1 = pill above the dot, -1 = below */
  dir: 1 | -1;
  shiftX: number;
  placed: boolean;
  firstSeen: number;
  lastSeen: number;
  shown: boolean;
  focus: boolean;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

export class ObjectLabelLayer {
  private readonly root: HTMLDivElement;
  private readonly glow: HTMLDivElement;
  private readonly nodes = new Map<string, LabelNode>();
  private visibleSince = -1;
  private glowBox: Rect | null = null;
  private glowOn = false;

  constructor(host: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'bf-olayer';
    this.glow = document.createElement('div');
    this.glow.className = 'bf-focusglow';
    this.root.appendChild(this.glow);
    host.appendChild(this.root);
  }

  private node(id: string, now: number): LabelNode {
    let n = this.nodes.get(id);
    if (n) return n;
    const root = document.createElement('div');
    root.className = 'bf-olabel';
    const inner = document.createElement('div');
    inner.className = 'bf-olabel-in';
    const dot = document.createElement('i');
    dot.className = 'bf-olabel-dot';
    const stem = document.createElement('i');
    stem.className = 'bf-olabel-stem';
    const pill = document.createElement('div');
    pill.className = 'bf-pill bf-glass bf-olabel-pill';
    inner.append(stem, dot, pill);
    root.appendChild(inner);
    this.root.appendChild(root);
    n = {
      root,
      inner,
      stem,
      pill,
      text: '',
      w: 0,
      h: 0,
      x: 0,
      y: 0,
      lift: 0,
      dir: 1,
      shiftX: 0,
      placed: false,
      firstSeen: now,
      lastSeen: now,
      shown: false,
      focus: false,
    };
    this.nodes.set(id, n);
    return n;
  }

  update(input: ObjectLabelInput): void {
    const { now, dt, vw, vh, map } = input;
    if (input.visible && this.visibleSince < 0) this.visibleSince = now;
    if (!input.visible) this.visibleSince = -1;
    const k = 1 - Math.exp(-dt * 16);

    // 1. Track every object (also while hidden, so stable ones appear at once when switched on).
    const candidates: { id: string; o: SceneObject; n: LabelNode; score: number; box: Rect }[] = [];
    for (const o of input.objects) {
      const n = this.node(o.id, now);
      n.lastSeen = now;
      const b = boxToView(map, o.box);
      const tx = b.x + b.w / 2;
      const ty = b.y + b.h / 2;
      if (!n.placed) {
        n.x = tx;
        n.y = ty;
        n.placed = true;
      } else {
        n.x += (tx - n.x) * k;
        n.y += (ty - n.y) * k;
      }
      const text = displayName({ id: o.id, label: o.label, name: o.name ?? input.names.get(o.id), anchor: o.anchor });
      if (text !== n.text) {
        n.text = text;
        n.pill.textContent = text;
        n.w = 0;
      }
      if (n.w === 0) {
        n.w = n.pill.offsetWidth || text.length * 9 + 30;
        n.h = n.pill.offsetHeight || 34;
      }
      const dist = Math.hypot(tx - vw / 2, ty - vh / 2) / Math.hypot(vw / 2, vh / 2);
      const size = Math.sqrt(Math.max(1, b.w * b.h)) / Math.max(1, Math.min(vw, vh));
      const focused = o.id === input.focusedId;
      const score = (focused ? 10 : 0) + size * 1.2 + (1 - Math.min(1, dist));
      const eligible =
        input.visible && now - n.firstSeen >= STABLE_MS && (input.only === null || input.only.has(o.id));
      if (eligible) candidates.push({ id: o.id, o, n, score, box: b });
    }

    // 2. Pick and place: focused first, then largest / most central; lift pills that would overlap.
    candidates.sort((a, b) => b.score - a.score);
    const chosen = candidates.slice(0, MAX_LABELS);
    // Every chosen label's dot is an obstacle too, so a pill never covers another object's dot.
    const placed: Rect[] = chosen.map((c) => ({ x: c.n.x - 7, y: c.n.y - 7, w: 14, h: 14 }));
    const shownIds = new Set<string>();
    chosen.forEach((c, rank) => {
      const n = c.n;
      const staggerOk = now - this.visibleSince >= rank * STAGGER_MS;
      if (!staggerOk) return;
      shownIds.add(c.id);
      const half = n.w / 2;
      const shiftX = Math.min(vw - EDGE_PX - half, Math.max(EDGE_PX + half, n.x)) - n.x;
      const rectFor = (dir: 1 | -1, lift: number): Rect => {
        const top = dir === 1 ? n.y - STEM_PX - DOT_GAP_PX - n.h - lift : n.y + STEM_PX + DOT_GAP_PX + lift;
        return { x: n.x + shiftX - half - 4, y: top - 3, w: n.w + 8, h: n.h + 6 };
      };
      const fits = (r: Rect) => r.y >= EDGE_PX && r.y + r.h <= vh - EDGE_PX && !placed.some((p) => overlaps(p, r));
      // Try: above, below, then further out on a longer hairline (above first).
      let dir: 1 | -1 = 1;
      let lift = 0;
      const step = n.h + LIFT_STEP_GAP;
      const tries: [1 | -1, number][] = [[1, 0], [-1, 0], [1, step], [-1, step], [1, 2 * step], [-1, 2 * step]];
      for (const [d, l] of tries) {
        if (fits(rectFor(d, l))) {
          dir = d;
          lift = l;
          break;
        }
      }
      placed.push(rectFor(dir, lift));
      const snap = !n.shown || dir !== n.dir;
      n.dir = dir;
      n.lift += (lift - n.lift) * (snap ? 1 : k);
      n.shiftX += (shiftX - n.shiftX) * (n.shown ? k : 1);
    });

    // 3. Write styles; drop nodes whose object is gone.
    for (const [id, n] of this.nodes) {
      const show = shownIds.has(id);
      const focus = show && id === input.focusedId;
      if (show !== n.shown) {
        n.shown = show;
        n.inner.classList.toggle('on', show);
      }
      if (focus !== n.focus) {
        n.focus = focus;
        n.pill.classList.toggle('bf-pill--focus', focus);
        n.inner.classList.toggle('focus', focus);
        n.w = 0; // the focus pill is bolder: re-measure next frame
      }
      n.root.style.transform = `translate(${n.x.toFixed(1)}px, ${n.y.toFixed(1)}px)`;
      const below = n.dir === -1;
      n.inner.classList.toggle('below', below);
      n.stem.style.height = `${(STEM_PX + n.lift).toFixed(1)}px`;
      const offset = `${(STEM_PX + DOT_GAP_PX + n.lift).toFixed(1)}px`;
      n.pill.style.bottom = below ? 'auto' : offset;
      n.pill.style.top = below ? offset : 'auto';
      n.pill.style.transform = `translateX(calc(-50% + ${n.shiftX.toFixed(1)}px))`;
      if (now - n.lastSeen > REMOVE_AFTER_MS) {
        n.root.remove();
        this.nodes.delete(id);
      }
    }

    // 4. Soft glow on the focused thing.
    const fc = input.focusedId ? chosen.find((c) => c.id === input.focusedId && shownIds.has(c.id)) : undefined;
    if (fc) {
      const t = fc.box;
      if (!this.glowBox || !this.glowOn) this.glowBox = { ...t };
      else {
        const g = this.glowBox;
        g.x += (t.x - g.x) * k;
        g.y += (t.y - g.y) * k;
        g.w += (t.w - g.w) * k;
        g.h += (t.h - g.h) * k;
      }
      const g = this.glowBox;
      this.glow.style.transform = `translate(${g.x.toFixed(1)}px, ${g.y.toFixed(1)}px)`;
      this.glow.style.width = `${Math.max(8, g.w).toFixed(1)}px`;
      this.glow.style.height = `${Math.max(8, g.h).toFixed(1)}px`;
    }
    const glowOn = !!fc;
    if (glowOn !== this.glowOn) {
      this.glowOn = glowOn;
      this.glow.classList.toggle('on', glowOn);
    }
  }

  dispose(): void {
    for (const n of this.nodes.values()) n.root.remove();
    this.nodes.clear();
    this.root.remove();
  }
}
