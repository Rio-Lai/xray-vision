import type { Request, Response } from 'express';
import { TeardownRequestSchema } from '../../shared/teardown';
import { hasAnthropic } from '../lib/env';
import { readCheckedTeardown, readLiveTeardown, safeId, writeLiveTeardown } from '../lib/cache';
import { TEARDOWN_FAIL_MESSAGE, teardownLive } from '../lib/claude';

/** POST /api/teardown { object_id, name, lens (hint only) } -> Teardown. Cache-first, always. 502 + a sayable message if Claude fails. */
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

  // `lens` is only a hint; Claude sets the parts list's lens itself.
  const started = Date.now();
  try {
    const td = await teardownLive({ object_id: objectId, name, lens });
    console.info(`[teardown] live ${objectId} (${td.parts.length} parts) in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    writeLiveTeardown(td);
    return res.json(td);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[teardown] live ${objectId} failed after ${((Date.now() - started) / 1000).toFixed(1)} s:`, detail);
    // One short sentence the tutor can say; the detail stays in the server log.
    const message = TEARDOWN_FAIL_MESSAGE(name);
    return res.status(502).json({ error: message, message });
  }
}
