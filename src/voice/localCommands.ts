/**
 * Typed-command fallback for when voice is off or the room is too loud.
 * Handles a few phrases locally; anything else returns null.
 */
import { useStore } from '../state/store';
import { explodeObject, resetAll } from '../lib/flow';
import { clientTools } from './clientTools';

export async function runLocalCommand(input: string): Promise<string | null> {
  const t = input.toLowerCase().trim();
  const s = useStore.getState();

  const step = t.match(/step\s*(\d+)/);
  if (step) {
    const out = await clientTools.show_step({ n: Number(step[1]) });
    try {
      return JSON.parse(out).text as string;
    } catch {
      return out;
    }
  }
  if (/\b(explode|x-?ray|open it|inside)\b/.test(t)) return (await explodeObject()).message;
  if (/\b(collapse|close it)\b/.test(t)) {
    s.setExplode(0);
    return 'Collapsed.';
  }
  if (/\b(reset|clear)\b/.test(t)) {
    resetAll();
    return 'View reset.';
  }
  const lens = t.match(/\b(biology|engineering)\b/);
  if (lens && (/\b(lens|mode|switch)\b/.test(t) || t.split(/\s+/).length <= 2)) {
    s.setLens(lens[1] as 'biology' | 'engineering');
    return `Lens set to ${lens[1]}.`;
  }
  if (/muscle/.test(t) && /\b(which|what)\b/.test(t)) {
    const pose = JSON.parse(await clientTools.get_pose()) as { hands: { muscles: string[] }[] };
    const id = pose.hands.find((h) => h.muscles.length > 0)?.muscles[0];
    if (!id) return 'No finger is moving right now.';
    if (!useStore.getState().teardown) await explodeObject();
    return highlight(id);
  }
  const ask = t.match(/^(?:highlight|show(?: me)?|what is|what's|tell me about)\s+(?:the\s+)?(.+?)\??$/);
  if (ask) return highlight(ask[1]);
  return null;
}

async function highlight(query: string): Promise<string> {
  const out = await clientTools.highlight_part({ part_id: query });
  try {
    const p = JSON.parse(out).part as { name: string; summary: string; safety: string | null };
    return `${p.name}: ${p.summary}${p.safety ? ` Safety: ${p.safety}` : ''}`;
  } catch {
    return out;
  }
}
