/**
 * Part labels for the exploded view: one frosted-glass pill per part with a hairline leader to a
 * small dot on the part. Pills sit in two columns left and right of the exploded stack, keep
 * their side once shown, and are stacked so they never overlap each other or any element marked
 * `data-bf-avoid` (the part and step cards). Updated imperatively every frame (no React).
 * Also hosts the optional gaze dwell ring (off unless ?dwell=1).
 * Styles: .bf-plabel* in src/hud/styles.ts.
 */
export interface LabelItem {
  id: string;
  text: string;
  /** anchor point (part centre) in viewport px */
  ax: number;
  ay: number;
  /** 0..1 */
  opacity: number;
  highlighted: boolean;
}

export interface StackBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

type Side = 'left' | 'right';

interface LabelNode {
  tag: HTMLDivElement;
  line: SVGLineElement;
  dot: SVGCircleElement;
  text: string;
  hl: boolean | null;
  w: number;
  h: number;
  side: Side | null;
}

interface Placed {
  item: LabelItem;
  node: LabelNode;
  y: number;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const TOP_MARGIN = 70;
/** Bottom-centre space kept for the voice pill and captions (person2) and the status pill. */
const BOTTOM_MARGIN = 150;
const GAP = 8;
const SIDE_GAP = 28;
const EDGE = 12;
const RING_R = 30;
const ACCENT = '#4DA3FF';

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function avoidRects(): Rect[] {
  const out: Rect[] = [];
  const els = document.querySelectorAll<HTMLElement>('[data-bf-avoid]');
  els.forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) out.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
  });
  return out;
}

/** Stack labels in one column: as close to their anchors as possible, no overlaps, within [top, bottom]. */
export function stackColumn(list: { want: number; h: number }[], top: number, bottom: number, gap: number): number[] {
  const ys = list.map((l) => l.want);
  // Forward: push down below the previous one.
  let cursor = top;
  for (let i = 0; i < ys.length; i++) {
    ys[i] = Math.max(ys[i], cursor);
    cursor = ys[i] + list[i].h + gap;
  }
  // Backward: pull up above the next one / the bottom limit.
  let limit = bottom;
  for (let i = ys.length - 1; i >= 0; i--) {
    ys[i] = Math.min(ys[i], limit - list[i].h);
    limit = ys[i] - gap;
  }
  // If the column is too tall for the space, keep the top edge and accept running past the bottom.
  cursor = top;
  for (let i = 0; i < ys.length; i++) {
    ys[i] = Math.max(ys[i], cursor);
    cursor = ys[i] + list[i].h + gap;
  }
  return ys;
}

export class LabelLayer {
  private readonly root: HTMLDivElement;
  private readonly svg: SVGSVGElement;
  private readonly nodes = new Map<string, LabelNode>();
  private readonly ring: SVGCircleElement;
  private readonly ringTrack: SVGCircleElement;
  private readonly ringSvg: SVGSVGElement;

  constructor(host: HTMLDivElement) {
    this.root = document.createElement('div');
    this.root.className = 'bf-player';
    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.setAttribute('width', '100%');
    this.svg.setAttribute('height', '100%');
    Object.assign(this.svg.style, { position: 'absolute', inset: '0', overflow: 'visible' });
    this.root.appendChild(this.svg);

    this.ringSvg = document.createElementNS(SVG_NS, 'svg');
    this.ringSvg.setAttribute('width', String(RING_R * 2 + 8));
    this.ringSvg.setAttribute('height', String(RING_R * 2 + 8));
    Object.assign(this.ringSvg.style, {
      position: 'absolute',
      left: '50%',
      top: '50%',
      transform: 'translate(-50%, -50%) rotate(-90deg)',
      display: 'none',
    });
    const c = RING_R + 4;
    this.ringTrack = document.createElementNS(SVG_NS, 'circle');
    this.ring = document.createElementNS(SVG_NS, 'circle');
    for (const el of [this.ringTrack, this.ring]) {
      el.setAttribute('cx', String(c));
      el.setAttribute('cy', String(c));
      el.setAttribute('r', String(RING_R));
      el.setAttribute('fill', 'none');
      this.ringSvg.appendChild(el);
    }
    this.ringTrack.setAttribute('stroke', 'rgba(255,255,255,0.25)');
    this.ringTrack.setAttribute('stroke-width', '2');
    this.ring.setAttribute('stroke', ACCENT);
    this.ring.setAttribute('stroke-width', '3');
    this.ring.setAttribute('stroke-linecap', 'round');
    const circ = 2 * Math.PI * RING_R;
    this.ring.setAttribute('stroke-dasharray', String(circ));
    this.ring.setAttribute('stroke-dashoffset', String(circ));
    this.root.appendChild(this.ringSvg);
    host.appendChild(this.root);
  }

  /** progress 0..1, or null to hide */
  setDwell(progress: number | null): void {
    if (progress === null || progress <= 0) {
      this.ringSvg.style.display = 'none';
      return;
    }
    this.ringSvg.style.display = 'block';
    const circ = 2 * Math.PI * RING_R;
    this.ring.setAttribute('stroke-dashoffset', String(circ * (1 - Math.min(1, progress))));
  }

