import type { Request, Response } from 'express';
import { DetailRequestSchema } from '../../shared/detail';
import { DetailError, DETAIL_SAY, getDetail } from '../lib/detail';

/**
 * POST /api/detail { topic, object?, part?, context? } (`?detail=1` in the app) -> a DetailScene (shared/detail.ts)
 * plus `cached` ("memory" | "disk" | "premade", or absent when made just now) and `seconds`.
 * Kept in memory and in .cache-live/detail/, so a repeat is instant (server/lib/detail.ts).
 * Failures answer with one sentence the tutor can say in `message`: 503 (no key and nothing kept, `mock: true`),
 * 504 (too slow), 502 (anything else).
 */
export async function detail(req: Request, res: Response) {
  const parsed = DetailRequestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid body', message: 'Say what to model.', issues: parsed.error.issues });
  const ask = parsed.data;
  try {
    const hit = await getDetail(ask);
    console.info(
      `[detail] ${hit.key} ${hit.from === 'claude' ? 'made' : `from ${hit.from}`} in ${hit.seconds} s (${hit.scene.parts.length} parts, ${hit.scene.animations.length} animations)`,
    );
    return res.json({ ...hit.scene, ...(hit.from === 'claude' ? {} : { cached: hit.from }), seconds: hit.seconds });
  } catch (err) {
    if (err instanceof DetailError) {
      console.warn(`[detail] "${ask.topic}" ${err.kind}: ${err.message}`);
      const status = err.kind === 'noKey' ? 503 : err.kind === 'slow' ? 504 : 502;
      return res.status(status).json({ error: err.kind, message: err.say, ...(err.kind === 'noKey' ? { mock: true } : {}) });
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[detail] "${ask.topic}" failed:`, message);
    return res.status(502).json({ error: 'failed', message: DETAIL_SAY.failed });
  }
}
