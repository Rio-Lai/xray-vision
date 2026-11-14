/**
 * The explode pipeline. Plain functions over the store, safe to call from
 * keyboard handlers, the HUD and the voice client tools.
 */
import { useStore, type SceneObject } from '../state/store';
import type { IdentifyResponse, Teardown } from '../../shared/teardown';
import { kindOf, mockIdentify } from '../../shared/demo';
import { partPrompt } from '../../shared/prompts';
import { ApiError, SERVER_DOWN_MESSAGE, api, isServerDown } from './api';
import { voiceBridge } from '../voice/bridge';

/** Bumped by resetAll and each new explode, so stale async results are dropped. */
let runId = 0;
/** Which scene object the current teardown belongs to. */
let explodedSceneId: string | null = null;

export interface ExplodeResult {
  ok: boolean;
  message: string;
}
/** The explode in progress, so a second "explode this" for the same object joins it instead of cancelling it. */
let inFlight: { sceneId: string; promise: Promise<ExplodeResult> } | null = null;

/** What "this" means: the named scene object, else the focused one, else the selected one, else the most confident. Any kind. */
function pickTarget(objectId?: string): SceneObject | null {
  const s = useStore.getState();
  const byId = (id: string | null | undefined) => (id ? s.objects.find((o) => o.id === id) ?? null : null);
  if (objectId) {
    const hit = byId(objectId);
    if (hit) return hit;
    // The agent sometimes passes a teardown id ("macbook-air-m3-13") or a made-up one; fall back to "this".
    console.warn(`[flow] no scene object "${objectId}", using the focused object`);
  }
  const direct = byId(s.focusedObjectId) ?? byId(s.selectedObjectId);
  if (direct) return direct;
  if (s.objects.length === 0) return null;
  return s.objects.reduce((a, b) => (b.confidence > a.confidence ? b : a));
}

