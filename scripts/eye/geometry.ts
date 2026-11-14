/**
 * Small mesh generators for the procedural eye, in millimetres.
 *
 * Coordinate frame (one shared origin for every part, so they line up when assembled):
 *   origin = centre of the eyeball, +z = anterior (towards the viewer), +y = superior,
 *   +x = nasal (this is a RIGHT eye seen from the front, so the nose is on the viewer's right).
 */

export interface MeshData {
  pos: number[];
  nrm: number[];
  uv: number[];
  idx: number[];
}

export const emptyMesh = (): MeshData => ({ pos: [], nrm: [], uv: [], idx: [] });

export function merge(...meshes: MeshData[]): MeshData {
  const out = emptyMesh();
  for (const m of meshes) {
    const base = out.pos.length / 3;
    out.pos.push(...m.pos);
    out.nrm.push(...m.nrm);
    out.uv.push(...m.uv);
    for (const i of m.idx) out.idx.push(i + base);
  }
  return out;
}

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/**
 * Drop zero-area triangles and make every triangle wind so its face normal agrees with its vertex
 * normals (counter-clockwise front faces, as glTF expects).
 */
export function finalize(m: MeshData): MeshData {
  const P = (i: number): V3 => [m.pos[i * 3], m.pos[i * 3 + 1], m.pos[i * 3 + 2]];
  const N = (i: number): V3 => [m.nrm[i * 3], m.nrm[i * 3 + 1], m.nrm[i * 3 + 2]];
  const idx: number[] = [];
  for (let t = 0; t < m.idx.length; t += 3) {
    const [a, b, c] = [m.idx[t], m.idx[t + 1], m.idx[t + 2]];
    const fn = cross(sub(P(b), P(a)), sub(P(c), P(a)));
    if (len(fn) < 1e-9) continue;
    const vn = add(add(N(a), N(b)), N(c));
    if (dot(fn, vn) >= 0) idx.push(a, b, c);
    else idx.push(a, c, b);
  }
  return { ...m, idx };
}

/* ---------------- lathe (surfaces of revolution about the z axis) ---------------- */

export type Profile = [number, number][]; // [r, z] points

/** Shoelace area of a closed (r, z) polygon; < 0 means clockwise. */
function signedArea(pts: Profile): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/** Corner-cutting smoothing that keeps the end points. */
export function chaikin(pts: Profile, iterations = 2): Profile {
  let p = pts;
  for (let k = 0; k < iterations; k++) {
    const out: Profile = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const [a, b] = [p[i], p[i + 1]];
      out.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]]);
      out.push([0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
    }
    out.push(p[p.length - 1]);
    p = out;
  }
  return p;
}

/** Sample an arc of the circle centred on the axis at z = cz with radius R, from r0 to r1 (front or back cap). */
export function capArc(R: number, cz: number, r0: number, r1: number, sign: 1 | -1, n = 48): Profile {
  const pts: Profile = [];
  for (let i = 0; i <= n; i++) {
    const r = r0 + ((r1 - r0) * i) / n;
    pts.push([r, cz + sign * Math.sqrt(Math.max(0, R * R - r * r))]);
  }
  return pts;
}

export interface LatheSegment {
  pts: Profile;
  /** v texture coordinate per point (defaults to 0..1 along the segment). */
  v?: (r: number, z: number, i: number) => number;
}

/**
 * Revolve profile segments about z. Segments are joined in order and form a closed outline
 * (an open outline from axis to axis is closed by the axis). Normals are smooth within a segment
 * and hard between segments. Outward normals are found from the outline's winding.
 */
