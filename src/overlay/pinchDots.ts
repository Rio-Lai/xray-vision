/**
 * The quiet on-screen cue for hand gestures (#121), pure DOM, updated every frame from gestureLive:
 *  - five small soft dots on each free hand (gestures.ts GestureMark), one on each fingertip: hollow
 *    and quiet while the hand is seen, filled for the fingers taking part in what it is doing (two-finger
 *    pan: index and middle; pinch and zoom: thumb and index; globe: all five; snap: thumb and middle);
 *    nothing for ignored hands (typing, resting, just come into view); they fade out when the hand
 *    leaves; one small word for what that hand is doing ("Rotating", "Panning", "Zooming",
 *    "Exploding", "Closing") under the point where it happens (the midpoint of those fingertips);
 *  - while a gesture is doing something, one word ("Turning", "Opening", "Closing", "Zooming",
 *    "Moving") just above the voice zone (the voice pill and its captions), never on top of them.
 * Normalised frame coords -> viewport through the cover map. Light per frame (nodes are reused and
 * stamped, ones not seen for a while are removed; a dot is moved only when it moved half a pixel or more).
 * Style: .bf-hand-mark, .bf-hand-tip, .bf-hand-label and .bf-cue-hint in src/hud/styles.ts (classic) and
 * src/hud/kit/hud.ts (kit).
 */
import type { GestureMark } from '../detect/gestures';
import type { CoverMap } from '../camera/frame';

interface MarkNode {
  el: HTMLDivElement;
  /** the five fingertip dots (thumb, index, middle, ring, pinky) and where each was put (px) */
  tips: HTMLDivElement[];
  tipX: Float32Array;
  tipY: Float32Array;
  /** FINGER_* bits drawn filled */
  fingers: number;
  /** the word, under the point where the gesture happens */
  label: HTMLDivElement;
  labelX: number;
  labelY: number;
  text: string;
  on: boolean;
  active: boolean;
  /** frame stamp when it was last in the marks */
  seen: number;
  /** when it went off (for removal once faded) */
  offAt: number;
}

/** The hint sits at least this far above the bottom (px): above the voice pill and two caption lines. */
const HINT_MIN_BOTTOM = 124;
/** ...and this far above the top of the voice zone when its captions are taller. */
const HINT_GAP = 10;
/** The voice zone is measured this often while the hint shows (ms). */
const MEASURE_MS = 250;
/** A marker that has been off this long is removed (ms). */
const REMOVE_MS = 1500;
/** Moves smaller than this (px) are not written (no style churn for a still hand). */
const MOVE_EPS = 0.5;

export class HandCueLayer {
  private readonly root: HTMLDivElement;
  private readonly nodes = new Map<string, MarkNode>();
  private readonly hint: HTMLDivElement;
  private hintText = '';
  private hintOn = false;
  private hintBottom = HINT_MIN_BOTTOM;
  private measuredAt = -1e9;
  private stamp = 0;
  private sweepNow = 0;
  /** Markers not in this frame's marks fade out (staying where they were), and go once faded. */
  private readonly sweep = (n: MarkNode, key: string): void => {
    if (n.seen === this.stamp) return;
    if (n.on) {
      n.on = false;
      n.offAt = this.sweepNow;
      n.el.classList.remove('on');
    } else if (this.sweepNow - n.offAt > REMOVE_MS) {
      n.el.remove();
      this.nodes.delete(key);
    }
  };

  constructor(host: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'bf-olayer';
    host.appendChild(this.root);
    this.hint = document.createElement('div');
    this.hint.className = 'bf-gesture-hint bf-cue-hint';
    this.hint.setAttribute('aria-hidden', 'true');
    this.hint.style.bottom = `${HINT_MIN_BOTTOM}px`;
    this.root.appendChild(this.hint);
  }

