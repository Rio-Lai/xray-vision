/**
 * The arm's actions, shared by the voice tools (src/voice/clientTools.ts) and the /arm-demo buttons,
 * so "What muscles is this arm using?" runs the same flow either way:
 *   armPose() -> armExplode() -> armShowStep(1..6) -> armReset()
 */
import { useArmStore } from './armStore';
import { loadArmTeardown, type ArmTeardown } from './types';

let td: ArmTeardown | null = null;
loadArmTeardown()
  .then((t) => (td = t))
  .catch(() => undefined);

async function teardown(): Promise<ArmTeardown> {
  td ??= await loadArmTeardown();
  return td;
}

/** Typing roles as part id -> intensity. */
function typingGlow(t: ArmTeardown, onlyLayer?: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of t.activities.typing?.roles ?? []) {
    const part = t.parts.find((p) => p.id === r.part_id);
    if (!part || (onlyLayer !== undefined && part.layer !== onlyLayer)) continue;
    out[r.part_id] = r.intensity;
  }
  return out;
}

/** What get_pose reports for the arm. */
export async function armPose() {
  const s = useArmStore.getState();
  const t = await teardown();
  const typing = s.activity === 'typing';
  const roles = typing ? (t.activities.typing?.roles ?? []) : [];
  return {
    activity: s.activity,
    confidence: s.confidence,
    active_parts: roles.map((r) => ({ part_id: r.part_id, intensity: r.intensity, role: r.role })),
    summary: typing ? t.activities.typing.summary : null,
    nerves_involved: typing ? t.activities.typing.nerves_involved : [],
    clinical_note: typing ? t.activities.typing.clinical_note : null,
    tracking: s.frame ? 'ok' : 'no arm in view',
    next: typing ? 'Call explode with object_id "arm-hand", then show_step 1 to 6.' : 'Ask them to type for a moment, then call get_pose again.',
  };
}

/** Explode the arm (amount 0 collapses). Turns the arm on so the voice tools drive it. */
export async function armExplode(amount = 1) {
  const s = useArmStore.getState();
  const t = await teardown();
  s.setActive(true);
  s.setExplode(amount);
  if (amount > 0 && s.activity === 'typing') s.setHighlight(typingGlow(t));
  if (amount <= 0) s.reset();
  return {
    ok: true,
    message: amount > 0 ? `Exploded ${t.name} into ${Object.keys(t.layers_legend).length} layers.` : 'Collapsed the arm.',
    layers: t.layers_legend,
    part_ids: t.parts.map((p) => p.id),
    steps: t.steps.length,
  };
}

/** Tour step n (1-6): focus its layer, glow its parts and the typing parts on that layer. */
export async function armShowStep(n: number) {
  const s = useArmStore.getState();
  const t = await teardown();
  const step = t.steps.find((x) => x.n === Math.round(n));
  if (!step) return { ok: false, message: `No step ${n}. There are ${t.steps.length} steps.` };
  s.setActive(true);
  if (s.explode < 0.99) s.setExplode(1);
  s.setLayerFocus(step.layer_focus);
  s.setStep(step.n);
  const glow: Record<string, number> = { ...typingGlow(t, step.layer_focus) };
  for (const id of step.part_ids) glow[id] = Math.max(glow[id] ?? 0, 0.85);
  s.setHighlight(glow);
  const parts = step.part_ids.map((id) => t.parts.find((p) => p.id === id)).filter(Boolean);
  const roles = t.activities.typing?.roles.filter((r) => step.part_ids.includes(r.part_id)) ?? [];
  return {
    ok: true,
    step: step.n,
    of: t.steps.length,
    layer: t.layers_legend[String(step.layer_focus)],
    text: step.text,
    part_ids: step.part_ids,
    parts: parts.map((p) => ({ id: p!.id, name: p!.name, summary: p!.summary, nerve: p!.nerve || null, safety: p!.safety || null })),
    typing_roles: roles,
    clinical_note: step.n === t.steps.length ? t.activities.typing?.clinical_note : undefined,
  };
}

/** Highlight one part (exact id or loose name). */
export async function armHighlight(query: string) {
  const s = useArmStore.getState();
  const t = await teardown();
  const q = query.toLowerCase();
  const part =
    t.parts.find((p) => p.id === q) ?? t.parts.find((p) => p.name.toLowerCase().includes(q) || q.includes(p.id.replace(/-/g, ' ')));
  if (!part) return { ok: false, message: `Unknown part "${query}". Valid ids: ${t.parts.map((p) => p.id).join(', ')}` };
  s.setActive(true);
  if (s.explode < 0.5) s.setExplode(1);
  s.setLayerFocus(part.layer);
  s.setHighlight({ [part.id]: 1 });
  const role = t.activities.typing?.roles.find((r) => r.part_id === part.id);
  return { ok: true, part: { id: part.id, name: part.name, summary: part.summary, details: part.details, nerve: part.nerve || null, safety: part.safety || null, typing_role: role?.role ?? null } };
}

/** Collapse back onto the arm. */
export function armReset() {
  useArmStore.getState().reset();
  return 'Arm collapsed back onto the real arm.';
}

/** Leave the arm (other objects get the voice tools back). */
export function armOff() {
  const s = useArmStore.getState();
  s.reset();
  s.setActive(false);
}