export function lathe(segments: LatheSegment[], radial = 128, phase = 0): MeshData {
  const all: Profile = segments.flatMap((s) => s.pts);
  const cw = signedArea(all) < 0;
  const out = emptyMesh();
  for (const seg of segments) {
    const pts = seg.pts;
    const n = pts.length;
    const base = out.pos.length / 3;
    const nrm2: [number, number][] = pts.map((_, i) => {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(n - 1, i + 1)];
      const dr = b[0] - a[0];
      const dz = b[1] - a[1];
      const l = Math.hypot(dr, dz) || 1;
      // Clockwise outline: outward = (-dz, dr). Counter-clockwise: the opposite.
      return cw ? [-dz / l, dr / l] : [dz / l, -dr / l];
    });
    for (let j = 0; j <= radial; j++) {
      const th = phase + (j / radial) * Math.PI * 2;
      const c = Math.cos(th);
      const s = Math.sin(th);
      for (let i = 0; i < n; i++) {
        const [r, z] = pts[i];
        out.pos.push(r * c, r * s, z);
        const [nr, nz] = nrm2[i];
        out.nrm.push(nr * c, nr * s, nz);
        out.uv.push(j / radial, seg.v ? seg.v(r, z, i) : i / (n - 1));
      }
    }
    for (let j = 0; j < radial; j++) {
      for (let i = 0; i < n - 1; i++) {
        const a = base + j * n + i;
        const b = base + (j + 1) * n + i;
        out.idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
  }
  return finalize(out);
}

/* ---------------- spherical shells (sclera, choroid, retina) ---------------- */

export interface Hole {
  /** unit direction from the eye centre to the hole centre */
  dir: V3;
  /** angular radius in radians */
  angle: number;
}

/**
 * One spherical surface around the posterior pole (-z), from the pole (phi = 0) to phiMax.
 * Vertices that fall inside a hole are slid onto the hole's edge; triangles left entirely on the
 * edge are dropped, which leaves a clean round opening.
 */
export function sphereSurface(opts: {
  R: number;
  phiMax: number;
  inward?: boolean;
  holes?: Hole[];
  rings?: number;
  radial?: number;
  uv?: (phi: number, az: number) => [number, number];
}): MeshData {
  const { R, phiMax, inward = false, holes = [], rings = 96, radial = 160 } = opts;
  const out = emptyMesh();
  const onEdge: boolean[] = [];
  for (let i = 0; i <= rings; i++) {
    const phi = (i / rings) * phiMax;
    for (let j = 0; j <= radial; j++) {
      const az = (j / radial) * Math.PI * 2;
      let p: V3 = [Math.sin(phi) * Math.cos(az), Math.sin(phi) * Math.sin(az), -Math.cos(phi)];
      let edge = false;
      for (const h of holes) {
        const cosA = dot(p, h.dir);
        if (cosA > Math.cos(h.angle)) {
          // Slide p away from the hole centre, along the great circle, to the hole edge.
          let t = sub(p, scale(h.dir, cosA));
          if (len(t) < 1e-9) t = Math.abs(h.dir[1]) < 0.9 ? cross(h.dir, [0, 1, 0]) : cross(h.dir, [1, 0, 0]);
          t = norm(t);
          p = add(scale(h.dir, Math.cos(h.angle)), scale(t, Math.sin(h.angle)));
          edge = true;
        }
      }
      onEdge.push(edge);
      out.pos.push(p[0] * R, p[1] * R, p[2] * R);
      const s = inward ? -1 : 1;
      out.nrm.push(p[0] * s, p[1] * s, p[2] * s);
      const phiP = Math.acos(Math.max(-1, Math.min(1, -p[2])));
      const azP = Math.atan2(p[1], p[0]);
      out.uv.push(...(opts.uv ? opts.uv(phiP, azP) : [j / radial, i / rings]));
    }
  }
  const W = radial + 1;
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * W + j;
      const b = a + W;
      for (const tri of [
        [a, b, a + 1],
        [b, b + 1, a + 1],
      ]) {
        if (tri.every((k) => onEdge[k])) continue;
        out.idx.push(...tri);
      }
    }
  }
  return finalize(out);
}

/** Rim joining two concentric spherical surfaces at phiMax (the front edge of a shell). */
export function shellRim(Rout: number, Rin: number, phiMax: number, radial = 160): MeshData {
  const zO = -Math.cos(phiMax) * Rout;
  const zI = -Math.cos(phiMax) * Rin;
  const rO = Math.sin(phiMax) * Rout;
  const rI = Math.sin(phiMax) * Rin;
  // Outline order picked so the rim's normals face forward (+phi direction).
  return lathe([{ pts: [[rI, zI], [rO, zO]] }], radial);
}

/** A closed shell: outer surface, inner surface and the front rim. */
export function sphereShell(opts: {
  Rout: number;
  Rin: number;
  phiMax: number;
  holes?: (R: number) => Hole[];
  uv?: (phi: number, az: number) => [number, number];
  rings?: number;
  radial?: number;
}): MeshData {
  const { Rout, Rin, phiMax, holes = () => [], uv, rings, radial } = opts;
  const outer = sphereSurface({ R: Rout, phiMax, holes: holes(Rout), uv, rings, radial });
  const inner = sphereSurface({ R: Rin, phiMax, inward: true, holes: holes(Rin), uv, rings, radial });
  const rim = shellRim(Rout, Rin, phiMax, radial);
  // The rim's outline is a single open segment; point its normals forward explicitly.
  for (let i = 0; i < rim.nrm.length; i += 3) {
    const x = rim.pos[i];
    const y = rim.pos[i + 1];
    const r = Math.hypot(x, y) || 1;
    // +phi direction on a sphere around -z: (cos(phi) * radial, sin(phi)) in (r, z).
    const n: V3 = [(Math.cos(phiMax) * x) / r, (Math.cos(phiMax) * y) / r, Math.sin(phiMax)];
    rim.nrm[i] = n[0];
    rim.nrm[i + 1] = n[1];
    rim.nrm[i + 2] = n[2];
  }
  return merge(outer, inner, finalize(rim));
}

