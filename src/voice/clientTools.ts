/**
 * The ElevenLabs client tools (names from CLIENT_TOOL_NAMES in shared/teardown.ts).
 * Each takes the agent's parameters object and returns a short string for the agent.
 * In the ElevenLabs dashboard every tool must be set to "wait for response".
 */
import { useStore, type FingerName, type HandState } from '../state/store';
import type { ClientToolName, Teardown, TeardownPart } from '../../shared/teardown';
import { explodeObject, resetAll } from '../lib/flow';
import { useArmStore } from '../biology/arm/armStore';
import { armExplode, armHighlight, armOff, armPose, armReset, armShowStep } from '../biology/arm/tour';
import { startArmLive } from '../biology/arm/armLive';

// The X-ray arm (public/cache/arm-hand) is driven by the same tools: explode with object_id "arm-hand", then
// show_step / highlight_part / reset_view go to the arm while it is active. Live hands feed its typing detector.
startArmLive();
const ARM_ID = 'arm-hand';
const armActive = () => useArmStore.getState().active;

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

const FLEXORS = ['fdp', 'fds', 'flexor-tendons'];
const THUMB = ['fpl', 'thenar'];
const EXTENSORS = ['extensor-digitorum'];

function describeHand(h: HandState) {
  const active: FingerName | null = h.activeFinger;
  const pressing = active ? h.fingers[active]?.pressing === true : false;
  let action: 'pressing' | 'extending' | null = null;
  let muscles: string[] = [];
  if (active && pressing) {
    action = 'pressing';
    muscles = active === 'thumb' ? THUMB : FLEXORS;
  } else if (active) {
    action = 'extending';
    muscles = EXTENSORS;
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
    const objectId = str(p, 'object_id');
    if (objectId === ARM_ID || (!objectId && armActive())) return json(await armExplode(amount ?? 1));
    if (objectId && armActive()) armOff();
    const s = useStore.getState();
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
    return json({
      ok: true,
      message: result.message,
      source: td.source,
      part_ids: td.parts.map((x) => x.id),
      tour: tour.map((x) => ({ id: x.id, name: x.name, summary: x.summary, safety: x.safety ?? null })),
      next: `Give a short tour of these ${tour.length} parts in order: call highlight_part before you mention each one, one short sentence each, and say any safety note.${
        td.source === 'live' ? ' Say once that the parts are AI-estimated.' : ''
      }`,
    });
  },

  async highlight_part(p) {
    const q = str(p, 'part_id');
    if (!q) return 'part_id is required.';
    if (armActive()) return json(await armHighlight(q));
    if (!useStore.getState().teardown) return 'Nothing is exploded yet. Call explode first.';
    const part = findPart(q);
    if (!part) {
      const ids = useStore.getState().teardown!.parts.map((x) => x.id).join(', ');
      return `Unknown part "${q}". Valid ids: ${ids}`;
    }
    useStore.getState().highlightPart(part.id);
    return json({
      ok: true,
      part: { id: part.id, name: part.name, summary: part.summary, details: part.details, safety: part.safety ?? null },
      ...(part.safety ? { remember: 'Say the safety note.' } : {}),
    });
  },

  async show_step(p) {
    const n = num(p, 'n');
    if (armActive()) return n === undefined ? 'n is required.' : json(await armShowStep(n));
    const td = useStore.getState().teardown;
    if (!td) return 'Nothing is exploded yet. Call explode first.';
    if (n === undefined) return 'n is required.';
    const step = td.steps.find((x) => x.n === Math.round(n));
    if (!step) return `No step ${n}. There are ${td.steps.length} steps.`;
    useStore.getState().showStep(step.n);
    // Light up the part the step is about, so the wearer sees where to look.
    const first = step.part_ids.find((id) => td.parts.some((x) => x.id === id));
    if (first) useStore.getState().highlightPart(first);
    return json({
      ok: true,
      step: step.n,
      of: td.steps.length,
      text: step.text,
      part_ids: step.part_ids,
      part_names: partNames(step.part_ids),
      next: step.n < td.steps.length ? `Say this step in one sentence, then call show_step with n ${step.n + 1}.` : 'That was the last step.',
    });
  },

  async reset_view() {
    if (armActive()) return armReset();
    resetAll();
    return 'View reset.';
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
    const hands = s.hands.map(describeHand);
    // arm: { activity: "typing" | "none", confidence, active_parts: [{ part_id, intensity, role }], ... }
    const arm = await armPose();
    if (hands.length === 0 && arm.activity !== 'typing') {
      return json({ hands: [], arm, note: 'No hands in view. Ask the user to hold a hand in front of the camera.' });
    }
    const handLoaded = s.teardown?.anchor === 'hand';
    const active = hands.find((h) => h.muscles.length > 0);
    const muscles = active?.muscles ?? FLEXORS;
    return json({
      hands: hands.map((h) => ({ ...h, muscle_names: handLoaded ? partNames(h.muscles) : [] })),
      working_now: active ? partNames(active.muscles) : [],
      arm,
      note:
        arm.activity === 'typing'
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
