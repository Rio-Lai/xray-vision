/**
 * Kash's X-ray arm (public/cache/arm-hand/, src/biology/arm/) as the floating model for a hand.
 *
 * On stage, "analyse my hand" shows his assembled 3D arm and hand instead of the landmark-drawn
 * hand parts: flow.ts swaps the hand's parts list for this one (stageTeardownFor), so the store,
 * the HUD cards and the voice tools all describe what is on screen. The overlay mounts his
 * renderer for it (src/overlay/ArmStage.tsx). Freeze / follow (hidden fallbacks) keep the old
 * hand overlay on the real hand.
 *
 * His teardown has fields the shared schema does not (landmarks, from / to, layer_focus,
 * activities), so it is mapped to a valid Teardown here, and the extras the tutor can use
 * (nerve supply, typing roles, layer names, the clinical note) are read from his file directly.
 */
import { TeardownSchema } from '../../shared/teardown';
import type { PartShape, Teardown } from '../../shared/teardown';
import type { AppState } from '../state/store';
import { useStore } from '../state/store';
import { loadArmTeardown } from '../biology/arm/types';
import type { ArmPart, ArmTeardown } from '../biology/arm/types';

/** object_id of Kash's arm teardown (also what his tour tells the agent to pass to explode). */
export const ARM_OBJECT_ID = 'arm-hand';

export function isArmTeardown(td: Pick<Teardown, 'object_id'> | null | undefined): boolean {
  return !!td && td.object_id === ARM_OBJECT_ID;
}

/** Sentence case for labels and cards ("biceps brachii" -> "Biceps brachii"). */
export function sentenceCase(s: string): string {
  const t = s.trim();
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

/** His shapes -> the schema's placeholder shapes (never drawn: the arm has its own renderer). */
function shapeOf(p: ArmPart): PartShape {
  if (p.shape.startsWith('tendon') || p.shape === 'nerve' || p.shape === 'vessel' || p.shape === 'sleeve') return 'tube';
  if (p.shape === 'hand-skeleton') return 'box';
  return 'cylinder';
}

/**
 * His teardown -> a valid Teardown. Layers 1..6 (1 = skin) become 0..5 (0 = outermost, as in
 * docs/CONTRACTS.md); size and offset are placeholders (the arm is placed by its own landmarks).
 * The "(right, anterior view)" note is dropped from the title: on stage the arm turns.
 */
export function armToTeardown(a: ArmTeardown): Teardown {
  const minLayer = Math.min(...a.parts.map((p) => p.layer));
  return TeardownSchema.parse({
    object_id: a.object_id,
    name: sentenceCase(a.name.replace(/\s*\([^)]*\)\s*$/, '')),
    lens: 'biology',
    anchor: 'hand',
    explode_axis: 'z',
    source: 'cached',
    parts: a.parts.map((p) => ({
      id: p.id,
      name: sentenceCase(p.name),
      layer: Math.max(0, p.layer - minLayer),
      size: [0.2, 0.2, 0.1],
      offset: [0, 0],
      shape: shapeOf(p),
      color: p.color,
      summary: p.summary,
      details: p.details,
      safety: p.safety && p.safety.trim() ? p.safety : null,
      mesh_url: p.mesh_url,
    })),
    steps: a.steps.map((s) => ({ n: s.n, text: s.text, part_ids: s.part_ids })),
  });
}

let adapted: Promise<Teardown> | null = null;

/** The arm as a Teardown (loaded once). */
export function loadArmStageTeardown(): Promise<Teardown> {
  adapted ??= loadArmTeardown().then(armToTeardown);
  adapted.catch(() => {
    adapted = null; // a failed load is tried again next time
  });
  return adapted;
}

/**
 * For flow.ts: on stage, a hand's parts list becomes the arm's. Anything else (and any failure to
 * load the arm) keeps the parts list it was given.
 */
