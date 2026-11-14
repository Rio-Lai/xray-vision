/** Text-to-image prompt for one part. Used by the client flow and scripts/pregenerate.ts. Tune freely. */
import type { Teardown, TeardownPart } from './teardown';

export function partPrompt(td: Pick<Teardown, 'name' | 'lens'>, part: Pick<TeardownPart, 'name'>): string {
  if (td.lens === 'biology') {
    return `anatomical 3D model of the human ${part.name} (${td.name.toLowerCase()}), isolated single object, medical illustration style, plain white background`;
  }
  // Say "internal component removed from inside" and "not a complete device": with plain "isolated X from a laptop"
  // the image model drew consumer products (a Wi-Fi router for "antennas", a hi-fi box for "speakers").
  return `the bare internal ${part.name} component, as removed from inside a ${td.name} during a teardown, only that one part, not a complete device or accessory, isolated on a plain white background, studio product photo, high detail`;
}
