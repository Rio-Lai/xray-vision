/**
 * HTML label layer: one monospace tag per part with a thin leader line to the part,
 * laid out alternately left / right of the exploded stack, pushed apart vertically to avoid overlap.
 * Also hosts the gaze dwell ring. Updated imperatively every frame (no React re-renders).
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

interface LabelNode {
  tag: HTMLDivElement;
  line: SVGLineElement;
  dot: SVGCircleElement;
  text: string;
  hl: boolean;
  w: number;
  h: number;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const TOP_MARGIN = 70;
const BOTTOM_MARGIN = 140;
const GAP = 6;
const RING_R = 34;

export class LabelLayer {
  private readonly root: HTMLDivElement;
  private readonly svg: SVGSVGElement;
  private readonly nodes = new Map<string, LabelNode>();
  private readonly ring: SVGCircleElement;
  private readonly ringTrack: SVGCircleElement;
  private readonly ringSvg: SVGSVGElement;

  constructor(host: HTMLDivElement) {
    this.root = document.createElement('div');
    Object.assign(this.root.style, {
      position: 'absolute',
      inset: '0',
      pointerEvents: 'none',
      overflow: 'hidden',
    });
    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.setAttribute('width', '100%');
    this.svg.setAttribute('height', '100%');
    Object.assign(this.svg.style, { position: 'absolute', inset: '0' });
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
    this.ringTrack.setAttribute('stroke', 'rgba(125,227,255,0.25)');
    this.ringTrack.setAttribute('stroke-width', '2');
    this.ring.setAttribute('stroke', '#ffd27a');
    this.ring.setAttribute('stroke-width', '4');
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
      Object.assign(tag.style, {
        position: 'absolute',
        left: '0',
        top: '0',
        whiteSpace: 'nowrap',
        fontFamily: "'JetBrains Mono', 'SF Mono', ui-monospace, Menlo, monospace",
        letterSpacing: '0.04em',
        padding: '3px 8px',
        borderRadius: '3px',
        background: 'rgba(4,12,20,0.72)',
        willChange: 'transform, opacity',
      });
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('stroke-width', '1.2');
      const dot = document.createElementNS(SVG_NS, 'circle');
      dot.setAttribute('r', '3');
      this.svg.appendChild(line);
      this.svg.appendChild(dot);
      this.root.appendChild(tag);
      n = { tag, line, dot, text: '', hl: !item.highlighted, w: 0, h: 0 };
      this.nodes.set(item.id, n);
    }
    if (n.text !== item.text || n.hl !== item.highlighted) {
      n.text = item.text;
      n.hl = item.highlighted;
      n.tag.textContent = item.text;
      n.tag.style.fontSize = item.highlighted ? '19px' : '15px';
      n.tag.style.fontWeight = item.highlighted ? '700' : '500';
      n.tag.style.color = item.highlighted ? '#fff4d6' : '#bdefff';
      n.tag.style.border = item.highlighted ? '1.5px solid #ffd27a' : '1px solid rgba(125,227,255,0.55)';
      n.tag.style.boxShadow = item.highlighted ? '0 0 14px rgba(255,190,90,0.55)' : 'none';
      n.line.setAttribute('stroke', item.highlighted ? '#ffd27a' : 'rgba(125,227,255,0.7)');
      n.dot.setAttribute('fill', item.highlighted ? '#ffd27a' : '#7de3ff');
      n.w = 0; // re-measure
    }
    if (n.w === 0) {
      n.tag.style.display = 'block';
      n.w = n.tag.offsetWidth || item.text.length * 9 + 16;
      n.h = n.tag.offsetHeight || 24;
    }
    return n;
  }

  update(items: LabelItem[], bounds: StackBounds, vw: number, vh: number): void {
    const seen = new Set<string>();
    const visible = items.filter((i) => i.opacity > 0.02);
    const sorted = [...visible].sort((a, b) => a.ay - b.ay);
    const sides: { item: LabelItem; node: LabelNode; side: 'left' | 'right' }[] = sorted.map((item, i) => ({
      item,
      node: this.node(item),
      side: i % 2 === 0 ? 'left' : 'right',
    }));
    for (const side of ['left', 'right'] as const) {
      let cursor = TOP_MARGIN;
      const list = sides.filter((s) => s.side === side);
      for (const s of list) {
        const { item, node } = s;
        let y = Math.max(cursor, item.ay - node.h / 2);
        y = Math.min(y, vh - BOTTOM_MARGIN - node.h);
        y = Math.max(TOP_MARGIN, y);
        cursor = y + node.h + GAP;
        let x: number;
        if (side === 'left') x = Math.max(8, Math.min(bounds.left - 40 - node.w, item.ax - 60 - node.w));
        else x = Math.min(vw - node.w - 8, Math.max(bounds.right + 40, item.ax + 60));
        node.tag.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
        node.tag.style.opacity = item.opacity.toFixed(3);
        node.tag.style.display = 'block';
        const lx = side === 'left' ? x + node.w : x;
        const ly = y + node.h / 2;
        node.line.setAttribute('x1', lx.toFixed(1));
        node.line.setAttribute('y1', ly.toFixed(1));
        node.line.setAttribute('x2', item.ax.toFixed(1));
        node.line.setAttribute('y2', item.ay.toFixed(1));
        node.line.setAttribute('opacity', item.opacity.toFixed(3));
        node.dot.setAttribute('cx', item.ax.toFixed(1));
        node.dot.setAttribute('cy', item.ay.toFixed(1));
        node.dot.setAttribute('opacity', item.opacity.toFixed(3));
        seen.add(item.id);
      }
    }
    for (const [id, n] of this.nodes) {
      if (seen.has(id)) continue;
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
