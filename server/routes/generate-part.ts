import type { Request, Response } from 'express';
import { GeneratePartRequestSchema } from '../../shared/teardown';
import { hasFal } from '../lib/env';
import { checkedMeshUrl, isProceduralObject, readMeshCache, safeId, writeMeshEntry, type MeshEntry } from '../lib/cache';
import { FalBalanceError, generateMesh, isBalanceError } from '../lib/fal';

/** One fal job per part at a time, even if the client asks twice. */
const inFlight = new Map<string, Promise<MeshEntry>>();

/** Set after fal says the balance is exhausted; no more fal jobs until the server restarts. */
let balanceExhausted = false;

/**
 * POST /api/generate-part { object_id, part_id, prompt } -> { image_url, mesh_url, cached } (+ mock)
 *
 * Order: checked GLB in public/cache/meshes/, then live results in .cache-live/meshes.json, then fal.
 * Live fal output stays in .cache-live/ (unreviewed); a human promotes good GLBs into public/cache/.
 */
export async function generatePart(req: Request, res: Response) {
  const parsed = GeneratePartRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid body', issues: parsed.error.issues });
  }
  const objectId = safeId(parsed.data.object_id);
  const partId = safeId(parsed.data.part_id);
  const key = `${objectId}/${partId}`;

  const checked = checkedMeshUrl(objectId, partId);
  if (checked) return res.json({ image_url: '', mesh_url: checked, cached: true });

  const hit = readMeshCache()[key];
  if (hit?.mesh_url) return res.json({ image_url: hit.image_url, mesh_url: hit.mesh_url, cached: true });

  // Procedural objects (the eye) are built by a script, never by fal image-to-3D.
  if (isProceduralObject(objectId)) {
    return res.status(404).json({ error: 'procedural_mesh_missing', message: `No built mesh for ${key}; run its build script.` });
  }

  if (!hasFal()) {
    return res.json({ image_url: '', mesh_url: '', cached: false, mock: true });
  }

  if (balanceExhausted) {
    return res.status(402).json({ error: 'fal_balance_exhausted', message: new FalBalanceError().message });
  }

  let job = inFlight.get(key);
  if (!job) {
    job = generateMesh(parsed.data.prompt).finally(() => inFlight.delete(key));
    inFlight.set(key, job);
  }
  try {
    const out = await job;
    const entry: MeshEntry = { image_url: out.image_url, mesh_url: out.mesh_url };
    writeMeshEntry(key, entry);
    return res.json({ ...entry, cached: false });
  } catch (err) {
    if (isBalanceError(err)) {
      balanceExhausted = true;
      console.error(`[generate-part] ${key}: fal balance exhausted; no more fal jobs until restart`);
      return res.status(402).json({ error: 'fal_balance_exhausted', message: new FalBalanceError().message });
    }
    throw err;
  }
}
