/**
 * The ElevenLabs client tools (names from CLIENT_TOOL_NAMES in shared/teardown.ts).
 * Each takes the agent's parameters object and returns a short string for the agent.
 * In the ElevenLabs dashboard every tool must be set to "wait for response".
 * #96, short by default: every action tool (select_object, explode, reset_view, set_overlay, rotate_model,
 * adjust_view) returns JSON whose `say` is the exact line to speak, and nothing that asks for more. What to do only when
 * the user asks to be taught or toured is in `if_asked`; highlight_part and show_step are the teaching tools.
 */
import { MODEL_ZOOM_MAX, MODEL_ZOOM_MIN, useStore, type FingerName, type HandState } from '../state/store';
import type { ClientToolName, Teardown, TeardownPart } from '../../shared/teardown';
import { explodeObject, resetAll, resolveSavedObjectId } from '../lib/flow';
// #97: saved models ("put it away" keeps them; explode with a saved id or name brings one back)
import { describeSaved } from '../lib/saved';
import { displayName, shortName } from '../hud/names';
import { armPose } from '../biology/arm/tour';
import { startArmLive } from '../biology/arm/armLive';
import { ARM_MUSCLE_IDS, armLayerNames, armPartExtras, armStepExtras, isArmTeardown, resolveObjectId } from '../stage/armTeardown';
// Kash's eye (#94): object_id "eye" means an eye in view (or the stored eye when none is); get_pose adds `eyes`.
import { isEyeTeardown, resolveEyeObjectId } from '../stage/eyeTeardown';
import { describeEyes } from '../detect/faceTracker';
import { live } from '../detect/live';
// #107 / #109: voice turns keep a flat model off edge-on, as the hands and the mouse do.
import { voiceTurn } from '../stage/turnLimit';
// ?detail=1 only: show_detail / detail_step / close_detail (without the flag they answer DETAIL_UNAVAILABLE and do nothing)
import { DETAIL_ON, closeDetail, openDetail, setDetailStep } from '../lib/detail';
// ...and while a detail model is up, rotate_model and adjust_view turn, zoom and move it instead of the main model
import { DETAIL_ZOOM_MAX, DETAIL_ZOOM_MIN, centreDetail, detailInputActive, detailViewTarget, panDetail, setDetailZoom, voiceTurnDetail, zoomDetail } from '../stage/detailView';

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

/** Up to three parts for a tour when the user asks for one (#96): the two outermost, then one with a safety note (e.g. the battery). */
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

/**
 * The detail tools' answer without `?detail=1`: nothing to say, so a view without the flag never speaks about
 * detail models even if the agent has the tools; the agent does what it would have done without them.
 */
const DETAIL_UNAVAILABLE = json({
  ok: false,
  unavailable: true,
  present: 'Detail models are off in this view. Do what you would have done without this tool (explode, highlight_part or show_step) and do not mention detail models.',
});

