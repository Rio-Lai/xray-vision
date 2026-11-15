import type { Request, Response } from 'express';
import { EnrichRequestSchema, mergeEnrichment } from '../../shared/sketch';
import { hasAnthropic } from '../lib/env';
import { readLiveSketch, safeId, writeLiveSketch } from '../lib/cache';
import { enrichLive } from '../lib/claude';

/**
 * POST /api/enrich { object_id, name, parts: [{ id, name, summary? }] } (#124) -> { parts: [{ id, details, safety }],
 * steps: [{ n, text, part_ids }] } for exactly those ids, at the normal parts-list effort. Merged into the kept
 * sketch on disk too, so the next look at the same thing comes with its details. 404 { mock: true } with no
 * key; 502 with a message on failure (the client keeps the one-sentence summaries).
 */
export async function enrich(req: Request, res: Response) {
  const parsed = EnrichRequestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid body', issues: parsed.error.issues });
  if (!hasAnthropic()) return res.status(404).json({ error: 'No ANTHROPIC_API_KEY (mock mode).', mock: true });
  const id = safeId(parsed.data.object_id);
  const started = Date.now();
  const secs = () => ((Date.now() - started) / 1000).toFixed(1);
  try {
    const out = await enrichLive({ ...parsed.data, object_id: id });
    console.info(`[enrich] ${id} (${out.parts.length} parts, ${out.steps.length} steps) in ${secs()} s`);
    const kept = readLiveSketch(id);
    if (kept) writeLiveSketch(mergeEnrichment(kept, out));
    return res.json(out);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[enrich] ${id} failed after ${secs()} s:`, message);
    return res.status(502).json({ error: 'The details could not be written.', message: 'The details could not be written.' });
  }
}
