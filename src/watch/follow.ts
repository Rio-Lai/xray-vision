/**
 * Watch side of the big-screen view (`?watch=1`): follows the phone's snapshots over Server-Sent Events
 * (GET /api/watch/events) and applies each one at once to the store, `live`, the gesture cue, the HUD's
 * busy text, the saved row and the frame size (./snapshot.ts SnapshotApplier). Nothing here calls an API
 * that spends credit or saves anything: it only writes local state that the overlay and the HUD read.
 * `useWatch` says whether the phone is there ("waiting" before the first snapshot, "lost" after LOST_MS
 * without one) and when the MJPEG <img> should reconnect (`streamKey`).
 * EventSource reconnects by itself; a refused connection (a 401 or 404) is retried every RETRY_MS.
 */
import { create } from 'zustand';
import { useStore } from '../state/store';
import type { AppState } from '../state/store';
import { frame } from '../camera/frame';
import { live } from '../detect/live';
import { gestureLive } from '../detect/gestureDriver';
import type { GestureHint } from '../detect/gestureDriver';
import type { GestureOutput } from '../detect/gestures';
import { setBusyText } from '../hud/hudStore';
import { useSaved } from '../lib/saved';
import { modelControl } from '../stage/modelControl';
import { SnapshotApplier, isSnapshot } from './snapshot';
import type { ApplyTarget } from './snapshot';

export const LOST_MS = 3000;
const RETRY_MS = 2000;

export type WatchLink = 'waiting' | 'live' | 'lost';

export interface WatchUi {
  link: WatchLink;
  /** the phone's camera frame size (the background's cover map) */
  fw: number;
  fh: number;
  /** bumped to reconnect the MJPEG stream */
  streamKey: number;
  /** push-to-talk on the phone: the voice pill says "Hold to talk" */
  micHold: boolean;
}

export const useWatch = create<WatchUi>(() => ({ link: 'waiting', fw: 1280, fh: 720, streamKey: 0, micHold: false }));

export function reconnectStream(): void {
  useWatch.setState((s) => ({ streamKey: s.streamKey + 1 }));
}

/** A gesture output for the hand markers only (the overlay reads gestureLive.out.marks); nothing else in it moves. */
const markOut: GestureOutput = {
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
  snap: false,
  snapKey: '',
  events: [],
  marks: [],
  hands: [],
};

const target: ApplyTarget = {
  getState: () => useStore.getState() as unknown as Record<string, unknown>,
  setState: (patch) => useStore.setState(patch as Partial<AppState>),
  setLive: (objects, hands) => {
    live.objects = objects;
    live.hands = hands;
  },
  setGesture: (marks, hint) => {
    markOut.marks = marks;
    gestureLive.out = marks.length > 0 ? markOut : null;
    gestureLive.hint = hint as GestureHint | null;
  },
  setBusy: setBusyText,
  setSaved: (items) => useSaved.setState({ items }),
  setInputAt: (t) => {
    modelControl.lastInputAt = t;
  },
  setFrame: (w, h) => {
    frame.width = w;
    frame.height = h;
    const ui = useWatch.getState();
    if (ui.fw !== w || ui.fh !== h) useWatch.setState({ fw: w, fh: h });
  },
  setMicHold: (micHold) => {
    if (useWatch.getState().micHold !== micHold) useWatch.setState({ micHold });
  },
};

/** Starts following the phone; returns the stop. */
export function startFollower(): () => void {
  const applier = new SnapshotApplier();
  let es: EventSource | null = null;
  let retry = 0;
  let stopped = false;
  let lastAt = -Infinity;
  let everSeen = false;
  let hadError = false;

  const updateLink = () => {
    const link: WatchLink = !everSeen ? 'waiting' : performance.now() - lastAt > LOST_MS ? 'lost' : 'live';
    const was = useWatch.getState().link;
    if (was === link) return;
    useWatch.setState({ link });
    // the phone is back: reconnect the picture too, in case its stream ended while it was away
    if (link === 'live' && was === 'lost') reconnectStream();
  };

  const open = () => {
    retry = 0;
    if (stopped) return;
    const src = new EventSource('/api/watch/events');
    es = src;
    src.onopen = () => {
      if (!hadError) return;
      hadError = false;
      reconnectStream(); // the server came back: so does the picture
    };
    src.onmessage = (e: MessageEvent<string>) => {
      let snap: unknown;
      try {
        snap = JSON.parse(e.data);
      } catch {
        return;
      }
      if (!isSnapshot(snap)) return;
      const now = performance.now();
      try {
        applier.apply(snap, now, target);
      } catch (err) {
        console.warn('[watch] could not apply a snapshot', err);
      }
      const age = typeof snap.age === 'number' && Number.isFinite(snap.age) ? Math.max(0, snap.age) : 0;
      lastAt = Math.max(lastAt, now - age);
      everSeen = true;
      updateLink();
    };
    src.onerror = () => {
      hadError = true;
      if (src.readyState === EventSource.CLOSED) {
        src.close();
        if (es === src) es = null;
        if (!stopped && !retry) retry = window.setTimeout(open, RETRY_MS);
      }
    };
  };

  open();
  const tick = window.setInterval(updateLink, 500);
  return () => {
    stopped = true;
    window.clearInterval(tick);
    window.clearTimeout(retry);
    es?.close();
    es = null;
  };
}