/** How the agent presents a detail model (show_detail's `present`). */
const DETAIL_PRESENT =
  'Say the summary in one sentence, then for each step call detail_step with n 1, 2 and so on and say that step in one short sentence. Stop after the last step.';

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
      // ?detail=1 only (the reply is unchanged without it)
      ...(DETAIL_ON
        ? {
            detail: s.detail
              ? { title: s.detail.title, steps: s.detail.steps.length, step: s.detailStep, source: s.detail.source === 'sample' ? 'Sample (test fixture)' : 'AI sketch' }
              : s.detailStatus === 'loading'
                ? { loading: s.detailTopic }
                : null,
          }
        : {}),
    });
  },

  async select_object(p) {
    const s = useStore.getState();
    const id = str(p, 'object_id') ?? s.focusedObjectId;
    const obj = id ? s.objects.find((o) => o.id === id) : undefined;
    if (!obj) return json({ ok: false, say: 'I cannot see that.', note: 'Use an object id from get_scene.' });
    s.selectObject(obj.id);
    return json({ ok: true, say: `Selected ${displayName(obj)}.`, object_id: obj.id });
  },

  async explode(p) {
    const amount = num(p, 'amount');
    const s = useStore.getState();
    // "arm-hand" (Kash's arm) means the hand in view: the arm is how a hand is shown on stage.
    const asked = str(p, 'object_id');
    const resolved = asked === undefined ? undefined : resolveEyeObjectId(asked, s) ?? resolveObjectId(asked, s);
    // #97: not in view (or not a scene id): a saved model with that id or name, brought back
    const objectId = asked !== undefined && (resolved === null || resolved === asked) ? resolveSavedObjectId(asked, s) ?? resolved : resolved;
    if (objectId === null) return json({ ok: false, say: 'No hand in view. Hold a hand in front of the camera.' });
    if (amount !== undefined && amount <= 0) {
      s.setExplode(0);
      return json({ ok: true, say: 'Closed.' });
    }
    // Teardown already loaded and no other object asked for: just change the spread.
    if (s.teardown && (!objectId || objectId === s.selectedObjectId) && amount !== undefined) {
      const before = s.explodeAmount;
      s.setExplode(amount);
      const name = shortName(s.teardown.name);
      const say = amount >= 0.5 ? `${name} exploded.` : before > amount + 0.01 ? 'Put back together.' : `${name} analysed.`;
      return json({ ok: true, say, explode_amount: round(Math.min(1, amount)) });
    }
    const result = await explodeObject(objectId);
    if (result.ok && amount !== undefined) useStore.getState().setExplode(amount);
    const td = useStore.getState().teardown;
    if (!result.ok || !td) return json({ ok: false, say: result.message });
    const tour = tourParts(td);
    const arm = isArmTeardown(td);
    const eye = isEyeTeardown(td);
    const opened = useStore.getState().explodeAmount >= 0.5 ? 'exploded' : 'analysed';
    return json({
      ok: true,
      // The whole spoken reply (#96). A live parts list says once that it is AI-estimated.
      say: `${shortName(td.name)} ${opened}.${td.source === 'live' ? ' Parts are AI-estimated.' : ''}`,
      name: td.name,
      source: td.source,
      part_ids: td.parts.map((x) => x.id),
      // Kash's arm: its layers (0 = skin) and its guided tour
      ...(arm ? { layers: await armLayerNames(), steps: td.steps.length } : {}),
      // Kash's eye: its steps are the path of light, offered instead of a part tour
      ...(eye ? { steps: td.steps.length, steps_are: 'the path of light, from the cornea to the optic nerve' } : {}),
      ...(eye ? {} : { tour: tour.map((x) => ({ id: x.id, name: x.name, summary: x.summary, safety: x.safety ?? null })) }),
      // Only on request (#96): never a cue to start talking.
      if_asked: arm
        ? `Only if the user asks how it works, or to be taught or walked through: call show_step with n 1, then 2, up to ${td.steps.length}, one short sentence each.`
        : eye
          ? `Only if the user asks how the eye works, how it focuses or how light gets in: call show_step with n 1, then 2, up to ${td.steps.length}, one short sentence each (the path of light).`
          : `Only if the user asks for a tour or to be taught: for each part in tour, call highlight_part, then say one short sentence and its safety note.`,
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
      present: `Two or three short sentences from summary and details (one in a tour)${part.safety ? ', and say the safety note' : ''}.`,
    });
  },

  async show_step(p) {
    const n = num(p, 'n');
    const td = useStore.getState().teardown;
    if (!td) return 'Nothing is exploded yet. Call explode first.';
    if (n === undefined) return 'n is required.';
    const step = td.steps.find((x) => x.n === Math.round(n));
    // A live model sketched a moment ago (#124) has no steps until its details arrive in the background.
    if (!step && td.steps.length === 0) return 'The steps for this are still being worked out. Say that in a few words and offer to describe the parts instead.';
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
      present:
        step.n < td.steps.length
          ? `Say this step in one short sentence. If you are walking through the steps, call show_step with n ${step.n + 1} next.`
          : 'Say this step in one short sentence. That was the last step: stop.',
    });
  },

  async reset_view() {
    const saved = resetAll();
    return json(
      saved
        ? { ok: true, say: `Put away. Saved ${shortName(saved.name)}.`, saved: { id: saved.id, name: saved.name } }
        : { ok: true, say: 'View reset.' },
    );
  },

  async set_overlay(p) {
    const v = p?.['on'];
    const on =
      typeof v === 'boolean' ? v : typeof v === 'string' ? /^(true|on|yes|1)$/i.test(v.trim()) : true;
    useStore.getState().setOverlayOn(on);
    if (on) return json({ ok: true, say: 'Labels on.' });
    const saved = resetAll();
    return json({ ok: true, say: 'Labels off.', ...(saved ? { saved: { id: saved.id, name: saved.name } } : {}) });
  },

  async rotate_model(p) {
    const s = useStore.getState();
    const det = detailInputActive(s);
    if (!s.teardown && !det) return json({ ok: false, say: 'Nothing is open yet.' });
    const dir = (str(p, 'direction') ?? 'right').toLowerCase();
    const deg = Math.min(360, Math.max(5, num(p, 'degrees') ?? (dir === 'around' || dir === 'flip' ? 180 : 45)));
    const rad = (deg * Math.PI) / 180;
    // left / up / down; anything else (right, around, flip) turns right. A flat model stops at its limit.
    const limited = det ? voiceTurnDetail(dir, rad) : voiceTurn(dir, rad);
    const way = dir === 'around' || dir === 'flip' ? 'around' : ['left', 'up', 'down'].includes(dir) ? dir : 'right';
    return json({ ok: true, say: limited ? 'That is as far as it turns.' : `Turned ${way}.`, degrees: Math.round(deg) });
  },

  // The view of the model, not the model: "zoom in / out", "move it left / right / up / down",
  // "recentre" (middle of the view, normal size, facing the front), "normal size". Replaces zoom_model.
  async adjust_view(p) {
    const s = useStore.getState();
    // (a detail model up: its view instead, src/stage/detailView.ts)
    const det = detailInputActive(s);
    if (!s.teardown && !det) return json({ ok: false, say: 'Nothing is open yet.' });
    const a = (str(p, 'action') ?? str(p, 'direction') ?? 'centre').toLowerCase().replace(/[\s-]+/g, '_');
    const amount = num(p, 'amount') ?? num(p, 'factor');
    if (/^(normal|reset_zoom|zoom_reset|original|default)/.test(a)) {
      if (det) setDetailZoom(1);
      else s.setModelZoom(1);
      return json({ ok: true, say: 'Back to normal size.', zoom: 1 });
    }
    if (/^(centre|center|recentre|recenter|reset|middle|home|back)/.test(a)) {
      if (det) {
        centreDetail();
        return json({ ok: true, say: 'Back in the middle.' });
      }
      s.centreModel();
      s.setModelZoom(1);
      // Facing the front again, by the short way round (yaw adds up over many turns).
      const turn = Math.PI * 2;
      const dYaw = -(s.modelYaw - Math.round(s.modelYaw / turn) * turn);
      if (Math.abs(dYaw) > 1e-3 || Math.abs(s.modelPitch) > 1e-3) s.rotateModel(dYaw, -s.modelPitch);
      return json({ ok: true, say: 'Back in the middle.' });
    }
    const zoomIn = /^(zoom_in|in|closer|bigger|larger|enlarge|magnify)/.test(a);
    const zoomOut = /^(zoom_out|out|further|smaller|shrink)/.test(a);
    if (zoomIn || zoomOut) {
      // A factor below 1 means the same step the other way ("in" by 0.5 = twice as big).
      const raw = amount ?? 1.5;
      const f = Math.min(8, Math.max(1.05, raw >= 1 ? raw : raw > 0 ? 1 / raw : 1.5));
      const before = det ? detailViewTarget().zoom : s.modelZoom;
      if (zoomIn && before >= (det ? DETAIL_ZOOM_MAX : MODEL_ZOOM_MAX) - 1e-3) return json({ ok: true, say: 'That is as close as it goes.', zoom: round(before) });
      if (zoomOut && before <= (det ? DETAIL_ZOOM_MIN : MODEL_ZOOM_MIN) + 1e-3) return json({ ok: true, say: 'That is as far out as it goes.', zoom: round(before) });
      if (det) zoomDetail(zoomOut ? 1 / f : f);
      else s.zoomModel(zoomOut ? 1 / f : f);
      return json({ ok: true, say: zoomOut ? 'Zoomed out.' : 'Zoomed in.', zoom: round(det ? detailViewTarget().zoom : useStore.getState().modelZoom) });
    }
    const m = a.match(/(left|right|up|down)/);
    if (m) {
      // How far, in model sizes (default half the model's width).
      const d = Math.min(2, Math.max(0.05, amount ?? 0.5));
      const dx = m[1] === 'left' ? -d : m[1] === 'right' ? d : 0;
      const dy = m[1] === 'up' ? -d : m[1] === 'down' ? d : 0;
      if (det) return json(panDetail(dx, dy) ? { ok: true, say: `Moved ${m[1]}.` } : { ok: true, say: 'That is as far as it goes.' });
      const x0 = s.modelPanX;
      const y0 = s.modelPanY;
      s.panModel(dx, dy);
      const n = useStore.getState();
      if (Math.abs(n.modelPanX - x0) + Math.abs(n.modelPanY - y0) < 1e-3) return json({ ok: true, say: 'That is as far as it goes.' });
      return json({ ok: true, say: `Moved ${m[1]}.` });
    }
    return json({ ok: false, say: 'I can zoom in or out, move it left, right, up or down, or put it back in the middle.' });
  },

  // ?detail=1: "show me how the ... works", "what is the ... made of", "how is this made", "model the ...":
  // a schematic model of that mechanism, material or process beside the model on stage (src/lib/detail.ts).
  async show_detail(p) {
    if (!DETAIL_ON) return DETAIL_UNAVAILABLE;
    const topic = str(p, 'topic');
    if (!topic) return 'topic is required: a few words saying what to model.';
    const td = useStore.getState().teardown;
    const partQ = str(p, 'part_id');
    const part = partQ && td ? findPart(partQ) : null;
    const res = await openDetail(topic, {
      object: td ? shortName(td.name) : undefined,
      part: part ? part.name : partQ?.replace(/-/g, ' '),
      context: part ? part.summary : undefined,
    });
    // a newer show_detail (or close, or put away) took over while this one was built: nothing to say
    if (!res.ok) return json(res.superseded ? { ok: false, superseded: true } : { ok: false, say: res.say });
    const sc = res.scene;
    return json({
      ok: true,
      // AI-made, never checked: the spoken line says so once (the ?detail=mock fixture is a "Sample:", not generated)
      say: sc.source === 'sample' ? `${sc.title}.` : `${sc.title}. AI sketch.`,
      summary: sc.summary,
      steps: sc.steps.map((x) => x.say),
      ...(sc.caveat ? { caveat: sc.caveat } : {}),
      present: DETAIL_PRESENT,
    });
  },

  async detail_step(p) {
    if (!DETAIL_ON) return DETAIL_UNAVAILABLE;
    const sc = useStore.getState().detail;
    if (!sc) return json({ ok: false, say: 'No detail model is open.' });
    const n = num(p, 'n');
    if (n === undefined) return 'n is required.';
    const k = Math.round(n);
    if (!setDetailStep(k)) return `No step ${k}. There are ${sc.steps.length} steps.`;
    const st = sc.steps[k - 1];
    return json({
      ok: true,
      step: k,
      of: sc.steps.length,
      say: st.say,
      focus: st.focus.map((id) => sc.parts.find((x) => x.id === id)?.name).filter((x): x is string => Boolean(x)),
      present: k < sc.steps.length ? `Say this step in one short sentence, then call detail_step with n ${k + 1}.` : 'Say this step in one short sentence. That was the last step: stop.',
    });
  },

  async close_detail() {
    if (!DETAIL_ON) return DETAIL_UNAVAILABLE;
    const s = useStore.getState();
    if (!s.detail && s.detailStatus === 'idle') return json({ ok: true, say: 'Nothing to close.' });
    closeDetail();
    const td = useStore.getState().teardown;
    return json({ ok: true, say: td ? `Back to the ${shortName(td.name)}.` : 'Closed.' });
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
          ? 'The arm is typing: answer from arm.active_parts in one or two short sentences. Only if the user asks to see it or how it works: call explode with object_id "arm-hand", then show_step 1 to 6.'
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

/**
 * zoom_model (#109) was replaced by adjust_view before it reached the dashboard; an agent that still
 * has it keeps working (registered with the SDK, not in CLIENT_TOOL_NAMES).
 */
export const legacyClientTools: Record<string, Tool> = {
  zoom_model: (params?: Params) => {
    const d = (str(params, 'direction') ?? 'in').toLowerCase();
    const action = /^(reset|normal|back|default|original)/.test(d) ? 'normal_size' : /^(out|smaller|further|away|less)/.test(d) ? 'zoom_out' : 'zoom_in';
    return clientTools.adjust_view({ action, amount: num(params, 'factor') });
  },
};