  private node(item: LabelItem): LabelNode {
    let n = this.nodes.get(item.id);
    if (!n) {
      const tag = document.createElement('div');
      tag.className = 'bf-pill bf-glass bf-plabel';
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('class', 'bf-plabel-line');
      const dot = document.createElementNS(SVG_NS, 'circle');
      dot.setAttribute('class', 'bf-plabel-dot');
      this.svg.appendChild(line);
      this.svg.appendChild(dot);
      this.root.appendChild(tag);
      n = { tag, line, dot, text: '', hl: null, w: 0, h: 0, side: null };
      this.nodes.set(item.id, n);
    }
    if (n.text !== item.text) {
      n.text = item.text;
      n.tag.textContent = item.text;
      n.w = 0;
    }
    if (n.hl !== item.highlighted) {
      n.hl = item.highlighted;
      n.tag.classList.toggle('hl', item.highlighted);
      n.line.classList.toggle('hl', item.highlighted);
      n.dot.classList.toggle('hl', item.highlighted);
      n.dot.setAttribute('r', item.highlighted ? '4.5' : '3');
      n.w = 0; // highlighted pills are slightly bigger: re-measure
    }
    if (n.w === 0) {
      n.tag.style.display = '';
      n.w = n.tag.offsetWidth || item.text.length * 9 + 30;
      n.h = n.tag.offsetHeight || 34;
    }
    return n;
  }

  update(items: LabelItem[], bounds: StackBounds, vw: number, vh: number): void {
    const visible = items.filter((i) => i.opacity > 0.02);
    const seen = new Set<string>();
    if (visible.length > 0) {
      const cx = (bounds.left + bounds.right) / 2;
      const span = Math.max(1, bounds.right - bounds.left);
      const entries = visible.map((item) => ({ item, node: this.node(item) }));
      // Sides: keep a label's side once it has one; otherwise its own side if clearly off-centre,
      // else whichever column has fewer labels (top to bottom).
      const count = { left: 0, right: 0 };
      for (const e of entries) if (e.node.side) count[e.node.side] += 1;
      const bySy = [...entries].sort((a, b) => a.item.ay - b.item.ay);
      for (const e of bySy) {
        if (e.node.side) continue;
        const off = (e.item.ax - cx) / span;
        const side: Side = off < -0.25 ? 'left' : off > 0.25 ? 'right' : count.left <= count.right ? 'left' : 'right';
        e.node.side = side;
        count[side] += 1;
      }

      const rects = avoidRects();
      for (const side of ['left', 'right'] as const) {
        const col = bySy.filter((e) => e.node.side === side);
        if (col.length === 0) continue;
        // Column x range, for the avoid test.
        const colLeft = side === 'left' ? 0 : bounds.right;
        const colRight = side === 'left' ? bounds.left : vw;
        let bottom = vh - BOTTOM_MARGIN;
        for (const r of rects) {
          if (r.right > colLeft && r.left < colRight && r.top > vh * 0.3) bottom = Math.min(bottom, r.top - GAP);
        }
        const ys = stackColumn(
          col.map((e) => ({ want: e.item.ay - e.node.h / 2, h: e.node.h })),
          TOP_MARGIN,
          Math.max(TOP_MARGIN + 40, bottom),
          GAP,
        );
        const placed: Placed[] = col.map((e, i) => ({ item: e.item, node: e.node, y: ys[i] }));
        for (const { item, node, y } of placed) {
          let x: number;
          if (side === 'left') x = Math.max(EDGE, Math.min(bounds.left - SIDE_GAP - node.w, item.ax - 48 - node.w));
          else x = Math.min(vw - node.w - EDGE, Math.max(bounds.right + SIDE_GAP, item.ax + 48));
          const op = item.opacity.toFixed(3);
          node.tag.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
          node.tag.style.opacity = op;
          node.tag.style.display = '';
          const lx = side === 'left' ? x + node.w : x;
          const ly = y + node.h / 2;
          node.line.setAttribute('x1', lx.toFixed(1));
          node.line.setAttribute('y1', ly.toFixed(1));
          node.line.setAttribute('x2', item.ax.toFixed(1));
          node.line.setAttribute('y2', item.ay.toFixed(1));
          node.line.setAttribute('opacity', op);
          node.dot.setAttribute('cx', item.ax.toFixed(1));
          node.dot.setAttribute('cy', item.ay.toFixed(1));
          node.dot.setAttribute('opacity', op);
          seen.add(item.id);
        }
      }
    }
    for (const [id, n] of this.nodes) {
      if (seen.has(id)) continue;
      n.side = null;
      n.tag.style.display = 'none';
      n.line.setAttribute('opacity', '0');
      n.dot.setAttribute('opacity', '0');
    }
  }

  /** Remove all tags (teardown changed). */
  clear(): void {
    for (const n of this.nodes.values()) {
      n.tag.remove();
      n.line.remove();
      n.dot.remove();
    }
    this.nodes.clear();
  }

  dispose(): void {
    this.clear();
    this.root.remove();
  }
}
