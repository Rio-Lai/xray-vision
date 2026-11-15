/**
 * The quiet on-screen cue for hand gestures (#121), pure DOM, updated every frame from gestureLive:
 *  - a small soft marker on each free hand (gestures.ts GestureMark), between its thumb and index
 *    fingertips (where a pinch happens; at the palm for a fist): a hollow ring while it is seen,
 *    filled as soon as a pinch counts and while it is doing something; nothing for ignored hands
 *    (typing, resting, just come into view); it fades out when the hand leaves; under it, one small
 *    word for what that hand is doing ("Rotating", "Panning", "Zooming", "Exploding", "Closing");
 *  - while a gesture is doing something, one word ("Turning", "Opening", "Closing", "Zooming",
 *    "Moving") just above the voice zone (the voice pill and its captions), never on top of them.
 * Normalised frame coords -> viewport through the cover map. Allocation-free per frame (nodes are
 * reused and stamped; ones not seen for a while are removed).
 * Style: .bf-hand-mark and .bf-cue-hint in src/hud/styles.ts (classic) and src/hud/kit/hud.ts (kit).
 */
import type { GestureMark } from '../detect/gestures';
import { frameToView } from '../camera/frame';
import type { CoverMap } from '../camera/frame';

interface MarkNode {
  el: HTMLDivElement;
  /** the word under the ring */
  label: HTMLDivElement;
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
        const label = document.createElement('div');
        label.className = 'bf-hand-label';
        label.setAttribute('aria-hidden', 'true');
        el.appendChild(label);
        this.root.appendChild(el);
        n = { el, label, text: '', on: false, active: false, seen: 0, offAt: 0 };
        this.nodes.set(m.key, n);
      }
      n.seen = stamp;
      const p = frameToView(map, m.x, m.y);
      n.el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
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
