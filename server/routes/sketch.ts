import type { Request, Response } from 'express';
import { SketchRequestSchema } from '../../shared/sketch';
import { isEyeHint } from '../../shared/demo';
import { hasAnthropic } from '../lib/env';
import { listCheckedObjects, readCheckedTeardown, readLiveSketch, safeId, writeLiveSketch } from '../lib/cache';
import { sketchLive } from '../lib/claude';

/**
 * POST /api/sketch { image, hint?, object_id?, lens? } (#124): one look at an object that is not stored ->
 * a solid parts list (Teardown, layout "solid", plus confidence and summary) in a few seconds.
 * Other answers: { checked: true, object_id, name } (a stored list: open that), { unknown: true } (nothing
 * clear), { mock: true } (no key), { shortcut: true } (a hand or an eye: never sketched), and on any
 * failure or time-out { fallback: true, error } (the client then goes the old way: identify, then teardown).
 */
export async function sketch(req: Request, res: Response) {
  const parsed = SketchRequestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid body', issues: parsed.error.issues });
  const { image, hint, object_id, lens } = parsed.data;

  // A hand or an eye always opens its stored list; a picture of a face is never sent to Claude (#94).
  if (/\bhands?\b/i.test(hint ?? '') || isEyeHint(hint)) return res.json({ shortcut: true });

  // Something already named: its checked list, or the sketch kept from last time, answers at once.
  if (object_id) {
    const id = safeId(object_id);
    const checked = readCheckedTeardown(id);
    if (checked) return res.json({ checked: true, object_id: checked.object_id, name: checked.name, confidence: 1 });
    const kept = readLiveSketch(id);
    if (kept) {
      console.info(`[sketch] ${id} from .cache-live (no Claude call)`);
      return res.json({ ...kept, confidence: 1, summary: '', cached: true });
    }
  }

  if (!hasAnthropic()) return res.json({ mock: true });

  const started = Date.now();
  const secs = () => ((Date.now() - started) / 1000).toFixed(1);
  try {
    const checkedIds = listCheckedObjects().map((o) => o.object_id);
    const out = await sketchLive({ image, hint, object_id, lens }, checkedIds);
    if (out.kind === 'checked') {
      console.info(`[sketch] ${out.object_id} is a checked object in ${secs()} s`);
      return res.json({ checked: true, object_id: out.object_id, name: out.name, confidence: out.confidence });
    }
    if (out.kind === 'unknown') {
      console.info(`[sketch] nothing clear (${out.object_id}) in ${secs()} s`);
      return res.json({ unknown: true, object_id: out.object_id, name: out.name, confidence: out.confidence });
    }
    if (out.kind === 'empty') {
      console.warn(`[sketch] nothing usable in ${secs()} s: ${out.reason}`);
      return res.json({ fallback: true, error: out.reason });
    }
    // A stored sketch for the same id is replaced (the newer look wins).
    const prev = readLiveSketch(out.td.object_id);
    const td = prev && prev.steps.length > 0 && sameParts(prev, out.td) ? prev : out.td;
    if (td === out.td) writeLiveSketch(td);
    console.info(
      `[sketch] ${td.object_id} (${td.parts.length} parts${out.dropped ? `, ${out.dropped} dropped` : ''}${out.settled ? `, ${out.settled} settled` : ''}) in ${secs()} s`,
    );
    return res.json({ ...td, confidence: out.confidence, summary: out.summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[sketch] failed after ${secs()} s, the client goes the old way:`, message);
    return res.json({ fallback: true, error: message });
  }
}

/** Same part ids in the same order: an earlier sketch with its details is kept rather than replaced. */
function sameParts(a: { parts: { id: string }[] }, b: { parts: { id: string }[] }): boolean {
  return a.parts.length === b.parts.length && a.parts.every((p, i) => p.id === b.parts[i].id);
}