/** Text pushed to the voice agent after an explode, so it knows the parts without calling get_scene. */
export function describeTeardown(td: Teardown): string {
  const parts = td.parts
    .map((p) => `- ${p.id}: ${p.name}. ${p.summary}${p.safety ? ` SAFETY: ${p.safety}` : ''}`)
    .join('\n');
  const steps = td.steps.map((s) => `${s.n}. ${s.text}`).join('\n');
  return [
    `The user is now looking at an exploded view of: ${td.name} (source: ${td.source}${
      td.source === 'live' ? ', AI-estimated, not checked' : ''
    }).`,
    `Parts (use these ids with highlight_part):\n${parts}`,
    steps ? `Steps (use show_step with n):\n${steps}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** The tutor reads this aloud, so it is short and never a raw error. */
function teardownFailMessage(err: unknown, name: string): string {
  if (isServerDown(err)) return SERVER_DOWN_MESSAGE;
  // Our server's only 404: no checked parts list and no Anthropic key to make one.
  if (err instanceof ApiError && err.status === 404) return `I do not have parts for the ${name} yet.`;
  return `I could not load the parts for the ${name}. Try again in a moment.`;
}

export function explodeObject(objectId?: string): Promise<ExplodeResult> {
  // "Explode this" means Blowfish is on: show the labels if they were off.
  const s = useStore.getState();
  if (!s.overlayOn) s.setOverlayOn(true);
  const target = pickTarget(objectId);
  if (!target) {
    return Promise.resolve({ ok: false, message: 'Nothing in view to explode. Look at an object first.' });
  }
  if (inFlight && inFlight.sceneId === target.id) return inFlight.promise;
  const promise = runExplode(target);
  const entry = { sceneId: target.id, promise };
  inFlight = entry;
  const clear = () => {
    if (inFlight === entry) inFlight = null;
  };
  promise.then(clear, clear);
  return promise;
}

async function runExplode(target: SceneObject): Promise<ExplodeResult> {
  const store = useStore.getState();
  store.selectObject(target.id);
  const froze = target.anchor === 'box' && store.trackingMode === 'freeze';
  if (froze) store.setFrozen(true);

  // Already exploded this object: just open it again.
  if (store.teardown && explodedSceneId === target.id) {
    store.setExplode(1);
    return { ok: true, message: `Exploded ${store.teardown.name}: ${store.teardown.parts.length} parts.` };
  }

  const myRun = ++runId;
  const stale = () => myRun !== runId;
  const fail = (message: string): ExplodeResult => {
    if (stale()) return { ok: false, message: 'Cancelled.' };
    useStore.getState().setTeardownStatus('error', message);
    if (froze) useStore.getState().setFrozen(false);
    return { ok: false, message };
  };
  store.setTeardownStatus('loading');
  // Which server prompt to use comes from the object itself, never from a UI setting.
  const kind = kindOf(target.label, target.anchor);

  // 1. Identify. Any failure except "server not running" falls back to the mock mapping by detector label.
  let ident: IdentifyResponse | null = null;
  try {
    const crop = useStore.getState().camera?.captureCrop(target.box) ?? null;
    if (crop) ident = await api.identify({ image: crop, lens: kind, hint: target.label });
  } catch (err) {
    if (isServerDown(err)) return fail(SERVER_DOWN_MESSAGE);
    console.warn('[flow] identify failed, using mock mapping', err);
  }
  if (!ident) ident = mockIdentify(target.label, kind);
  if (stale()) return { ok: false, message: 'Cancelled.' };
  useStore.getState().patchObject(target.id, { name: ident.name });

  // 2. Teardown (server is cache-first).
  let td: Teardown;
  try {
    td = await api.teardown({ object_id: ident.object_id, name: ident.name, lens: kind });
  } catch (err) {
    console.warn(`[flow] teardown for ${ident.object_id} failed`, err);
    return fail(teardownFailMessage(err, ident.name));
  }
  if (stale()) return { ok: false, message: 'Cancelled.' };

  // 3. Show it.
  const s = useStore.getState();
  explodedSceneId = target.id;
  s.setTeardown(td);
  s.setExplode(1);
  voiceBridge.sendContextualUpdate(describeTeardown(td));

  // 4. Real meshes in the background. Not for hands: the hand overlay draws from landmarks and ignores mesh_url.
  if (td.anchor !== 'hand') void generateMeshes(td, myRun);

  return { ok: true, message: `Exploded ${td.name}: ${td.parts.length} parts.` };
}

/** Two fal jobs at a time. Stops on mock mode, skips failures silently. */
async function generateMeshes(td: Teardown, myRun: number) {
  const queue = td.parts.filter((p) => !p.mesh_url);
  let stop = false;
  const worker = async () => {
    while (!stop && queue.length > 0 && myRun === runId) {
      const part = queue.shift()!;
      try {
        const out = await api.generatePart({
          object_id: td.object_id,
          part_id: part.id,
          prompt: partPrompt(td, part),
        });
        if (out.mock) {
          stop = true;
          return;
        }
        const current = useStore.getState().teardown;
        if (out.mesh_url && myRun === runId && current?.object_id === td.object_id) {
          useStore.getState().setPartMesh(part.id, out.mesh_url);
        }
      } catch (err) {
        console.warn(`[flow] mesh for ${part.id} failed`, err);
      }
    }
  };
  await Promise.all([worker(), worker()]);
}

export function pickPart(partId: string): void {
  const s = useStore.getState();
  s.highlightPart(partId);
  const part = s.teardown?.parts.find((p) => p.id === partId);
  if (part && voiceBridge.isConnected()) {
    voiceBridge.sendUserMessage(`Tell me about the ${part.name}.`);
  }
}

export function resetAll(): void {
  runId++;
  explodedSceneId = null;
  inFlight = null;
  useStore.getState().resetView();
  voiceBridge.sendContextualUpdate('The view was reset. Nothing is exploded now.');
}
