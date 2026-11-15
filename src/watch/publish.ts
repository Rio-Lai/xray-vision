/**
 * Phone side of the big-screen view (`?phone=1`; PhoneApp mounts it once the session has started):
 * posts the app's state (./snapshot.ts) to the Mac every IDLE_STATE_MS, and, while the server says a
 * watch page is open (`watchers` > 0), the state about ten times a second and small JPEG frames of the
 * camera about FPS times a second. The watch page (`?watch=1` on the Mac, ./WatchApp.tsx) draws the
 * same overlay over those frames for the projector.
 *  - Low cost next to MediaPipe and three.js: one state post and one frame post in flight at most (a
 *    frame is skipped, never queued), frames FRAME_W px wide at JPEG QUALITY, only new camera frames
 *    (a frozen picture is sent once, then every STILL_RESEND_MS), nothing while the page is hidden.
 *  - Errors back off (up to MAX_BACKOFF_MS) and never reach the app; frames stop until the state gets through.
 *  - `?publish=0` turns it off. `?watchfps=` (1 to 15, default 8), `?watchw=` (160 to 1280, default 640) and
 *    `?watchq=` (0.2 to 0.9, default 0.5) tune the frames.
 */
import { useEffect } from 'react';
import { useStore } from '../state/store';
import { frame, frameSize, urlNumber, urlParam } from '../camera/frame';
import { live } from '../detect/live';
import { gestureLive } from '../detect/gestureDriver';
import { useHud } from '../hud/hudStore';
import { useSaved } from '../lib/saved';
import { modelControl } from '../stage/modelControl';
import { shouldMute, usePtt } from '../voice/pushToTalk';
import { BigFields, bigValues, buildSnapshot } from './snapshot';
import type { BigKey } from './snapshot';

const PUBLISH_ON = urlParam('publish') !== '0';
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const IDLE_STATE_MS = 400;
const WATCHED_STATE_MS = 100;
const FPS = clamp(urlNumber('watchfps', 8), 1, 15);
const FRAME_W = Math.round(clamp(urlNumber('watchw', 640), 160, 1280));
const QUALITY = clamp(urlNumber('watchq', 0.5), 0.2, 0.9);
const STILL_RESEND_MS = 2000;
const MAX_BACKOFF_MS = 5000;
const REQUEST_TIMEOUT_MS = 5000;

/** PhoneApp: `useWatchPublisher(started)`. Does nothing with `?publish=0`. */
export function useWatchPublisher(on: boolean): void {
  useEffect(() => {
    if (!on || !PUBLISH_ON) return;
    return startWatchPublisher();
  }, [on]);
}

function timeoutSignal(): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined;
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

function toJpeg(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((b) => resolve(b), 'image/jpeg', QUALITY);
    } catch {
      resolve(null);
    }
  });
}

