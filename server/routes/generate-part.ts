import type { Request, Response } from 'express';
import { GeneratePartRequestSchema } from '../../shared/teardown';
import { hasFal } from '../lib/env';
import { checkedMeshUrl, readMeshCache, safeId, writeMeshEntry, type MeshEntry } from '../lib/cache';
import { generateMesh } from '../lib/fal';

/** One fal job per part at a time, even if the client asks twice. */
const inFlight = new Map<string, Promise<MeshEntry>>();

/** POST /api/generate-part { object_id, part_id, prompt } -> { image_url, mesh_url, cached } (+ mock) */
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
  if (hit?.mesh_url) return res.json({ ...hit, cached: true });

  if (!hasFal()) {
    return res.json({ image_url: '', mesh_url: '', cached: false, mock: true });
  }

  let job = inFlight.get(key);
  if (!job) {
    job = generateMesh(parsed.data.prompt).finally(() => inFlight.delete(key));
    inFlight.set(key, job);
  }
  const entry = await job;
  writeMeshEntry(key, entry);
  return res.json({ ...entry, cached: false });
}
