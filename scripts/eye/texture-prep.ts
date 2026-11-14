/**
 * Turn the raw fal images into textures that map correctly onto the eye meshes.
 *
 * The pixel positions below were measured on the committed raw images (public/cache/eye/textures/*.raw.png).
 * If a raw image is regenerated, re-measure them (pupil centre and radius, iris edge, glints; optic disc,
 * fovea, any artefact to remove) or the anatomy will not line up.
 */
import sharp from 'sharp';

export const IRIS_CAL = {
  /** Pupil circle (least-squares fit to the pupil edge, max residual 4 px), plus a small margin. */
  pupil: { c: [511.1, 530.0] as [number, number], r: 143 + 6 },
  /** Iris edge / limbus circle (fit to the dark limbal ring), minus a margin so no sclera or eyelash shows. */
  outer: { c: [513.2, 543.9] as [number, number], r: 399 - 10 },
  /** angle range (degrees, image y down) holding the light reflections; replaced by the opposite sector */
  glintFrom: 172,
  glintTo: 250,
  /** cross-fade width (degrees) at each end of the patched sector */
  glintFade: 34,
};

/**
 * The fal fundus photo is of a LEFT eye (disc on the left); our model is a RIGHT eye, and right and left
 * fundi are mirror images, so it is flipped horizontally first. Positions below are in the flipped image.
 */
export const RETINA_CAL = {
  mirror: true,
  fieldCentre: [508, 511] as [number, number],
  fieldR: 472,
  /** optic disc centre (where the vessels converge) */
  disc: [842, 512] as [number, number],
  /**
   * Anatomy: the fovea lies ~15 degrees (~4.5 mm, ~2.5 disc diameters) temporal of the disc and slightly
   * below it, in the middle of the vascular arcades. In this photo the arcades centre ~332 px temporal of the
   * disc, so ~22 px per degree.
   */
  pxPerDeg: 22.1,
  discFoveaDeg: 15,
  foveaBelowDiscDeg: 0.7,
};

/** Angular reach of the retina (posterior pole to the ora serrata), used by the mesh UVs too. */
export const RETINA_PHI_MAX = (117 * Math.PI) / 180;

/** Fundus UV radius (0..1) for an angle phi from the posterior pole: more texels in the central 30 degrees. */
export function retinaRho(phi: number): number {
  const p30 = Math.PI / 6;
  return phi <= p30 ? (0.62 * phi) / p30 : 0.62 + (0.38 * (phi - p30)) / (RETINA_PHI_MAX - p30);
}
function retinaPhi(rho: number): number {
  const p30 = Math.PI / 6;
  return rho <= 0.62 ? (rho / 0.62) * p30 : p30 + ((rho - 0.62) / 0.38) * (RETINA_PHI_MAX - p30);
}

/** UV on the retina for (phi from posterior pole, azimuth from +x nasal towards +y superior). */
export function retinaUV(phi: number, az: number): [number, number] {
  const rho = Math.min(1, retinaRho(phi));
  return [0.5 + 0.5 * rho * Math.cos(az), 0.5 - 0.5 * rho * Math.sin(az)];
}

interface Img {
  d: Float32Array;
  w: number;
  h: number;
}

async function load(file: string, mirror = false): Promise<Img> {
  const s = mirror ? sharp(file).flop() : sharp(file);
  const { data, info } = await s.removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { d: Float32Array.from(data), w: info.width, h: info.height };
}

function sample(img: Img, x: number, y: number): [number, number, number] {
  x = Math.max(0, Math.min(img.w - 1.001, x));
  y = Math.max(0, Math.min(img.h - 1.001, y));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const p = (xx: number, yy: number) => img.d[(yy * img.w + xx) * 3 + c];
    out[c] = (p(x0, y0) * (1 - fx) + p(x0 + 1, y0) * fx) * (1 - fy) + (p(x0, y0 + 1) * (1 - fx) + p(x0 + 1, y0 + 1) * fx) * fy;
  }
  return out;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const clamp8 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

