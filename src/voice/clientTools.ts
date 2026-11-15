/**
 * The ElevenLabs client tools (names from CLIENT_TOOL_NAMES in shared/teardown.ts).
 * Each takes the agent's parameters object and returns a short string for the agent.
 * In the ElevenLabs dashboard every tool must be set to "wait for response".
 */
import { useStore, type FingerName, type HandState } from '../state/store';
import type { ClientToolName, Teardown, TeardownPart } from '../../shared/teardown';
import { explodeObject, resetAll, resolveSavedObjectId } from '../lib/flow';
// #97: saved models ("put it away" keeps them; explode with a saved id or name brings one back)
import { describeSaved } from '../lib/saved';
import { shortName } from '../hud/names';
import { armPose } from '../biology/arm/tour';
import { startArmLive } from '../biology/arm/armLive';
import { ARM_MUSCLE_IDS, armLayerNames, armPartExtras, armStepExtras, isArmTeardown, resolveObjectId } from '../stage/armTeardown';
// Kash's eye (#94): object_id "eye" means an eye in view (or the stored eye when none is); get_pose adds `eyes`.
import { isEyeTeardown, resolveEyeObjectId } from '../stage/eyeTeardown';
import { describeEyes } from '../detect/faceTracker';
import { live } from '../detect/live';

// Kash's X-ray arm (public/cache/arm-hand) is the floating model for a hand on stage: flow.ts loads it as the hand's
// parts list, so these tools work on it through the store like on any other object (src/stage/armTeardown.ts), and
// add his extra fields (nerve, typing role, layer, clinical note). object_id "arm-hand" means the hand in view.
// Live hands also feed his typing detector (get_pose "arm").
startArmLive();

type Params = Record<string, unknown> | undefined | null;
type Tool = (params?: Params) => Promise<string>;

