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
  // #109: zoom (before "reset": "reset zoom" is a zoom)
  if (/\b(normal size|reset zoom|zoom reset)\b/.test(t)) return sayOf(await clientTools.zoom_model({ direction: 'reset' }));
  if (/\b(zoom in|bigger|closer)\b/.test(t)) return sayOf(await clientTools.zoom_model({ direction: 'in' }));
  if (/\b(zoom out|smaller)\b/.test(t)) return sayOf(await clientTools.zoom_model({ direction: 'out' }));
  if (/\b(explode|x-?ray|open it|inside)\b/.test(t)) return (await explodeObject()).message;
  if (/\b(collapse|close it)\b/.test(t)) {
    s.setExplode(0);
    return 'Collapsed.';
  }
  if (/\b(reset|clear)\b/.test(t)) {
    resetAll();
    return 'View reset.';
  }
  const overlay = t.match(/\boverlay\s+(on|off)\b/);
  if (overlay) return sayOf(await clientTools.set_overlay({ on: overlay[1] === 'on' }));
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

/** An action tool's reply is JSON with the line to show in `say` (#96). */
function sayOf(out: string): string {
  try {
    const say = (JSON.parse(out) as { say?: unknown }).say;
    return typeof say === 'string' ? say : out;
  } catch {
    return out;
  }
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