/** Float box blur, 3 passes (close to a Gaussian of the given sigma). Float keeps tiny weights exact. */
function blur(img: Img, sigma: number): Img {
  const r = Math.max(1, Math.round(Math.sqrt((12 * sigma * sigma) / 3 + 1) / 2));
  let a = Float32Array.from(img.d);
  let b = new Float32Array(a.length);
  const { w, h } = img;
  const pass = (src: Float32Array, dst: Float32Array, horizontal: boolean) => {
    const n = horizontal ? w : h;
    const m = horizontal ? h : w;
    const stride = horizontal ? 3 : w * 3;
    for (let line = 0; line < m; line++) {
      const base = horizontal ? line * w * 3 : line * 3;
      for (let c = 0; c < 3; c++) {
        let acc = 0;
        const at = (k: number) => src[base + Math.max(0, Math.min(n - 1, k)) * stride + c];
        for (let k = -r; k <= r; k++) acc += at(k);
        for (let k = 0; k < n; k++) {
          dst[base + k * stride + c] = acc / (2 * r + 1);
          acc += at(k + r + 1) - at(k - r);
        }
      }
    }
  };
  for (let i = 0; i < 3; i++) {
    pass(a, b, true);
    pass(b, a, false);
  }
  b = a;
  return { d: b, w, h };
}

const toSharp = (d: Uint8Array | Buffer, w: number, h: number, channels: 3 | 4) => sharp(Buffer.from(d), { raw: { width: w, height: h, channels } });

/* ------------------------------ iris ------------------------------ */

export async function prepIris(rawFile: string): Promise<{ strip: Buffer; slide: Buffer }> {
  const img = await load(rawFile);
  const { pupil, outer, glintFrom, glintTo, glintFade: fade } = IRIS_CAL;
  const deg = Math.PI / 180;
  // Weight for "use the opposite sector instead" at image angle a (degrees, 0..360, y down).
  const patchW = (a: number) => smooth(glintFrom - fade, glintFrom, a) * (1 - smooth(glintTo, glintTo + fade, a));
  // Rubber-sheet model: v = 0 on the pupil circle, 1 on the iris edge circle, at the same angle.
  // Works even though the pupil is not centred in the iris (it rarely is).
  const sheet = (v: number, aDeg: number) => {
    const a = aDeg * deg;
    const x = (1 - v) * (pupil.c[0] + pupil.r * Math.cos(a)) + v * (outer.c[0] + outer.r * Math.cos(a));
    const y = (1 - v) * (pupil.c[1] + pupil.r * Math.sin(a)) + v * (outer.c[1] + outer.r * Math.sin(a));
    return sample(img, x, y);
  };
  const at = (v: number, aDeg: number) => {
    const a = ((aDeg % 360) + 360) % 360;
    const p = sheet(v, a);
    const w = patchW(a);
    if (w <= 0) return p;
    const q = sheet(v, a + 180);
    return p.map((c, i) => c * (1 - w) + q[i] * w) as [number, number, number];
  };

  // UV strip: columns = angle (u = theta / 2pi, theta from +x towards +y in 3D, i.e. image y up),
  // rows = v (0 at the pupil margin, 1 at the iris root).
  const W = 2048;
  const H = 320;
  const strip = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H;
    for (let x = 0; x < W; x++) {
      const theta = ((x + 0.5) / W) * 360;
      strip.set(at(v, -theta).map(clamp8), (y * W + x) * 3); // 3D +y is image -y
    }
  }

  // Slide image: the cleaned iris, concentric, round, on transparency, with a black pupil.
  const S = 1024;
  const slide = new Uint8Array(S * S * 4);
  const R0 = 0.36; // pupil radius as a fraction of the iris radius in the slide (pupil 4.3 mm / iris 12 mm)
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const dx = (x + 0.5 - S / 2) / (S / 2 - 6);
      const dy = (y + 0.5 - S / 2) / (S / 2 - 6);
      const rr = Math.hypot(dx, dy);
      const a = (Math.atan2(dy, dx) / deg + 360) % 360;
      const v = (rr - R0) / (1 - R0);
      const p = v < 0 ? [6, 5, 5] : at(Math.min(1, v), a);
      const edgeIn = smooth(-0.015, 0.01, v);
      const c = p.map((val) => val * edgeIn + 6 * (1 - edgeIn));
      const alpha = 1 - smooth(0.995, 1.005, rr);
      slide.set([...c.map((val) => clamp8(val * alpha)), clamp8(alpha * 255)], (y * S + x) * 4);
    }

  return {
    strip: await toSharp(strip, W, H, 3).jpeg({ quality: 90 }).toBuffer(),
    slide: await toSharp(slide, S, S, 4).png().toBuffer(),
  };
}

