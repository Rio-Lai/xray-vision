/**
 * Mock identify mapping. Used by the server in mock mode and by the client
 * when /api/identify fails, so the demo objects always resolve to their
 * checked cache files in public/cache/.
 */
import type { IdentifyResponse, Lens } from './teardown';

export const DEMO_IDENTIFY: Record<'laptop' | 'hand', IdentifyResponse> = {
  laptop: {
    object_id: 'macbook-air-m3-13',
    name: 'MacBook Air 13-inch (M3, 2024)',
    confidence: 0.6,
    summary: 'A fanless 13-inch Apple laptop built around the M3 chip.',
  },
  hand: {
    object_id: 'hand-finger-muscles',
    name: 'Hand and finger muscles',
    confidence: 0.9,
    summary: 'The muscles and tendons that bend and straighten your fingers.',
  },
};

export function slugify(s: string): string {
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || 'object';
}

/** Map a detector label to a demo object. Unknown labels get a slug id with no cache file. */
export function mockIdentify(hint: string | undefined, lens: Lens): IdentifyResponse {
  const h = (hint ?? '').toLowerCase();
  if (h.includes('hand')) return DEMO_IDENTIFY.hand;
  if (h.includes('laptop') || h.includes('macbook') || h.includes('computer') || h.includes('keyboard')) {
    return DEMO_IDENTIFY.laptop;
  }
  if (!h) return lens === 'biology' ? DEMO_IDENTIFY.hand : DEMO_IDENTIFY.laptop;
  return {
    object_id: slugify(h),
    name: hint ?? h,
    confidence: 0.3,
    summary: `A ${h}.`,
  };
}
