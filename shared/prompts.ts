/** Text-to-image prompt for one part. Used by the client flow and scripts/pregenerate.ts. Tune freely. */
import type { Teardown, TeardownPart } from './teardown';

/**
 * What a part physically looks like, for parts whose display name is too vague for the image model
 * (keyed by part id). Without these, "Speakers" came back as a generic housing and "Thunderbolt / USB 4 ports"
 * as an empty frame.
 */
const LOOKS_LIKE: Record<string, string> = {
  speakers: 'a slim elongated laptop speaker module: a narrow black plastic enclosure with a small speaker driver and a thin ribbon cable',
  'thunderbolt-ports': 'a small narrow laptop I/O daughterboard: a green circuit board with two USB-C sockets along one edge and a short flex cable',
};

export function partPrompt(td: Pick<Teardown, 'name' | 'lens'>, part: Pick<TeardownPart, 'name'> & { id?: string }): string {
  if (td.lens === 'biology') {
    return `anatomical 3D model of the human ${part.name} (${td.name.toLowerCase()}), isolated single object, medical illustration style, plain white background`;
  }
  const looks = part.id ? LOOKS_LIKE[part.id] : undefined;
  // Say "internal component removed from inside" and "not a complete device": with plain "isolated X from a laptop"
  // the image model drew consumer products (a Wi-Fi router for "antennas", a hi-fi box for "speakers").
  return `the bare internal ${part.name} component${looks ? ` (${looks})` : ''}, as removed from inside a ${td.name} during a teardown, only that one part, not a complete device or accessory, isolated on a plain white background, studio product photo, high detail`;
}
