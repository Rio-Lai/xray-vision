/**
 * Typed-command fallback for when voice is off or the room is too loud.
 * Handles a few phrases locally; anything else returns null.
 */
import { useStore } from '../state/store';
import { explodeObject, resetAll } from '../lib/flow';
import { DETAIL_ON } from '../lib/detail';
import { clientTools } from './clientTools';

export async function runLocalCommand(input: string): Promise<string | null> {
  const t = input.toLowerCase().trim();

  // ?detail=1 only (without it these phrases mean what they always did): "detail <topic>",
  // "detail step 2", "close detail" / "back to the model". First, as "detail ... inside" would explode.
  if (DETAIL_ON) {
    if (/^(close (the )?detail|detail off|back to the model)\b/.test(t)) return sayOf(await clientTools.close_detail());
    const dstep = t.match(/^detail\s+step\s*(\d+)/);
    if (dstep) return sayOf(await clientTools.detail_step({ n: Number(dstep[1]) }));
    const detail = input.trim().match(/^detail\s+(?:of\s+|on\s+)?(.+)$/i);
    if (detail) {
      const out = await clientTools.show_detail({ topic: detail[1] });
      try {
        const r = JSON.parse(out) as { say?: string; summary?: string };
        return [r.say, r.summary].filter(Boolean).join(' ') || out;
      } catch {
        return out;
      }
    }
  }

  const step = t.match(/step\s*(\d+)/);
  if (step) {
    const out = await clientTools.show_step({ n: Number(step[1]) });
    try {
      return JSON.parse(out).text as string;
    } catch {
      return out;
    }
  }
  // The view (adjust_view): zoom, move, recentre (before "reset": "reset zoom" is a zoom)
  if (/\b(normal size|reset zoom|zoom reset)\b/.test(t)) return sayOf(await clientTools.adjust_view({ action: 'normal_size' }));
  if (/\b(zoom in|bigger|closer)\b/.test(t)) return sayOf(await clientTools.adjust_view({ action: 'zoom_in' }));
  if (/\b(zoom out|smaller)\b/.test(t)) return sayOf(await clientTools.adjust_view({ action: 'zoom_out' }));
  if (/\b(re-?cent(re|er)|cent(re|er) it|middle)\b/.test(t)) return sayOf(await clientTools.adjust_view({ action: 'centre' }));
  const move = t.match(/\bmove (it )?(left|right|up|down)\b/);
  if (move) return sayOf(await clientTools.adjust_view({ action: `move_${move[2]}` }));
  if (/\b(explode|x-?ray|open it|inside)\b/.test(t)) return (await explodeObject()).message;
  if (/\b(collapse|close it|put it back together)\b/.test(t)) {
    if (!useStore.getState().teardown) return 'Nothing is open yet.';
    return sayOf(await clientTools.explode({ amount: 0.12 }));
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