const str = (p: Params, key: string): string | undefined => {
  const v = p?.[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
};
const num = (p: Params, key: string): number | undefined => {
  const v = p?.[key];
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const json = (v: unknown) => JSON.stringify(v);
const round = (n: number) => Math.round(n * 100) / 100;

/** Accept an exact part id, or a loose name match ("battery", "the trackpad"). */
function findPart(query: string) {
  const td = useStore.getState().teardown;
  if (!td) return null;
  const q = query.toLowerCase();
  return (
    td.parts.find((p) => p.id === q) ??
    td.parts.find((p) => p.name.toLowerCase() === q) ??
    td.parts.find((p) => p.name.toLowerCase().includes(q) || q.includes(p.id.replace(/-/g, ' '))) ??
    null
  );
}

/** Part ids for a pressing finger, the thumb and a lifting finger on the hand overlay's parts list (the arm: ARM_MUSCLE_IDS). */
const HAND_MUSCLE_IDS = { flexors: ['fdp', 'fds', 'flexor-tendons'], thumb: ['fpl', 'thenar'], extensors: ['extensor-digitorum'] };
type MuscleIds = typeof HAND_MUSCLE_IDS;

function describeHand(h: HandState, ids: MuscleIds) {
  const active: FingerName | null = h.activeFinger;
  const pressing = active ? h.fingers[active]?.pressing === true : false;
  let action: 'pressing' | 'extending' | null = null;
  let muscles: string[] = [];
  if (active && pressing) {
    action = 'pressing';
    muscles = active === 'thumb' ? ids.thumb : ids.flexors;
  } else if (active) {
    action = 'extending';
    muscles = ids.extensors;
  }
  const fingers = Object.fromEntries(
    (Object.keys(h.fingers) as FingerName[]).map((f) => [
      f,
      { curl: round(h.fingers[f].curl), pressing: h.fingers[f].pressing },
    ]),
  );
  return { handedness: h.handedness, activeFinger: active, action, muscles, fingers };
}

/** Up to three parts for the short tour after an explode: the two outermost, then one with a safety note (e.g. the battery). */
function tourParts(td: Teardown): TeardownPart[] {
  const byLayer = [...td.parts].sort((a, b) => a.layer - b.layer);
  const withSafety = byLayer.filter((p) => p.safety);
  const rest = byLayer.filter((p) => !p.safety);
  return [...rest.slice(0, 2), ...withSafety.slice(0, 1), ...rest.slice(2)].slice(0, 3);
}

/** Part names for ids, from the loaded parts list (ids not in it are left out). */
function partNames(ids: string[]): string[] {
  const td = useStore.getState().teardown;
  if (!td) return [];
  return ids.map((id) => td.parts.find((p) => p.id === id)?.name).filter((n): n is string => Boolean(n));
}

const tools: Record<ClientToolName, Tool> = {
  async get_scene() {
    const s = useStore.getState();
    return json({
      overlay_on: s.overlayOn,
      focused_object_id: s.focusedObjectId,
      selected_object_id: s.selectedObjectId,
      objects: s.objects.map((o) => ({
        id: o.id,
        label: o.label,
        name: o.name ?? null,
        lens: o.lens,
        focused: o.id === s.focusedObjectId,
      })),
      teardown: s.teardown
        ? {
            object_id: s.teardown.object_id,
            name: s.teardown.name,
            source: s.teardown.source,
            parts: s.teardown.parts.map((p) => ({
              id: p.id,
              name: p.name,
              summary: p.summary,
              safety: p.safety ?? null,
            })),
            step_count: s.teardown.steps.length,
          }
        : null,
      status: s.teardownStatus,
      explode_amount: s.explodeAmount,
      highlighted_part_id: s.highlightedPartId,
      active_step: s.activeStep,
      saved: describeSaved(),
    });
  },

  async select_object(p) {
    const s = useStore.getState();
    const id = str(p, 'object_id') ?? s.focusedObjectId;
    const obj = id ? s.objects.find((o) => o.id === id) : undefined;
    if (!obj) return 'No such object in view. Call get_scene to see what is visible.';
    s.selectObject(obj.id);
    return `Selected ${obj.name ?? obj.label} (${obj.id}).`;
  },

  async explode(p) {
    const amount = num(p, 'amount');
    const s = useStore.getState();
    // "arm-hand" (Kash's arm) means the hand in view: the arm is how a hand is shown on stage.
    const asked = str(p, 'object_id');
    const resolved = asked === undefined ? undefined : resolveEyeObjectId(asked, s) ?? resolveObjectId(asked, s);
    // #97: not in view (or not a scene id): a saved model with that id or name, brought back
    const objectId = asked !== undefined && (resolved === null || resolved === asked) ? resolveSavedObjectId(asked, s) ?? resolved : resolved;
    if (objectId === null) return 'No hand in view. Ask the user to hold a hand in front of the camera, then call explode again.';
    if (amount !== undefined && amount <= 0) {
      s.setExplode(0);
      return 'Collapsed the view.';
    }
    // Teardown already loaded and no other object asked for: just change the spread.
    if (s.teardown && (!objectId || objectId === s.selectedObjectId) && amount !== undefined) {
      s.setExplode(amount);
      return `Explode set to ${round(Math.min(1, amount))}.`;
    }
    const result = await explodeObject(objectId);
    if (result.ok && amount !== undefined) useStore.getState().setExplode(amount);
    const td = useStore.getState().teardown;
    if (!result.ok || !td) return result.message;
    const tour = tourParts(td);
    const arm = isArmTeardown(td);
    const eye = isEyeTeardown(td);
    return json({
      ok: true,
      message: result.message,
      source: td.source,
      part_ids: td.parts.map((x) => x.id),
      // Kash's arm: its layers (0 = skin) and its guided tour
      ...(arm ? { layers: await armLayerNames(), steps: td.steps.length } : {}),
      // Kash's eye: its steps are the path of light, offered instead of a part tour
      ...(eye ? { steps: td.steps.length, steps_are: 'the path of light, from the cornea to the optic nerve' } : {}),
      ...(eye ? {} : { tour: tour.map((x) => ({ id: x.id, name: x.name, summary: x.summary, safety: x.safety ?? null })) }),
      next: arm
        ? `This is a layered 3D model of the arm and hand. Say that in one sentence, then walk through it: call show_step with n 1, then 2, up to ${td.steps.length}, one short sentence each.`
        : eye
          ? `This is the checked 3D model of the human eye. Say it is open in one short sentence and stop. When the user asks how the eye works, how it focuses or how light gets in, walk the path of light: call show_step with n 1, then 2, up to ${td.steps.length}, one short sentence each.`
          : `Give a short tour of these ${tour.length} parts in order: call highlight_part before you mention each one, one short sentence each, and say any safety note.${
            td.source === 'live' ? ' Say once that the parts are AI-estimated.' : ''
          }`,
    });
  },

  async highlight_part(p) {
    const q = str(p, 'part_id');
    if (!q) return 'part_id is required.';
    if (!useStore.getState().teardown) return 'Nothing is exploded yet. Call explode first.';
    const part = findPart(q);
    if (!part) {
      const ids = useStore.getState().teardown!.parts.map((x) => x.id).join(', ');
      return `Unknown part "${q}". Valid ids: ${ids}`;
    }
    useStore.getState().highlightPart(part.id);
    // Kash's arm: nerve supply, role in typing, layer
    const extras = isArmTeardown(useStore.getState().teardown) ? await armPartExtras(part.id) : {};
    return json({
      ok: true,
      part: { id: part.id, name: part.name, summary: part.summary, details: part.details, safety: part.safety ?? null, ...extras },
      ...(part.safety ? { remember: 'Say the safety note.' } : {}),
    });
  },

  async show_step(p) {
    const n = num(p, 'n');
    const td = useStore.getState().teardown;
    if (!td) return 'Nothing is exploded yet. Call explode first.';
    if (n === undefined) return 'n is required.';
    const step = td.steps.find((x) => x.n === Math.round(n));
    if (!step) return `No step ${n}. There are ${td.steps.length} steps.`;
    useStore.getState().showStep(step.n);
    // Light up the part the step is about, so the wearer sees where to look.
    const first = step.part_ids.find((id) => td.parts.some((x) => x.id === id));
    if (first) useStore.getState().highlightPart(first);
    // Kash's arm opens for its tour (as his tour did) and adds the layer, nerves, typing roles and clinical note.
    const arm = isArmTeardown(td);
    if (arm && useStore.getState().explodeAmount < 0.5) useStore.getState().setExplode(1);
    return json({
      ok: true,
      step: step.n,
      of: td.steps.length,
      text: step.text,
      part_ids: step.part_ids,
      part_names: partNames(step.part_ids),
      ...(arm ? await armStepExtras(step.n) : {}),
      next: step.n < td.steps.length ? `Say this step in one sentence, then call show_step with n ${step.n + 1}.` : 'That was the last step.',
    });
  },

  async reset_view() {
    const saved = resetAll();
    return saved ? `Put away. Saved ${shortName(saved.name)}.` : 'View reset.';
  },

  async set_overlay(p) {
    const v = p?.['on'];
    const on =
      typeof v === 'boolean' ? v : typeof v === 'string' ? /^(true|on|yes|1)$/i.test(v.trim()) : true;
    useStore.getState().setOverlayOn(on);
    if (!on) resetAll();
    return on ? 'Overlay on. Objects in view are now labelled.' : 'Overlay off. Clean view.';
  },

  async rotate_model(p) {
    const s = useStore.getState();
    if (!s.teardown) return 'Nothing is on stage yet. Call explode first.';
    const dir = (str(p, 'direction') ?? 'right').toLowerCase();
    const deg = Math.min(360, Math.max(5, num(p, 'degrees') ?? (dir === 'around' || dir === 'flip' ? 180 : 45)));
    const rad = (deg * Math.PI) / 180;
    if (dir === 'left') s.rotateModel(-rad, 0);
    else if (dir === 'up') s.rotateModel(0, -rad);
    else if (dir === 'down') s.rotateModel(0, rad);
    else s.rotateModel(rad, 0); // right, around, flip
    return `Turned ${dir} by ${Math.round(deg)} degrees.`;
  },

  async get_pose() {
    const s = useStore.getState();
    const armOnStage = isArmTeardown(s.teardown);
    const ids = armOnStage ? ARM_MUSCLE_IDS : HAND_MUSCLE_IDS;
    const hands = s.hands.map((h) => describeHand(h, ids));
    // arm (Kash): { activity: "typing" | "none", confidence, active_parts: [{ part_id, intensity, role }], ... }
    const arm = await armPose();
    // While a face is tracked: per eye open / closed and where it looks (the person's own left and right), and a note.
    const eyes = describeEyes(live.faces, s.focusedObjectId, s.selectedObjectId);
    const eyeField = eyes ? { eyes } : {};
    if (hands.length === 0 && arm.activity !== 'typing') {
      return json({ hands: [], arm, ...eyeField, note: 'No hands in view. Ask the user to hold a hand in front of the camera.' });
    }
    const handLoaded = s.teardown?.anchor === 'hand';
    const active = hands.find((h) => h.muscles.length > 0);
    const muscles = active?.muscles ?? ids.flexors;
    return json({
      hands: hands.map((h) => ({ ...h, muscle_names: handLoaded ? partNames(h.muscles) : [] })),
      working_now: active ? partNames(active.muscles) : [],
      arm,
      ...eyeField,
      note:
        arm.activity === 'typing' && !armOnStage
          ? 'The arm is typing: answer from arm.active_parts, then call explode with object_id "arm-hand" and show_step 1 to 6.'
          : !handLoaded
            ? 'The hand layers are not shown yet. Call explode with no object_id while the user looks at their hand, then call highlight_part with the first muscle id.'
            : active
              ? `Call highlight_part with "${active.muscles[0]}", then name the muscles in working_now.`
              : `No finger is moving right now. Typing mainly uses ${partNames(muscles).join(', ') || 'the forearm flexors'}; highlight "${muscles[0]}" and ask the user to type.`,
    });
  },
};

/** Never throw into the SDK: the agent gets the error as text and can tell the user. */
export const clientTools = Object.fromEntries(
  (Object.keys(tools) as ClientToolName[]).map((name) => [
    name,
    async (params?: Params) => {
      try {
        return await tools[name](params);
      } catch (err) {
        console.error(`[voice] tool ${name} failed`, err);
        return `Error in ${name}: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  ]),
) as Record<ClientToolName, Tool>;
