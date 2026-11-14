/**
 * The explode pipeline. Plain functions over the store, safe to call from
 * keyboard handlers, the HUD and the voice client tools.
 */
import { useStore, type SceneObject } from '../state/store';
import type { IdentifyResponse, Teardown, TeardownPart } from '../../shared/teardown';
import { mockIdentify } from '../../shared/demo';
import { api } from './api';
import { voiceBridge } from '../voice/bridge';

/** Bumped by resetAll and each new explode, so stale async results are dropped. */
let runId = 0;
/** Which scene object the current teardown belongs to. */
let explodedSceneId: string | null = null;

function pickTarget(objectId?: string): SceneObject | null {
  const s = useStore.getState();
  const byId = (id: string | null | undefined) => (id ? s.objects.find((o) => o.id === id) ?? null : null);
  if (objectId) return byId(objectId);
  const direct = byId(s.focusedObjectId) ?? byId(s.selectedObjectId);
  if (direct) return direct;
  const inLens = s.objects.filter((o) => o.lens === s.lens);
  if (inLens.length === 0) return null;
  return inLens.reduce((a, b) => (b.confidence > a.confidence ? b : a));
}

/** Text pushed to the voice agent after an explode, so it knows the parts without calling get_scene. */
export function describeTeardown(td: Teardown): string {
  const parts = td.parts
    .map((p) => `- ${p.id}: ${p.name}. ${p.summary}${p.safety ? ` SAFETY: ${p.safety}` : ''}`)
    .join('\n');
  const steps = td.steps.map((s) => `${s.n}. ${s.text}`).join('\n');
  return [
    `The user is now looking at an exploded view of: ${td.name} (lens: ${td.lens}, source: ${td.source}${
      td.source === 'live' ? ', AI-estimated, not checked' : ''
    }).`,
    `Parts (use these ids with highlight_part):\n${parts}`,
    steps ? `Steps (use show_step with n):\n${steps}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export async function explodeObject(objectId?: string): Promise<{ ok: boolean; message: string }> {
  const target = pickTarget(objectId);
  if (!target) {
    return {
      ok: false,
      message: objectId ? `No object with id ${objectId} in view.` : 'Nothing in view to explode. Look at an object first.',
    };
  }

  const store = useStore.getState();
  store.selectObject(target.id);
  if (target.anchor === 'box' && store.trackingMode === 'freeze') store.setFrozen(true);

  // Already exploded this object: just open it again.
  if (store.teardown && explodedSceneId === target.id) {
    store.setExplode(1);
    return { ok: true, message: `Exploded ${store.teardown.name}: ${store.teardown.parts.length} parts.` };
  }

  const myRun = ++runId;
  const stale = () => myRun !== runId;
  store.setTeardownStatus('loading');

  // 1. Identify. Any failure falls back to the mock mapping by detector label.
  let ident: IdentifyResponse | null = null;
  try {
    const crop = useStore.getState().camera?.captureCrop(target.box) ?? null;
    if (crop) ident = await api.identify({ image: crop, lens: target.lens, hint: target.label });
  } catch (err) {
    console.warn('[flow] identify failed, using mock mapping', err);
  }
  if (!ident) ident = mockIdentify(target.label, target.lens);
  if (stale()) return { ok: false, message: 'Cancelled.' };
  useStore.getState().patchObject(target.id, { name: ident.name });

  // 2. Teardown (server is cache-first).
  let td: Teardown;
  try {
    td = await api.teardown({ object_id: ident.object_id, name: ident.name, lens: target.lens });
  } catch (err) {
    if (stale()) return { ok: false, message: 'Cancelled.' };
    const message = err instanceof Error ? err.message : String(err);
    useStore.getState().setTeardownStatus('error', message);
    return { ok: false, message: `Could not load parts for ${ident.name}: ${message}` };
  }
  if (stale()) return { ok: false, message: 'Cancelled.' };

  // 3. Show it.
  const s = useStore.getState();
  explodedSceneId = target.id;
  s.setTeardown(td);
  s.setExplode(1);
  voiceBridge.sendContextualUpdate(describeTeardown(td));

  // 4. Real meshes in the background.
  void generateMeshes(td, myRun);

  return { ok: true, message: `Exploded ${td.name}: ${td.parts.length} parts.` };
}

function partPrompt(td: Teardown, part: TeardownPart): string {
  if (td.lens === 'biology') {
    return `anatomical 3D model of the ${part.name} of the human hand, isolated single object, medical illustration style, plain white background`;
  }
  return `isolated ${part.name} from a ${td.name}, single object, studio product render, plain white background, high detail`;
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
  useStore.getState().resetView();
  voiceBridge.sendContextualUpdate('The view was reset. Nothing is exploded now.');
}
