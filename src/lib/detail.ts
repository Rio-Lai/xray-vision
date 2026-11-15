/**
 * The detail model's flow (`?detail=1`; everything here does nothing without it): ask the server for a
 * schematic model of one mechanism, material or process (POST /api/detail), put it in the store for
 * src/overlay/DetailStage.tsx, move the main model aside while it is up and back when it closes.
 *
 *   ?detail=1     on: the voice tools show_detail / detail_step / close_detail and the typed "detail <topic>" work
 *   ?detail=mock  on, but every request shows the built-in test fixture (SAMPLE_DETAIL, titled "Sample: ...")
 *                 without calling the server: for trying the view with no key
 *
 * The flag is read once, when the app loads. Without it DetailStage is not mounted, the tools answer
 * DETAIL_OFF_SAY, and nothing else changes.
 */
import { MODEL_PAN_MAX, useStore } from '../state/store';
import { DetailSceneSchema, SAMPLE_DETAIL, type DetailScene } from '../../shared/detail';
import { urlParam } from '../camera/frame';
import { PAN_UNIT_VH } from '../stage/modelControl';
import { ApiError, SERVER_DOWN_MESSAGE, api, isServerDown, isTimeout } from './api';

const MODE = urlParam('detail');
/** `?detail=1` (or `true`, or `mock`): the whole feature is on. Off by default. */
export const DETAIL_ON: boolean = MODE === '1' || MODE === 'true' || MODE === 'mock';
/** `?detail=mock`: the test fixture for every request, no server call. */
export const DETAIL_MOCK: boolean = MODE === 'mock';

/** What the tools answer with the flag off. */
export const DETAIL_OFF_SAY = 'I cannot build detail models yet.';
const FAIL_SAY = 'I could not build a model of that just now. Try again in a moment.';
const SLOW_SAY = 'That model took too long to build. Try again in a moment.';

/** The client waits a little longer than the server (45 s, server/lib/claude.ts), so the server's sentence wins. */
const CLIENT_TIMEOUT_MS = 50_000;
/** A failed build shows its sentence on the card for this long, then the card goes. */
const ERROR_SHOW_MS = 4_000;
/** While a detail is up the main model is drawn this much smaller, in the middle of the left half. */
const ASIDE_ZOOM = 0.62;

/** Bumped by every open and close, so a late answer for an old request is dropped. */
let reqId = 0;
/** Where the main model was before it was moved aside (restored on close), and which model it was. */
let aside: { objectId: string; panX: number; panY: number; zoom: number } | null = null;

export type DetailOpen = { ok: true; scene: DetailScene } | { ok: false; say: string };

/** The pan (stage sizes) that puts the main model in the middle of the left half of the view. */
export function asidePanX(vw: number, vh: number): number {
  const x = -(vw / 4) / Math.max(1, PAN_UNIT_VH * vh);
  return Math.max(-MODEL_PAN_MAX, Math.min(0, x));
}

/** Move the open model (if any) to the left and shrink it, remembering where it was. */
function moveModelAside(): void {
  const s = useStore.getState();
  if (!s.teardown) {
    aside = null;
    return;
  }
  if (!aside || aside.objectId !== s.teardown.object_id) {
    aside = { objectId: s.teardown.object_id, panX: s.modelPanX, panY: s.modelPanY, zoom: s.modelZoom };
  }
  s.panModel(asidePanX(window.innerWidth, window.innerHeight) - s.modelPanX, aside.panY - s.modelPanY);
  s.setModelZoom(aside.zoom * ASIDE_ZOOM);
}

/** Put the main model back where it was, if it is still the same one (after "put it away" it is gone). */
function restoreModel(): void {
  const s = useStore.getState();
  if (aside && s.teardown && s.teardown.object_id === aside.objectId) {
    s.panModel(aside.panX - s.modelPanX, aside.panY - s.modelPanY);
    s.setModelZoom(aside.zoom);
  }
  aside = null;
}

/**
 * Build and show a detail model of `topic`. Shows the loading card at once and moves the main model aside;
 * resolves when the model is up (or with one sentence to say when it cannot be).
 * `ctx.object` = the name of the model on stage, `ctx.part` / `ctx.context` = the part asked about.
 */
export async function openDetail(topic: string, ctx: { object?: string; part?: string; context?: string } = {}): Promise<DetailOpen> {
  if (!DETAIL_ON) return { ok: false, say: DETAIL_OFF_SAY };
  const t = topic.trim().slice(0, 200);
  if (!t) return { ok: false, say: 'Say what to model.' };
  const id = ++reqId;
  useStore.getState().setDetailLoading(t);
  moveModelAside();
  const current = () => id === reqId && useStore.getState().detailStatus === 'loading';
  try {
    let scene: DetailScene;
    if (DETAIL_MOCK) {
      await new Promise((r) => setTimeout(r, 700));
      scene = SAMPLE_DETAIL;
    } else {
      const raw = await api.detail(
        { topic: t, ...(ctx.object ? { object: ctx.object } : {}), ...(ctx.part ? { part: ctx.part } : {}), ...(ctx.context ? { context: ctx.context } : {}) },
        { timeoutMs: CLIENT_TIMEOUT_MS },
      );
      const parsed = DetailSceneSchema.safeParse(raw);
      if (!parsed.success) throw new Error(`the detail model did not match the schema: ${parsed.error.issues[0]?.message ?? ''}`);
      scene = parsed.data;
    }
    // closed, put away or replaced while it was being built
    if (!current()) return { ok: false, say: 'Closed.' };
    useStore.getState().setDetail(scene);
    return { ok: true, scene };
  } catch (err) {
    const say = isServerDown(err)
      ? SERVER_DOWN_MESSAGE
      : isTimeout(err)
        ? SLOW_SAY
        : err instanceof ApiError && err.status >= 400 && err.message
          ? err.message
          : FAIL_SAY;
    console.warn('[detail] could not build', t, err);
    if (current()) {
      useStore.getState().setDetailError(say);
      restoreModel();
      setTimeout(() => {
        if (id === reqId && useStore.getState().detailStatus === 'error') useStore.getState().clearDetail();
      }, ERROR_SHOW_MS);
    }
    return { ok: false, say };
  }
}

/** Close the detail model (and drop one still being built); the main model goes back where it was. */
export function closeDetail(): void {
  reqId++;
  useStore.getState().clearDetail();
  restoreModel();
}

/** Light up step n (1-based) of the open detail model. false if there is no such step. */
export function setDetailStep(n: number): boolean {
  const s = useStore.getState();
  if (!s.detail || !Number.isInteger(n) || n < 1 || n > s.detail.steps.length) return false;
  s.setDetailStep(n);
  return true;
}

// A new main model opened while a detail is up goes to the left too (it would open in the middle, under it).
if (DETAIL_ON) {
  useStore.subscribe((s, prev) => {
    const up = s.detailStatus === 'loading' || s.detailStatus === 'ready';
    const id = s.teardown?.object_id ?? null;
    if (up && id !== null && id !== (prev.teardown?.object_id ?? null)) {
      // it goes back to the middle at the normal size when the detail closes
      aside = { objectId: id, panX: 0, panY: 0, zoom: 1 };
      moveModelAside();
    }
    // put away (resetView) while a detail was up: nothing to restore
    if (!s.teardown && prev.teardown) aside = null;
  });
}
