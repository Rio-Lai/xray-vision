/** Text-to-image prompt for one part. Used by the client flow and scripts/pregenerate.ts. Tune freely. */
import type { Teardown, TeardownPart } from './teardown';

export function partPrompt(td: Pick<Teardown, 'name' | 'lens'>, part: Pick<TeardownPart, 'name'>): string {
  if (td.lens === 'biology') {
    return `anatomical 3D model of the human ${part.name} (${td.name.toLowerCase()}), isolated single object, medical illustration style, plain white background`;
  }
  return `isolated ${part.name} from a ${td.name}, single object, studio product render, plain white background, high detail`;
}
