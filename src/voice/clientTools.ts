/**
 * The eight ElevenLabs client tools (names from CLIENT_TOOL_NAMES in shared/teardown.ts).
 * Each takes the agent's parameters object and returns a short string for the agent.
 * In the ElevenLabs dashboard every tool must be set to "wait for response".
 */
import { useStore, type FingerName, type HandState } from '../state/store';
import { LensSchema, type ClientToolName } from '../../shared/teardown';
import { explodeObject, resetAll } from '../lib/flow';

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

export const clientTools: Record<ClientToolName, Tool> = {
  async get_scene() {
    const s = useStore.getState();
    return json({
      lens: s.lens,
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
    return result.message;
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
    return json({
      ok: true,
      part: { id: part.id, name: part.name, summary: part.summary, details: part.details, safety: part.safety ?? null },
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
    return json({ ok: true, step: step.n, of: td.steps.length, text: step.text, part_ids: step.part_ids });
  },

  async reset_view() {
    resetAll();
    return 'View reset.';
  },

  async set_lens(p) {
    const parsed = LensSchema.safeParse(str(p, 'lens'));
    if (!parsed.success) return 'lens must be "engineering" or "biology".';
    useStore.getState().setLens(parsed.data);
    return `Lens set to ${parsed.data}.`;
  },

  async get_pose() {
    const hands = useStore.getState().hands.map(describeHand);
    if (hands.length === 0) return json({ hands: [], note: 'No hands in view.' });
    return json({
      hands,
      note: 'muscles lists the part ids working right now; call highlight_part with the first one.',
    });
  },
};
