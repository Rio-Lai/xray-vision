import type { Request, Response } from 'express';
import { z } from 'zod';
import type { ScanResponse, ScanThing } from '../../src/lib/api';
import { anthropicEffort, anthropicScanModel, hasAnthropic } from '../lib/env';
import { scanLive } from '../lib/claude';

/**
 * POST /api/scan { image, width, height } -> { things, seconds } (+ mock / fallback flags) (#122).
 * The overlay sends a downscaled copy of the wearer's view (faces blacked out) every few seconds;
 * Claude lists up to 10 things in it. Boxes come back normalised to the picture (0..1, top-left origin).
 * With no key: no things and `mock: true`. Any failure: no things and `fallback: true` (the app then
 * changes nothing on screen). One scan at a time: a second one while one runs gets `fallback` at once.
 */

export const MAX_SCAN_THINGS = 10;

const ScanRequestSchema = z.object({
  image: z.string().min(100).max(12_000_000),
  width: z.number().int().min(16).max(4096),
  height: z.number().int().min(16).max(4096),
});

const ScanThingSchema = z.object({
  name: z.string().min(1).max(60),
  box: z.object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    w: z.number().min(0.01).max(1),
    h: z.number().min(0.01).max(1),
  }),
  interest: z.number().min(0).max(1),
  centre: z.literal(true).optional(),
  object_id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,80}$/)
    .optional(),
});

const ScanResponseSchema = z.object({
  things: z.array(ScanThingSchema).max(MAX_SCAN_THINGS),
  seconds: z.number().min(0),
});

/** Never a thing to list (the prompt says so too; this is the backstop). */
const GENERIC = /^(an? )?(object|thing|item|device|gadget|electronics?|stuff|something|unknown|unclear|none|nothing)s?$/i;
/** A person anywhere in the name; a body part as the whole name (so "Hair dryer" and "Hand drill" stay). */
const PERSON = /\b(person|persons|people|man|woman|men|women|boy|girl|child|kid|baby|human|someone|selfie|wearer|face|faces)\b/i;
const BODY_PART =
  /^((the|a|an|left|right|my|his|her|their|human|person's)\s+)*(hand|hands|arm|arms|forearm|finger|fingers|thumb|head|hair|leg|legs|foot|feet|eye|eyes|nose|mouth|ear|ears|body|skin|wrist|palm)$/i;
const SURFACE = /^(the )?(wall|floor|ceiling|table|desk|tabletop|desktop surface|surface|window|door|carpet|rug|background)s?$/i;

const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN);
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let n = raw.replace(/\s+/g, ' ').replace(/^["'\s]+|["'\s.]+$/g, '').trim();
  if (n.length > 60) {
    const cut = n.slice(0, 60);
    const sp = cut.lastIndexOf(' ');
    n = (sp > 20 ? cut.slice(0, sp) : cut).trim();
  }
  // Sentence case for an all-lowercase start ("desk lamp" -> "Desk lamp"); "iPhone 15" stays as it is.
  if (/^[a-z]{2}/.test(n)) n = n.charAt(0).toUpperCase() + n.slice(1);
  if (!n || GENERIC.test(n) || PERSON.test(n) || BODY_PART.test(n) || SURFACE.test(n)) return null;
  return n;
}

/**
 * A box in the picture's pixels as [x0, y0, x1, y1] (what the prompt asks for), or {x0, y0, x1, y1},
 * or {x, y, w, h} -> normalised {x, y, w, h}, clamped into the picture. Values that all fit in 0..1 are
 * taken as fractions already; values past the picture but within 0..1000 as thousandths. null when unusable.
 */
export function normaliseBox(raw: unknown, width: number, height: number): ScanThing['box'] | null {
  let c: number[] | null = null;
  if (Array.isArray(raw) && raw.length === 4) c = raw.map(num);
  else if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    if ('x0' in r) c = [num(r.x0), num(r.y0), num(r.x1), num(r.y1)];
    else if ('x' in r) {
      const x = num(r.x);
      const y = num(r.y);
      c = [x, y, x + num(r.w ?? r.width), y + num(r.h ?? r.height)];
    }
  }
  if (!c || c.some((v) => !Number.isFinite(v))) return null;
  let [x0, y0, x1, y1] = c;
  if (x0 > x1) [x0, x1] = [x1, x0];
  if (y0 > y1) [y0, y1] = [y1, y0];
  const big = Math.max(x1, y1);
  let sx = width;
  let sy = height;
  if (big <= 1.0001) {
    sx = 1;
    sy = 1;
  } else if ((x1 > width * 1.05 || y1 > height * 1.05) && big <= 1000) {
    sx = 1000;
    sy = 1000;
  }
  const nx0 = clamp01(x0 / sx);
  const ny0 = clamp01(y0 / sy);
  const nx1 = clamp01(x1 / sx);
  const ny1 = clamp01(y1 / sy);
  if (nx1 - nx0 < 0.01 || ny1 - ny0 < 0.01) return null;
  return { x: nx0, y: ny0, w: nx1 - nx0, h: ny1 - ny0 };
}

function iou(a: ScanThing['box'], b: ScanThing['box']): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const uni = a.w * a.h + b.w * b.h - inter;
  return uni > 0 ? inter / uni : 0;
}