/* ------------------------------ retina ------------------------------ */

export async function prepRetina(rawFile: string): Promise<{ uv: Buffer; slide: Buffer }> {
  const { mirror, fieldCentre, fieldR, disc, pxPerDeg, discFoveaDeg, foveaBelowDiscDeg } = RETINA_CAL;
  const src = await load(rawFile, mirror);
  // Temporal of the disc is towards -x in this (right-eye) image; image +y is inferior.
  const fovea: [number, number] = [disc[0] - discFoveaDeg * pxPerDeg, disc[1] + foveaBelowDiscDeg * pxPerDeg];
  const photo: Img = { d: Float32Array.from(src.d), w: src.w, h: src.h };

  // 0. Flat-field: fundus cameras darken towards the edge (vignetting). Measure the background brightness
  //    per radius (brightest 60% of each ring, so vessels don't count) and even it out to the mid-field level.
  {
    const BIN = 6;
    const nb = Math.ceil(fieldR / BIN) + 1;
    const rings: number[][][] = Array.from({ length: nb }, () => []);
    for (let y = 0; y < src.h; y += 2)
      for (let x = 0; x < src.w; x += 2) {
        const r = Math.hypot(x - fieldCentre[0], y - fieldCentre[1]);
        if (r >= fieldR) continue;
        const i = (y * src.w + x) * 3;
        rings[Math.floor(r / BIN)].push([src.d[i], src.d[i + 1], src.d[i + 2]]);
      }
    const level = rings.map((ring) => {
      if (ring.length < 20) return null;
      ring.sort((a, b) => a[0] + a[1] - (b[0] + b[1]));
      const k = ring.slice(Math.floor(ring.length * 0.4));
      return [0, 1, 2].map((c) => k.reduce((s, p) => s + p[c], 0) / k.length);
    });
    // Reference = median level over the mid field (40-70% radius).
    const mid = level.slice(Math.floor(nb * 0.4), Math.floor(nb * 0.7)).filter((l): l is number[] => !!l);
    const ref = [0, 1, 2].map((c) => mid.map((l) => l[c]).sort((a, b) => a - b)[mid.length >> 1]);
    // Only brighten the darkened rim; never darken the centre (it holds the macula and disc).
    const gainAt = (r: number, c: number) => {
      const b = Math.min(nb - 1, Math.floor(r / BIN));
      let l: number[] | null = null;
      for (let k = b; k >= 0 && !l; k--) l = level[k];
      if (!l) return 1;
      return Math.max(1, Math.min(2.5, ref[c] / Math.max(1, l[c])));
    };
    for (let y = 0; y < src.h; y++)
      for (let x = 0; x < src.w; x++) {
        const r = Math.hypot(x - fieldCentre[0], y - fieldCentre[1]);
        if (r >= fieldR || r < fieldR * 0.55) continue;
        const i = (y * src.w + x) * 3;
        for (let c = 0; c < 3; c++) photo.d[i + c] *= gainAt(r, c);
      }
  }

  // 1. Paint the macula at the anatomical fovea: a soft darker, less yellow area,
  //    a darker foveal pit and a tiny foveal light reflex.
  for (let y = 0; y < src.h; y++)
    for (let x = 0; x < src.w; x++) {
      const r2 = (x - fovea[0]) ** 2 + (y - fovea[1]) ** 2;
      const mac = Math.exp(-r2 / (2 * (3.6 * pxPerDeg) ** 2));
      const pit = Math.exp(-r2 / (2 * (0.6 * pxPerDeg) ** 2));
      const reflex = Math.exp(-r2 / (2 * (0.13 * pxPerDeg) ** 2));
      const i = (y * src.w + x) * 3;
      const k = 1 - 0.3 * mac - 0.32 * pit;
      photo.d[i] = photo.d[i] * k + 70 * reflex;
      photo.d[i + 1] = photo.d[i + 1] * (k - 0.12 * mac) + 70 * reflex;
      photo.d[i + 2] = photo.d[i + 2] * k + 60 * reflex;
    }

  // Background retina colour for the far periphery: mid-field ring (the outer rim is darkened by camera
  // vignetting), brightest 60% of pixels only, so vessels don't pull it darker.
  const ring: [number, number, number][] = [];
  for (let y = 0; y < src.h; y += 2)
    for (let x = 0; x < src.w; x += 2) {
      const r = Math.hypot(x - fieldCentre[0], y - fieldCentre[1]);
      if (r > fieldR * 0.4 && r < fieldR * 0.7) {
        const i = (y * src.w + x) * 3;
        ring.push([photo.d[i], photo.d[i + 1], photo.d[i + 2]]);
      }
    }
  ring.sort((a, b) => a[0] + a[1] - (b[0] + b[1]));
  const keep = ring.slice(Math.floor(ring.length * 0.4));
  const periph = [0, 1, 2].map((c) => keep.reduce((s, p) => s + p[c], 0) / keep.length);

  // Cheap smooth value noise for choroidal mottling in the periphery.
  const noise = (x: number, y: number) =>
    0.5 * Math.sin(x * 0.013 + Math.sin(y * 0.011) * 2.1) * Math.cos(y * 0.017 + Math.cos(x * 0.009) * 1.7) +
    0.25 * Math.sin(x * 0.041 + y * 0.029) * Math.sin(y * 0.037 - x * 0.023);

  // 2. Re-project onto the retina's UV layout: centre = fovea (posterior pole), +u = nasal, -v = superior.
  const S = 2048;
  const out = new Uint8Array(S * S * 3);
  for (let py = 0; py < S; py++)
    for (let px = 0; px < S; px++) {
      const dx = ((px + 0.5) / S) * 2 - 1;
      const dy = -(((py + 0.5) / S) * 2 - 1);
      const rho = Math.hypot(dx, dy);
      const az = Math.atan2(dy, dx);
      const phiDeg = (retinaPhi(Math.min(rho, 1)) * 180) / Math.PI;
      const sx = fovea[0] + phiDeg * pxPerDeg * Math.cos(az);
      const sy = fovea[1] - phiDeg * pxPerDeg * Math.sin(az);
      const edge = fieldR - Math.hypot(sx - fieldCentre[0], sy - fieldCentre[1]);
      // Fade the photo out before its vignetted rim.
      const wPhoto = smooth(25, 90, edge);
      const dark = 1 - 0.3 * smooth(30, 117, phiDeg);
      const n = 1 + 0.07 * noise(px, py);
      const bg = periph.map((v) => v * dark * n);
      const p = wPhoto > 0 ? sample(photo, sx, sy) : [0, 0, 0];
      const c = p.map((v, i) => v * wPhoto + bg[i] * (1 - wPhoto));
      out.set(c.map(clamp8), (py * S + px) * 3);
    }

  // Slide image: the corrected fundus photo itself.
  const slideBuf = Uint8Array.from(photo.d, clamp8);
  return {
    uv: await toSharp(out, S, S, 3).jpeg({ quality: 86 }).toBuffer(),
    slide: await toSharp(slideBuf, src.w, src.h, 3).png().toBuffer(),
  };
}
