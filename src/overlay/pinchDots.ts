/**
 * The one on-screen cue for hand gestures: a tiny soft white dot at each active pinch point,
 * fading in and out over ~140 ms. Nothing else is drawn for gestures. Pure DOM, updated every
 * frame from gestureLive (normalised frame coords -> viewport through the cover map).
 * Style: .bf-pinch in src/hud/styles.ts.
 */
import type { GestureDot } from '../detect/gestures';
import { frameToView } from '../camera/frame';
import type { CoverMap } from '../camera/frame';

interface DotNode {
  el: HTMLDivElement;
  on: boolean;
}

export class PinchDotLayer {
  private readonly root: HTMLDivElement;
  private readonly nodes = new Map<string, DotNode>();

  constructor(host: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'bf-olayer';
    host.appendChild(this.root);
  }

  update(dots: GestureDot[], map: CoverMap): void {
    const seen = new Set<string>();
    for (const d of dots) {
      let n = this.nodes.get(d.id);
      if (!n) {
        const el = document.createElement('div');
        el.className = 'bf-pinch';
        this.root.appendChild(el);
        n = { el, on: false };
        this.nodes.set(d.id, n);
      }
      const p = frameToView(map, d.x, d.y);
      n.el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
      if (!n.on) {
        n.on = true;
        n.el.classList.add('on');
      }
      seen.add(d.id);
    }
    for (const [id, n] of this.nodes) {
      if (seen.has(id) || !n.on) continue;
      n.on = false;
      n.el.classList.remove('on'); // stays where it was while it fades out
    }
  }

  dispose(): void {
    for (const n of this.nodes.values()) n.el.remove();
    this.nodes.clear();
    this.root.remove();
  }
}
