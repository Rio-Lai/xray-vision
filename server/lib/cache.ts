/**
 * Cache layout
 *   public/cache/<object_id>.json                    checked teardowns (committed, human-reviewed)
 *   public/cache/meshes/<object_id>/<part_id>.glb    checked meshes (committed)
 *   .cache-live/<object_id>.json                     live Claude teardowns (gitignored, unreviewed)
 *   .cache-live/meshes.json                          live fal results keyed "<object_id>/<part_id>"
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TeardownSchema, type Teardown } from '../../shared/teardown';
import { slugify } from '../../shared/demo';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CHECKED_DIR = path.join(ROOT, 'public', 'cache');
export const LIVE_DIR = path.join(ROOT, '.cache-live');

/** Ids become file names, so keep them to [a-z0-9-]. */
export function safeId(id: string): string {
  return /^[a-z0-9][a-z0-9-]{0,80}$/.test(id) ? id : slugify(id);
}

function readJson(file: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function readTeardown(file: string): Teardown | null {
  if (!fs.existsSync(file)) return null;
  const parsed = TeardownSchema.safeParse(readJson(file));
  if (!parsed.success) {
    console.error(`[cache] ${file} does not match TeardownSchema:`, parsed.error.issues.slice(0, 5));
    return null;
  }
  return parsed.data;
}

export const readCheckedTeardown = (objectId: string) =>
  readTeardown(path.join(CHECKED_DIR, `${safeId(objectId)}.json`));

export const readLiveTeardown = (objectId: string) =>
  readTeardown(path.join(LIVE_DIR, `${safeId(objectId)}.json`));

export const writeLiveTeardown = (td: Teardown) =>
  writeJson(path.join(LIVE_DIR, `${safeId(td.object_id)}.json`), td);

/** Checked objects, so identify can steer Claude towards an id we already have. */
export function listCheckedObjects(): { object_id: string; name: string; lens: string }[] {
  if (!fs.existsSync(CHECKED_DIR)) return [];
  return fs
    .readdirSync(CHECKED_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readTeardown(path.join(CHECKED_DIR, f)))
    .filter((t): t is Teardown => t !== null)
    .map((t) => ({ object_id: t.object_id, name: t.name, lens: t.lens }));
}

/** URL of a committed GLB for this part, if there is one. */
export function checkedMeshUrl(objectId: string, partId: string): string | null {
  const o = safeId(objectId);
  const p = safeId(partId);
  const file = path.join(CHECKED_DIR, 'meshes', o, `${p}.glb`);
  return fs.existsSync(file) ? `/cache/meshes/${o}/${p}.glb` : null;
}

export interface MeshEntry {
  image_url: string;
  mesh_url: string;
}

const MESH_CACHE = path.join(LIVE_DIR, 'meshes.json');

export function readMeshCache(): Record<string, MeshEntry> {
  const data = readJson(MESH_CACHE);
  return data && typeof data === 'object' ? (data as Record<string, MeshEntry>) : {};
}

export function writeMeshEntry(key: string, entry: MeshEntry) {
  const all = readMeshCache();
  all[key] = entry;
  writeJson(MESH_CACHE, all);
}

export { writeJson };