  update(marks: GestureMark[], hint: string | null, map: CoverMap, now: number): void {
    const stamp = ++this.stamp;
    for (const m of marks) {
      let n = this.nodes.get(m.key);
      if (!n) {
        const el = document.createElement('div');
        el.className = 'bf-hand-mark';
        el.setAttribute('aria-hidden', 'true');
        const tips: HTMLDivElement[] = [];
        for (let k = 0; k < 5; k++) {
          const d = document.createElement('div');
          d.className = 'bf-hand-tip';
          el.appendChild(d);
          tips.push(d);
        }
        const label = document.createElement('div');
        label.className = 'bf-hand-label';
        el.appendChild(label);
        this.root.appendChild(el);
        n = { el, tips, tipX: new Float32Array(5).fill(-1e6), tipY: new Float32Array(5).fill(-1e6), fingers: -1, label, labelX: -1e6, labelY: -1e6, text: '', on: false, active: false, seen: 0, offAt: 0 };
        this.nodes.set(m.key, n);
      }
      n.seen = stamp;
      // the fingertip dots, and the word under the point where the gesture happens (frame -> view as frameToView, inline)
      const sx = map.fw * map.scale;
      const sy = map.fh * map.scale;
      for (let k = 0; k < 5; k++) {
        const x = map.ox + m.tips[2 * k] * sx;
        const y = map.oy + m.tips[2 * k + 1] * sy;
        if (Math.abs(x - n.tipX[k]) >= MOVE_EPS || Math.abs(y - n.tipY[k]) >= MOVE_EPS) {
          n.tipX[k] = x;
          n.tipY[k] = y;
          n.tips[k].style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
        }
      }
      if (m.fingers !== n.fingers) {
        for (let k = 0; k < 5; k++) {
          const lit = (m.fingers & (1 << k)) !== 0;
          if (n.fingers < 0 || lit !== ((n.fingers & (1 << k)) !== 0)) n.tips[k].classList.toggle('on', lit);
        }
        n.fingers = m.fingers;
      }
      const lx = map.ox + m.x * sx;
      const ly = map.oy + m.y * sy;
      if (Math.abs(lx - n.labelX) >= MOVE_EPS || Math.abs(ly - n.labelY) >= MOVE_EPS) {
        n.labelX = lx;
        n.labelY = ly;
        n.label.style.transform = `translate(${lx.toFixed(1)}px, ${ly.toFixed(1)}px) translate(-50%, 0)`;
      }
      if (!n.on) {
        n.on = true;
        n.el.classList.add('on');
      }
      if (m.active !== n.active) {
        n.active = m.active;
        n.el.classList.toggle('active', m.active);
      }
      // (the last word stays in the node while it fades out, so it does not blink empty)
      if (m.label !== n.text) {
        if (m.label) n.label.textContent = m.label;
        n.text = m.label;
        n.label.classList.toggle('on', m.label !== '');
      }
    }
    this.sweepNow = now;
    this.nodes.forEach(this.sweep);

    // The one-word hint, above the voice zone.
    if (hint !== null && hint !== this.hintText) {
      this.hintText = hint;
      this.hint.textContent = hint;
    }
    const on = hint !== null;
    if (on !== this.hintOn) {
      this.hintOn = on;
      this.hint.classList.toggle('on', on);
    }
    if (on && now - this.measuredAt > MEASURE_MS) {
      this.measuredAt = now;
      const voice = document.querySelector('.bf-voice');
      const top = voice ? voice.getBoundingClientRect().top : Infinity;
      const bottom = Math.max(HINT_MIN_BOTTOM, Number.isFinite(top) ? Math.round(window.innerHeight - top + HINT_GAP) : 0);
      if (bottom !== this.hintBottom) {
        this.hintBottom = bottom;
        this.hint.style.bottom = `${bottom}px`;
      }
    }
  }

  dispose(): void {
    for (const n of this.nodes.values()) n.el.remove();
    this.nodes.clear();
    this.root.remove();
  }
}
