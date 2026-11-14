import type { Request, Response } from 'express';
import { IdentifyRequestSchema } from '../../shared/teardown';
import { mockIdentify } from '../../shared/demo';
import { hasAnthropic } from '../lib/env';
import { identifyLive } from '../lib/claude';

/** POST /api/identify { image, lens, hint? } -> IdentifyResponse (+ mock / fallback flags) */
export async function identify(req: Request, res: Response) {
  const parsed = IdentifyRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid body', issues: parsed.error.issues });
  }
  const { image, lens, hint } = parsed.data;

  // A hand in the biology lens is always the checked finger-muscles teardown; skip the vision call.
  if (lens === 'biology' && /hand/i.test(hint ?? '')) {
    return res.json({ ...mockIdentify(hint, lens), shortcut: true });
  }

  if (!hasAnthropic()) {
    return res.json({ ...mockIdentify(hint, lens), mock: true });
  }

  try {
    const result = await identifyLive({ image, lens, hint });
    return res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[identify] live call failed, using mock mapping:', message);
    return res.json({ ...mockIdentify(hint, lens), fallback: true, error: message });
  }
}
