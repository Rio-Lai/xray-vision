/**
 * Thick 2D polylines (WebGL ignores lineWidth): a core mesh plus an additive "halo" mesh used
 * for the warm activation glow. Geometry is rebuilt every frame from viewport-pixel paths.
 */
import * as THREE from 'three';

export interface V2 {
  x: number;
  y: number;
}

export interface Path {
  pts: V2[];
  /** full width in px, per point or constant */
  widths: number[] | number;
  closed?: boolean;
}

export const WARM = new THREE.Color('#ffb02e');
export const WARM_CORE = new THREE.Color('#fff1c9');
export const CYAN = new THREE.Color('#7de3ff');

function countVerts(paths: Path[]): number {
  let n = 0;
  for (const p of paths) {
    const segs = p.closed ? p.pts.length : p.pts.length - 1;
    if (segs > 0) n += segs * 6;
  }
  return n;
}

function writePaths(arr: Float32Array, paths: Path[], widthScale: number, widthAdd: number, z: number): number {
  let o = 0;
  for (const p of paths) {
    const pts = p.pts;
    const n = pts.length;
    if (n < 2) continue;
    const left: number[] = new Array(n * 2);
    const right: number[] = new Array(n * 2);
    for (let i = 0; i < n; i++) {
      const prev = p.closed ? pts[(i - 1 + n) % n] : pts[Math.max(0, i - 1)];
      const next = p.closed ? pts[(i + 1) % n] : pts[Math.min(n - 1, i + 1)];
      let tx = next.x - prev.x;
      let ty = next.y - prev.y;
      const len = Math.hypot(tx, ty) || 1;
      tx /= len;
      ty /= len;
      const wRaw = typeof p.widths === 'number' ? p.widths : p.widths[i] ?? p.widths[p.widths.length - 1] ?? 2;
      const hw = (wRaw * widthScale + widthAdd) / 2;
      left[i * 2] = pts[i].x - ty * hw;
      left[i * 2 + 1] = pts[i].y + tx * hw;
      right[i * 2] = pts[i].x + ty * hw;
      right[i * 2 + 1] = pts[i].y - tx * hw;
    }
    const segs = p.closed ? n : n - 1;
    for (let s = 0; s < segs; s++) {
      const a = s;
      const b = (s + 1) % n;
      const quad = [
        left[a * 2], left[a * 2 + 1],
        right[a * 2], right[a * 2 + 1],
        left[b * 2], left[b * 2 + 1],
        right[a * 2], right[a * 2 + 1],
        right[b * 2], right[b * 2 + 1],
        left[b * 2], left[b * 2 + 1],
      ];
      for (let k = 0; k < 12; k += 2) {
        arr[o++] = quad[k];
        arr[o++] = quad[k + 1];
        arr[o++] = z;
      }
    }
  }
  return o / 3;
}

class DynamicGeo {
  geo = new THREE.BufferGeometry();
  private cap = 0;
  private arr = new Float32Array(0);

  constructor(initialVerts: number) {
    this.alloc(initialVerts);
  }

  private alloc(verts: number): void {
    this.cap = Math.max(6, verts);
    this.arr = new Float32Array(this.cap * 3);
    const attr = new THREE.BufferAttribute(this.arr, 3);
    attr.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', attr);
  }

  /** Returns true when the geometry object was replaced. */
  set(paths: Path[], widthScale: number, widthAdd: number): boolean {
    const need = countVerts(paths);
    let replaced = false;
    if (need > this.cap) {
      this.geo.dispose();
      this.geo = new THREE.BufferGeometry();
      this.alloc(need * 2);
      replaced = true;
    }
    const used = writePaths(this.arr, paths, widthScale, widthAdd, 0);
    const attr = this.geo.getAttribute('position') as THREE.BufferAttribute;
    attr.needsUpdate = true;
    this.geo.setDrawRange(0, used);
    return replaced;
  }

  dispose(): void {
    this.geo.dispose();
  }
}

export class Ribbon {
  readonly group = new THREE.Group();
  readonly core: THREE.Mesh;
  readonly halo: THREE.Mesh;
  readonly coreMat: THREE.MeshBasicMaterial;
  readonly haloMat: THREE.MeshBasicMaterial;
  private coreGeo: DynamicGeo;
  private haloGeo: DynamicGeo;

  constructor(initialVerts = 120) {
    this.coreGeo = new DynamicGeo(initialVerts);
    this.haloGeo = new DynamicGeo(initialVerts);
    this.coreMat = new THREE.MeshBasicMaterial({
      color: CYAN.clone(),
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
    });
    this.haloMat = new THREE.MeshBasicMaterial({
      color: WARM.clone(),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.core = new THREE.Mesh(this.coreGeo.geo, this.coreMat);
    this.halo = new THREE.Mesh(this.haloGeo.geo, this.haloMat);
    this.core.frustumCulled = false;
    this.halo.frustumCulled = false;
    this.group.add(this.halo, this.core);
  }

  setPaths(paths: Path[], glow: number): void {
    if (this.coreGeo.set(paths, 1, 0)) this.core.geometry = this.coreGeo.geo;
    if (glow > 0.01) {
      if (this.haloGeo.set(paths, 2.4, 8)) this.halo.geometry = this.haloGeo.geo;
      this.halo.visible = true;
    } else {
      this.halo.visible = false;
    }
  }

  /**
   * base: cyan-tinted part colour; opacity: final core opacity; glow: 0..1 activation.
   */
  setStyle(base: THREE.Color, opacity: number, glow: number, order: number): void {
    const g = Math.min(1, Math.max(0, glow));
    this.coreMat.color.copy(base).lerp(WARM_CORE, g * 0.85);
    this.coreMat.opacity = Math.min(1, opacity + g * 0.55);
    this.haloMat.opacity = g * 0.75 * Math.min(1, opacity * 2 + 0.3);
    this.core.renderOrder = order + 1;
    this.halo.renderOrder = order;
  }

  dispose(): void {
    this.coreGeo.dispose();
    this.haloGeo.dispose();
    this.coreMat.dispose();
    this.haloMat.dispose();
  }
}

/** Spindle (muscle belly / blob) from a to b with max width w. */
export function spindle(a: V2, b: V2, w: number, n = 11): Path {
  const pts: V2[] = [];
  const widths: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    pts.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    widths.push(Math.max(1.5, w * Math.pow(Math.sin(Math.PI * t), 0.7)));
  }
  return { pts, widths };
}

/** Capsule-ish bone segment, shortened at both ends to leave joint gaps. */
export function bone(a: V2, b: V2, w: number): Path {
  const s = 0.1;
  const a2 = { x: a.x + (b.x - a.x) * s, y: a.y + (b.y - a.y) * s };
  const b2 = { x: b.x + (a.x - b.x) * s, y: b.y + (a.y - b.y) * s };
  const m = { x: (a2.x + b2.x) / 2, y: (a2.y + b2.y) / 2 };
  return { pts: [a2, m, b2], widths: [w * 0.75, w * 0.55, w * 0.75] };
}