/* ---------------- tubes ---------------- */

/** Catmull-Rom point on a polyline of control points, t in 0..1. */
function catmull(points: V3[], t: number): V3 {
  const n = points.length - 1;
  const f = Math.min(n - 1e-9, Math.max(0, t * n));
  const i = Math.floor(f);
  const u = f - i;
  const p0 = points[Math.max(0, i - 1)];
  const p1 = points[i];
  const p2 = points[i + 1];
  const p3 = points[Math.min(n, i + 2)];
  const c = (k: 0 | 1 | 2) =>
    0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * u + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * u * u + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * u * u * u);
  return [c(0), c(1), c(2)];
}

/** Tube of constant radius along a smooth curve, with flat end caps. */
export function tube(control: V3[], radius: number, segments = 64, sides = 32, caps = true): MeshData {
  const out = emptyMesh();
  const C = Array.from({ length: segments + 1 }, (_, i) => catmull(control, i / segments));
  // Parallel-transport frames so the tube does not twist.
  let tPrev = norm(sub(C[1], C[0]));
  let nPrev = norm(cross(tPrev, Math.abs(tPrev[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
  const frames: { t: V3; n: V3; b: V3 }[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = norm(sub(C[Math.min(segments, i + 1)], C[Math.max(0, i - 1)]));
    const b0 = cross(tPrev, t);
    let n = nPrev;
    if (len(b0) > 1e-6) {
      const ax = norm(b0);
      const ang = Math.acos(Math.max(-1, Math.min(1, dot(tPrev, t))));
      // Rodrigues rotation of nPrev about ax by ang.
      n = add(add(scale(nPrev, Math.cos(ang)), scale(cross(ax, nPrev), Math.sin(ang))), scale(ax, dot(ax, nPrev) * (1 - Math.cos(ang))));
    }
    n = norm(n);
    frames.push({ t, n, b: cross(t, n) });
    tPrev = t;
    nPrev = n;
  }
  for (let i = 0; i <= segments; i++) {
    const { n, b } = frames[i];
    for (let j = 0; j <= sides; j++) {
      const a = (j / sides) * Math.PI * 2;
      const dir = add(scale(n, Math.cos(a)), scale(b, Math.sin(a)));
      const p = add(C[i], scale(dir, radius));
      out.pos.push(...p);
      out.nrm.push(...dir);
      out.uv.push(j / sides, i / segments);
    }
  }
  const W = sides + 1;
  for (let i = 0; i < segments; i++)
    for (let j = 0; j < sides; j++) {
      const a = i * W + j;
      out.idx.push(a, a + W, a + 1, a + W, a + W + 1, a + 1);
    }
  let mesh = finalize(out);
  if (caps) {
    for (const end of [0, segments]) {
      const cap = emptyMesh();
      const { t, n, b } = frames[end];
      const outward = end === 0 ? scale(t, -1) : t;
      cap.pos.push(...C[end]);
      cap.nrm.push(...outward);
      cap.uv.push(0.5, 0.5);
      for (let j = 0; j <= sides; j++) {
        const a = (j / sides) * Math.PI * 2;
        const dir = add(scale(n, Math.cos(a)), scale(b, Math.sin(a)));
        cap.pos.push(...add(C[end], scale(dir, radius)));
        cap.nrm.push(...outward);
        cap.uv.push(0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a));
        if (j > 0) cap.idx.push(0, j, j + 1);
      }
      mesh = merge(mesh, finalize(cap));
    }
  }
  return mesh;
}

/** Straight thin cylinder between two points (for zonular fibres). */
export function rod(a: V3, b: V3, radius: number, sides = 5): MeshData {
  return tube([a, b], radius, 1, sides, false);
}

/** Uniformly scale a mesh (mm -> scene units). Normals are unchanged by a uniform scale. */
export function scaleMesh(m: MeshData, s: number): MeshData {
  return { ...m, pos: m.pos.map((v) => v * s) };
}

export type { V3 };