export async function stageTeardownFor(td: Teardown): Promise<Teardown> {
  if (td.anchor !== 'hand' || useStore.getState().trackingMode !== 'stage') return td;
  try {
    return await loadArmStageTeardown();
  } catch (err) {
    console.warn('[arm] could not load the arm, keeping the hand overlay', err);
    return td;
  }
}

/**
 * The scene object the agent means by `object_id`. "arm-hand" (or "arm") is the hand in view,
 * since the arm is how a hand is shown: the selected hand, else the focused one, else any hand.
 * Returns null for the arm when no hand is in view and the arm is not already on stage.
 * Other ids pass through unchanged.
 */
export function resolveObjectId(objectId: string, s: Pick<AppState, 'objects' | 'selectedObjectId' | 'focusedObjectId' | 'teardown'>): string | null {
  const id = objectId.trim().toLowerCase();
  if (id !== ARM_OBJECT_ID && id !== 'arm' && id !== 'hand') return objectId;
  const isHand = (oid: string | null) => !!oid && s.objects.some((o) => o.id === oid && o.anchor === 'hand');
  if (isArmTeardown(s.teardown) && s.selectedObjectId) return s.selectedObjectId;
  if (isHand(s.selectedObjectId)) return s.selectedObjectId;
  if (isHand(s.focusedObjectId)) return s.focusedObjectId;
  return s.objects.find((o) => o.anchor === 'hand')?.id ?? null;
}

/**
 * get_pose part ids for a pressing finger, the thumb, and a lifting finger, on the arm's parts list
 * (the hand overlay's are fdp / fds / flexor-tendons, fpl / thenar, extensor-digitorum).
 * The forearm flexor group includes FDS, FDP and FPL (see its details in his teardown).
 */
export const ARM_MUSCLE_IDS = {
  flexors: ['forearm-flexors', 'flexor-tendons'],
  thumb: ['thenar', 'forearm-flexors'],
  extensors: ['forearm-extensors', 'extensor-tendons'],
};

/** Layer names ("Superficial muscles"), keyed by the store's layer number (0 = skin). */
export async function armLayerNames(): Promise<Record<string, string>> {
  const a = await loadArmTeardown();
  const out: Record<string, string> = {};
  const keys = Object.keys(a.layers_legend).map(Number);
  const min = Math.min(...keys);
  for (const k of keys) out[String(k - min)] = sentenceCase(a.layers_legend[String(k)]);
  return out;
}

/** Kash's extra fields for highlight_part: nerve supply, role in typing, layer name. */
export async function armPartExtras(partId: string): Promise<{ nerve: string | null; typing_role: string | null; layer: string | null }> {
  const a = await loadArmTeardown();
  const part = a.parts.find((p) => p.id === partId);
  const role = a.activities.typing?.roles.find((r) => r.part_id === partId);
  return {
    nerve: part?.nerve ? part.nerve : null,
    typing_role: role?.role ?? null,
    layer: part ? sentenceCase(a.layers_legend[String(part.layer)] ?? '') || null : null,
  };
}

/** Kash's extra fields for show_step (as his tour returned them): layer, parts, typing roles, clinical note. */
export async function armStepExtras(n: number) {
  const a = await loadArmTeardown();
  const step = a.steps.find((x) => x.n === n);
  if (!step) return {};
  const parts = step.part_ids
    .map((id) => a.parts.find((p) => p.id === id))
    .filter((p): p is ArmPart => !!p)
    .map((p) => ({ id: p.id, name: sentenceCase(p.name), summary: p.summary, nerve: p.nerve || null, safety: p.safety || null }));
  const typing = a.activities.typing;
  return {
    layer: sentenceCase(a.layers_legend[String(step.layer_focus)] ?? ''),
    parts,
    typing_roles: typing?.roles.filter((r) => step.part_ids.includes(r.part_id)) ?? [],
    ...(step.n === a.steps.length && typing ? { clinical_note: typing.clinical_note } : {}),
  };
}
