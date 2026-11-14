/**
 * fal pipeline: text -> image (FAL_IMAGE_MODEL, default fal-ai/flux/schnell)
 * then image -> 3D GLB (FAL_3D_MODEL, default fal-ai/hunyuan3d/v2/turbo).
 */
import { fal } from '@fal-ai/client';
import type { MeshEntry } from './cache';

type Subscribe = (
  endpointId: string,
  options: { input: Record<string, unknown>; logs?: boolean },
) => Promise<{ data: unknown; requestId?: string }>;

let subscribe: Subscribe | null = null;
function getSubscribe(): Subscribe {
  if (!subscribe) {
    fal.config({ credentials: process.env.FAL_KEY });
    subscribe = fal.subscribe.bind(fal) as unknown as Subscribe;
  }
  return subscribe;
}

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
const urlOf = (v: unknown): string | undefined => {
  const u = rec(v).url;
  return typeof u === 'string' && u ? u : undefined;
};

export async function generateImage(prompt: string): Promise<string> {
  const model = process.env.FAL_IMAGE_MODEL || 'fal-ai/flux/schnell';
  const result = await getSubscribe()(model, {
    input: {
      prompt,
      image_size: 'square_hd',
      num_inference_steps: 4,
      num_images: 1,
      enable_safety_checker: true,
    },
  });
  const images = rec(result.data).images;
  const url = Array.isArray(images) ? urlOf(images[0]) : undefined;
  if (!url) throw new Error(`${model} returned no image`);
  return url;
}

export async function imageToMesh(imageUrl: string): Promise<string> {
  const model = process.env.FAL_3D_MODEL || 'fal-ai/hunyuan3d/v2/turbo';
  // Hunyuan3D takes input_image_url; most other fal image-to-3D models take image_url.
  const input: Record<string, unknown> = model.includes('hunyuan')
    ? { input_image_url: imageUrl, textured_mesh: process.env.FAL_TEXTURED === '1' }
    : { image_url: imageUrl };
  const result = await getSubscribe()(model, { input });
  const d = rec(result.data);
  const url = urlOf(d.model_mesh) ?? urlOf(d.model_glb) ?? urlOf(d.glb) ?? urlOf(d.mesh);
  if (!url) throw new Error(`${model} returned no mesh url`);
  return url;
}

export async function generateMesh(prompt: string): Promise<MeshEntry> {
  const image_url = await generateImage(prompt);
  const mesh_url = await imageToMesh(image_url);
  return { image_url, mesh_url };
}
