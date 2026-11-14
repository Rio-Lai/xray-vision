/**
 * Parsed GLB models, loaded once per URL and shared by every rig that shows them. A rig gets its
 * own copy of the scene graph (`clone`) and its own materials, but shares geometry and textures
 * with the cached template, so it must never dispose those (see BoxRig).
 *
 * preloadTeardownMeshes() reads a checked parts list from /cache/<object_id>.json and loads its
 * models one after another in the background, so the first explode of the demo laptop shows real
 * models at once instead of parsing ten files during the animation.
 * Supports what the committed models use: KHR_mesh_quantization and KHR_materials_* are built into
 * GLTFLoader; no meshopt or draco decoder is needed.
 */
import type * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const loader = new GLTFLoader();
const cache = new Map<string, Promise<THREE.Object3D>>();

export function loadGlbTemplate(url: string): Promise<THREE.Object3D> {
  let p = cache.get(url);
  if (!p) {
    p = new Promise<THREE.Object3D>((resolve, reject) => {
      try {
        loader.load(
          url,
          (gltf) => resolve(gltf.scene),
          undefined,
          (err) => reject(err instanceof Error ? err : new Error(String(err))),
        );
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    // A failed load is forgotten, so a later explode can try again.
    p.catch(() => {
      if (cache.get(url) === p) cache.delete(url);
    });
    cache.set(url, p);
  }
  return p;
}

/** Load (in the background, one at a time) every model of a checked parts list. Returns how many loaded. */
export async function preloadTeardownMeshes(objectId: string, isCancelled: () => boolean = () => false): Promise<number> {
  let urls: string[] = [];
  try {
    const r = await fetch(`/cache/${encodeURIComponent(objectId)}.json`);
    if (!r.ok || (r.headers.get('content-type') ?? '').includes('text/html')) return 0;
    const td = (await r.json()) as { parts?: { mesh_url?: unknown }[] };
    urls = (td.parts ?? []).map((p) => p.mesh_url).filter((u): u is string => typeof u === 'string' && u.length > 0);
  } catch {
    return 0;
  }
  let n = 0;
  for (const url of urls) {
    if (isCancelled()) break;
    try {
      await loadGlbTemplate(url);
      n += 1;
    } catch {
      /* the rig keeps the placeholder for this part */
    }
  }
  return n;
}
