import type { Request, Response } from 'express';
import { TeardownRequestSchema } from '../../shared/teardown';
import { hasAnthropic } from '../lib/env';
import { readCheckedTeardown, readLiveTeardown, safeId, writeLiveTeardown } from '../lib/cache';
import { teardownLive } from '../lib/claude';

/** POST /api/teardown { object_id, name, lens } -> Teardown. Cache-first, always. */
export async function teardown(req: Request, res: Response) {
  const parsed = TeardownRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid body', issues: parsed.error.issues });
  }
  const objectId = safeId(parsed.data.object_id);
  const { name, lens } = parsed.data;

  const checked = readCheckedTeardown(objectId);
  if (checked) return res.json(checked);

  const live = readLiveTeardown(objectId);
  if (live) return res.json(live);

  if (!hasAnthropic()) {
    return res.status(404).json({
      error: `No cached teardown for "${objectId}" and no ANTHROPIC_API_KEY (mock mode).`,
      mock: true,
    });
  }

  const td = await teardownLive({ object_id: objectId, name, lens });
  writeLiveTeardown(td);
  return res.json(td);
}