/** Starts posting; returns the stop. Never throws. */
export function startWatchPublisher(): () => void {
  const sid = randomId();
  const big = new BigFields(sid);
  let seq = 0;
  let watchers = 0;
  let stopped = false;
  let stateTimer = 0;
  let frameTimer = 0;
  let stateBusy = false;
  let frameBusy = false;
  let stateFails = 0;
  let frameFails = 0;
  let canvas: HTMLCanvasElement | null = null;
  let lastKey: number | string = -1;
  let lastSentAt = -1e9;

  const hidden = () => document.visibilityState === 'hidden';

  function scheduleState(ms: number): void {
    if (stopped || stateTimer || hidden()) return;
    stateTimer = window.setTimeout(() => {
      stateTimer = 0;
      void postState();
    }, ms);
  }

  function scheduleFrame(ms: number): void {
    if (stopped || frameTimer || watchers <= 0 || hidden()) return;
    frameTimer = window.setTimeout(() => {
      frameTimer = 0;
      void sendFrame();
    }, ms);
  }

  async function postState(): Promise<void> {
    if (stopped || stateBusy || hidden()) return;
    stateBusy = true;
    const started = performance.now();
    let delay = watchers > 0 ? WATCHED_STATE_MS : IDLE_STATE_MS;
    try {
      const st = useStore.getState();
      const saved = useSaved.getState().items;
      const fields = big.prepare(bigValues(st, saved));
      seq += 1;
      const snap = buildSnapshot(
        {
          state: st,
          liveObjects: live.objects,
          liveHands: live.hands,
          marks: gestureLive.out?.marks ?? [],
          hint: gestureLive.hint,
          busy: useHud.getState().busy,
          saved,
          inputAt: modelControl.lastInputAt,
          micHold: shouldMute(usePtt.getState()),
          frame: frameSize(),
          now: performance.now(),
        },
        sid,
        seq,
        fields,
      );
      const res = await fetch('/api/watch/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(snap),
        cache: 'no-store',
        signal: timeoutSignal(),
      });
      if (!res.ok) throw new Error(`state ${res.status}`);
      const reply = (await res.json().catch(() => ({}))) as { watchers?: unknown; full?: unknown };
      big.ack(fields.ver as Record<BigKey, string>);
      if (reply.full === true) big.resendAll();
      const w = typeof reply.watchers === 'number' && Number.isFinite(reply.watchers) ? reply.watchers : 0;
      const was = watchers;
      watchers = w;
      stateFails = 0;
      if (w > 0 && was <= 0) scheduleFrame(0);
      delay = w > 0 ? WATCHED_STATE_MS : IDLE_STATE_MS;
    } catch {
      // the server is away, the route is missing (an older server) or the access cookie is gone: back off quietly
      stateFails += 1;
      watchers = 0;
      big.resendAll();
      delay = Math.min(MAX_BACKOFF_MS, IDLE_STATE_MS * 2 ** Math.min(4, stateFails));
    } finally {
      stateBusy = false;
    }
    scheduleState(Math.max(0, delay - (performance.now() - started)));
  }

  /** The camera picture to send now (the frozen one while frozen), or null when there is nothing new. */
  function grab(): { src: CanvasImageSource; w: number; h: number } | null {
    const still = useStore.getState().frozen || useHud.getState().holdFrozen;
    const fc = frame.frozenCanvas;
    const v = frame.video;
    const now = performance.now();
    if (still && frame.frozenValid && fc && fc.width > 0 && fc.height > 0) {
      if (lastKey === 'still' && now - lastSentAt < STILL_RESEND_MS) return null;
      lastKey = 'still';
      return { src: fc, w: fc.width, h: fc.height };
    }
    if (!v || v.readyState < 2 || v.videoWidth <= 0 || v.videoHeight <= 0) return null;
    // no new camera frame since the last one sent (a paused video: again every STILL_RESEND_MS)
    if (v.currentTime === lastKey && now - lastSentAt < STILL_RESEND_MS) return null;
    lastKey = v.currentTime;
    return { src: v, w: v.videoWidth, h: v.videoHeight };
  }

  async function sendFrame(): Promise<void> {
    if (stopped || frameBusy || watchers <= 0 || hidden()) return;
    frameBusy = true;
    const started = performance.now();
    let delay = 1000 / FPS;
    try {
      const pic = grab();
      if (pic) {
        const w = Math.min(FRAME_W, pic.w);
        const h = Math.max(1, Math.round((w * pic.h) / pic.w));
        canvas ??= document.createElement('canvas');
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(pic.src, 0, 0, w, h);
          const blob = await toJpeg(canvas);
          if (blob && !stopped) {
            const res = await fetch('/api/watch/frame', {
              method: 'POST',
              headers: { 'Content-Type': 'image/jpeg' },
              body: blob,
              cache: 'no-store',
              signal: timeoutSignal(),
            });
            if (!res.ok) throw new Error(`frame ${res.status}`);
            lastSentAt = performance.now();
          }
        }
      } else {
        delay = Math.min(delay, 40); // look again soon for the next camera frame
      }
      frameFails = 0;
    } catch {
      frameFails += 1;
      lastKey = -1;
      delay = Math.min(MAX_BACKOFF_MS, 250 * 2 ** Math.min(4, frameFails));
    } finally {
      frameBusy = false;
    }
    scheduleFrame(Math.max(0, delay - (performance.now() - started)));
  }

  const onVisibility = () => {
    if (hidden()) {
      window.clearTimeout(stateTimer);
      window.clearTimeout(frameTimer);
      stateTimer = 0;
      frameTimer = 0;
      watchers = 0;
    } else {
      scheduleState(0);
    }
  };
  document.addEventListener('visibilitychange', onVisibility);
  scheduleState(0);

  return () => {
    stopped = true;
    document.removeEventListener('visibilitychange', onVisibility);
    window.clearTimeout(stateTimer);
    window.clearTimeout(frameTimer);
    canvas = null;
  };
}