const holdsCentre = (b: ScanThing['box']) => b.x <= 0.5 && b.x + b.w >= 0.5 && b.y <= 0.5 && b.y + b.h >= 0.5;

/**
 * Claude's reply -> at most MAX_SCAN_THINGS valid things, most interesting first. Things without a usable
 * name or box are dropped, as are people, surfaces and repeats; at most one `centre` (the one whose box
 * holds the middle, if several are marked), and it is kept even if it would be 11th. Throws when the
 * reply has no `things` list at all.
 */
export function normaliseScan(raw: unknown, width: number, height: number): ScanThing[] {
  const list = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).things : undefined;
  if (!Array.isArray(list)) throw new Error('reply had no "things" list');
  const out: ScanThing[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const name = cleanName(r.name);
    const box = normaliseBox(r.box, width, height);
    if (!name || !box) continue;
    const dup = out.some((o) => (o.name.toLowerCase() === name.toLowerCase() && iou(o.box, box) > 0.3) || iou(o.box, box) > 0.85);
    if (dup) continue;
    const interest = num(r.interest);
    const thing: ScanThing = { name, box, interest: Number.isFinite(interest) ? clamp01(interest) : 0.5 };
    if (r.centre === true || r.center === true) thing.centre = true;
    if (typeof r.object_id === 'string' && /^[a-z0-9][a-z0-9-]{0,80}$/.test(r.object_id)) thing.object_id = r.object_id;
    out.push(thing);
  }
  const marked = out.filter((t) => t.centre);
  if (marked.length > 1) {
    const keep = marked.find((t) => holdsCentre(t.box)) ?? marked[0];
    for (const t of marked) if (t !== keep) delete t.centre;
  }
  // Stable sort: equal interest keeps Claude's order.
  const sorted = out.map((t, i) => ({ t, i })).sort((a, b) => b.t.interest - a.t.interest || a.i - b.i).map((x) => x.t);
  const top = sorted.slice(0, MAX_SCAN_THINGS);
  const centre = sorted.find((t) => t.centre);
  if (centre && !top.includes(centre)) top[top.length - 1] = centre;
  return top;
}

let busy = false;

export async function scan(req: Request, res: Response) {
  const parsed = ScanRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid body', issues: parsed.error.issues });
  }
  if (!hasAnthropic()) return res.json({ things: [], seconds: 0, mock: true });
  if (busy) return res.json({ things: [], seconds: 0, fallback: true, error: 'a scan is already running' });

  const { image, width, height } = parsed.data;
  const started = Date.now();
  const seconds = () => Math.round((Date.now() - started) / 100) / 10;
  busy = true;
  try {
    const raw = await scanLive({ image, width, height, model: anthropicScanModel(), effort: anthropicEffort('scan') });
    const body: ScanResponse = ScanResponseSchema.parse({ things: normaliseScan(raw, width, height), seconds: seconds() });
    return res.json(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[scan] failed after ${seconds()} s: ${message}`);
    return res.json({ things: [], seconds: seconds(), fallback: true, error: message });
  } finally {
    busy = false;
  }
}
