/**
 * Parsed GLB models, loaded once per URL and shared by every rig that shows them. A rig gets its
 * own copy of the scene graph (`clone`) and its own materials (rigMaterial), but shares geometry
 * and textures with the cached template, so it must never dispose those (see BoxRig).
 *
 * preloadTeardownMeshes() reads a checked parts list from /cache/<object_id>.json and loads its
 * models one per idle slice in the background, so the first open of the demo laptop does not
 * parse ten files during the animation.
 * GlbWarmer (#125) goes further for the overlay's own renderer: per model, in small slices, it
 * parses it, compiles the rig's materials for it (renderer.compileAsync, off the main thread where
 * the browser can), uploads its textures and draws it once invisibly (its geometry), so its first
 * open neither compiles shaders nor uploads anything. It keeps one set of material copies per model
 * (they hold the compiled programs, which three.js shares by key with every rig's copies); the GPU
 * holds nothing more than an open model would.
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

/**
 * A rig's own copy of one of a model's materials (BoxRig.attachGlb): transparent, faded in from 0.
 * The warm-up makes its copies with this too, so their compiled programs are the very ones a rig uses.
 */
export function rigMaterial(m: THREE.Material): THREE.Material {
  const c = m.clone();
  c.transparent = true;
  c.opacity = 0;
  return c;
}

/** The longest an idle slice waits for the browser to be idle before it runs anyway (ms). */
const SLICE_TIMEOUT_MS = 300;

/**
 * Wait for one small slice of main-thread time: an idle callback (with a timeout), else a short
 * timer; never while the tab is hidden (it waits until it is visible again).
 */
export function idleSlice(): Promise<void> {
  return new Promise<void>((resolve) => {
    const run = () => {
      if (typeof document !== 'undefined' && document.hidden) {
        const onVis = () => {
          if (document.hidden) return;
          document.removeEventListener('visibilitychange', onVis);
          run();
        };
        document.addEventListener('visibilitychange', onVis);
        return;
      }
      if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve(), { timeout: SLICE_TIMEOUT_MS });
      else setTimeout(resolve, 30);
    };
    run();
  });
}

/** The URLs of a checked parts list's models (/cache/<object_id>.json), or [] if it has none. */
export async function teardownMeshUrls(objectId: string): Promise<string[]> {
  try {
    const r = await fetch(`/cache/${encodeURIComponent(objectId)}.json`);
    if (!r.ok || (r.headers.get('content-type') ?? '').includes('text/html')) return [];
    const td = (await r.json()) as { parts?: { mesh_url?: unknown }[] };
    return (td.parts ?? []).map((p) => p.mesh_url).filter((u): u is string => typeof u === 'string' && u.length > 0);
  } catch {
    return [];
  }
}

/** Load (in the background, one per idle slice) every model of a checked parts list. Returns how many loaded. */
export async function preloadTeardownMeshes(objectId: string, isCancelled: () => boolean = () => false): Promise<number> {
  const urls = await teardownMeshUrls(objectId);
  let n = 0;
  for (const url of urls) {
    await idleSlice();
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

/** Every texture a material uses (map, normalMap, ...). */
function texturesOf(m: THREE.Material): THREE.Texture[] {
  const out: THREE.Texture[] = [];
  for (const v of Object.values(m as unknown as Record<string, unknown>)) {
    if (v && typeof v === 'object' && (v as { isTexture?: unknown }).isTexture === true) out.push(v as THREE.Texture);
  }
  return out;
}

/** Warms models for one renderer, a slice at a time (see the file comment). Overlay owns one. */
export class GlbWarmer {
  private readonly warm = new Set<string>();
  /** material copies kept so their programs stay compiled (released by dispose) */
  private readonly kept: THREE.Material[] = [];
  /** the object to draw invisibly in the next frame (its geometry is uploaded then), and who waits for it */
  private pending: { obj: THREE.Object3D; added: boolean; done: () => void } | null = null;
  private disposed = false;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.Camera,
  ) {}

  /** Is this model's first open free of parsing, compiling and uploading on this renderer? */
  isWarm(url: string): boolean {
    return this.warm.has(url);
  }

  get cancelled(): boolean {
    return this.disposed;
  }

  /** #131: a model is in the scene to be drawn once this frame (the overlay draws even with nothing else to show). */
  get drawing(): boolean {
    return this.pending !== null && this.pending.added;
  }

  /**
   * Compile an object's materials against the overlay's scene (its lights and environment) without
   * drawing it. Keeps its materials (the programs live as long as they do). Waits for the compile.
   */
  async compile(obj: THREE.Object3D): Promise<void> {
    obj.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if (m) this.kept.push(...(Array.isArray(m) ? m : [m]));
    });
    // compileAsync (three r158+) waits for the browser's parallel compile instead of blocking on it.
    const r = this.renderer as unknown as { compileAsync?: (o: THREE.Object3D, c: THREE.Camera, s: THREE.Scene) => Promise<unknown> };
    if (typeof r.compileAsync === 'function') await r.compileAsync(obj, this.camera, this.scene);
    else this.renderer.compile(obj, this.camera, this.scene);
  }

  /** Parse, compile, upload and draw one model, in four slices. False if it failed or was cancelled. */
  async warmUrl(url: string): Promise<boolean> {
    if (this.warm.has(url)) return true;
    try {
      await idleSlice();
      if (this.disposed) return false;
      const tpl = await loadGlbTemplate(url);
      await idleSlice();
      if (this.disposed) return false;
      // A copy as a rig makes it (same materials, so the same programs), drawn with no colour or depth.
      const obj = tpl.clone(true);
      const textures = new Set<THREE.Texture>();
      obj.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const copy = (m: THREE.Material) => {
          const c = rigMaterial(m);
          c.colorWrite = false;
          c.depthWrite = false;
          for (const t of texturesOf(c)) textures.add(t);
          return c;
        };
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map(copy) : copy(mesh.material);
        mesh.frustumCulled = false;
      });
      await this.compile(obj);
      await idleSlice();
      if (this.disposed) return false;
      for (const t of textures) this.renderer.initTexture(t);
      await idleSlice();
      if (this.disposed) return false;
      await new Promise<void>((done) => {
        this.pending = { obj, added: false, done };
      });
      if (this.disposed) return false;
      this.warm.add(url);
      return true;
    } catch {
      return false; // it loads (and compiles) on first open instead
    }
  }

  /** Overlay tick, just before the main render: the model waiting to be drawn once goes in the scene. */
  beforeRender(): void {
    const p = this.pending;
    if (p && !p.added) {
      p.added = true;
      this.scene.add(p.obj);
    }
  }

  /** Overlay tick, just after the main render: it has been drawn; out it goes. */
  afterRender(): void {
    const p = this.pending;
    if (p && p.added) {
      this.pending = null;
      p.obj.removeFromParent();
      p.done();
    }
  }

  dispose(): void {
    this.disposed = true;
    const p = this.pending;
    this.pending = null;
    if (p) {
      p.obj.removeFromParent();
      p.done();
    }
    for (const m of this.kept) m.dispose();
    this.kept.length = 0;
  }
}
