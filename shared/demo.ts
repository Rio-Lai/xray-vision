/**
 * Mock identify mapping. Used by the server in mock mode and by the client
 * when /api/identify fails, so the demo objects always resolve to their
 * checked cache files in public/cache/.
 */
import type { AnchorKind, IdentifyResponse, Lens } from './teardown';

/** "hand" or "hands" as a word, so a detected "handbag" is not a hand. */
const HAND = /\bhands?\b/i;
/** "eye", "eyes", "eyeball" as a word (#94), so "eyeglasses" or "eyeliner" is not an eye. */
const EYE = /\beye(?:s|ball|balls)?\b/i;

/** True for an eye label or hint ("eye", "the eye", "eyes"): it always maps to the checked eye, with no vision call. */
export function isEyeHint(hint: string | undefined): boolean {
  return EYE.test(hint ?? '');
}

/**
 * Which kind of parts list fits an object: hands and eyes -> biology, everything else -> engineering.
 * Internal metadata only (it picks the server prompt); Blowfish has no lenses the user sees or sets.
 */
export function kindOf(label: string | undefined, anchor?: AnchorKind): Lens {
  return anchor === 'hand' || anchor === 'face' || HAND.test(label ?? '') || EYE.test(label ?? '') ? 'biology' : 'engineering';
}

export const DEMO_IDENTIFY: Record<'laptop' | 'hand' | 'eye' | 'phone', IdentifyResponse> = {
  laptop: {
    object_id: 'macbook-air-m3-13',
    name: 'MacBook Air 13-inch (M3, 2024)',
    confidence: 0.6,
    summary: 'A fanless 13-inch Apple laptop built around the M3 chip.',
  },
  phone: {
    object_id: 'iphone-17-pro',
    name: 'iPhone 17 Pro (Cosmic Orange)',
    confidence: 0.6,
    summary: "Apple's 2025 Pro phone: aluminium unibody, full-width camera plateau, A19 Pro chip.",
  },
  hand: {
    object_id: 'hand-finger-muscles',
    name: 'Hand and finger muscles',
    confidence: 0.9,
    summary: 'The muscles and tendons that bend and straighten your fingers.',
  },
  // Kash's procedural eye (public/cache/eye.json, #94): opened from an "eye" label; no picture of a face is sent anywhere.
  eye: {
    object_id: 'eye',
    name: 'Human eye',
    confidence: 0.9,
    summary: 'The eye: the cornea and lens focus light onto the retina, which sends it to the brain along the optic nerve.',
  },
};

/** True for the demo objects above: their parts lists ship in public/cache/, so they never need Claude to open. */
export function isDemoObject(objectId: string): boolean {
  return Object.values(DEMO_IDENTIFY).some((d) => d.object_id === objectId);
}

export function slugify(s: string): string {
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || 'object';
}

/**
 * Map a detector label to a demo object. Unknown labels get a slug id with no cache file.
 * `kind` (see kindOf) only matters when there is no label at all.
 */
export function mockIdentify(hint: string | undefined, kind?: Lens): IdentifyResponse {
  const h = (hint ?? '').toLowerCase().trim();
  if (HAND.test(h)) return DEMO_IDENTIFY.hand;
  if (EYE.test(h)) return DEMO_IDENTIFY.eye;
  if (h.includes('laptop') || h.includes('macbook') || h.includes('computer') || h.includes('keyboard')) {
    return DEMO_IDENTIFY.laptop;
  }
  // MediaPipe's COCO label for a phone is "cell phone"
  if (h.includes('phone') || h.includes('iphone') || h.includes('mobile')) return DEMO_IDENTIFY.phone;
  if (!h) return kind === 'biology' ? DEMO_IDENTIFY.hand : DEMO_IDENTIFY.laptop;
  return {
    object_id: slugify(h),
    name: hint?.trim() || h,
    confidence: 0.3,
    summary: `A ${h}.`,
  };
}
