/**
 * fal pipeline: text -> image (FAL_IMAGE_MODEL, default fal-ai/flux/schnell)
 * then image -> 3D GLB (FAL_3D_MODEL, default fal-ai/hunyuan3d/v2/turbo).
 *
 * Server-side only: FAL_KEY is read from process.env and never sent to the browser.
 * Every fal call is billed, so:
 *   - only 429 (rejected before any work) is retried automatically;
 *   - "Exhausted balance" throws FalBalanceError and must never be retried.
 */
import { fal } from '@fal-ai/client';

type Subscribe = (
  endpointId: string,
  options: { input: Record<string, unknown>; logs?: boolean },
) => Promise<{ data: unknown; requestId?: string }>;

let subscribe: Subscribe | null = null;
function getSubscribe(): Subscribe {
  if (!subscribe) {
    fal.config({
      credentials: process.env.FAL_KEY,
      retry: { maxRetries: 2, retryableStatusCodes: [429] },
    });
    subscribe = fal.subscribe.bind(fal) as unknown as Subscribe;
  }
  return subscribe;
}

/** Thrown when the fal account has no credit left. Never retry: each attempt is another billable job. */
export class FalBalanceError extends Error {
  readonly requestId?: string;
  constructor(requestId?: string) {
    super('fal balance exhausted: top up at https://fal.ai/dashboard/billing. Not retrying.');
    this.name = 'FalBalanceError';
    this.requestId = requestId;
  }
}

/** Any other fal failure, with the request id when fal gave one. */
export class FalCallError extends Error {
  readonly requestId?: string;
  constructor(message: string, requestId?: string) {
    super(message);
    this.name = 'FalCallError';
    this.requestId = requestId;
  }
}

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
const urlOf = (v: unknown): string | undefined => {
  const u = rec(v).url;
  return typeof u === 'string' && u ? u : undefined;
};

const FAL_HOSTS = ['fal.media', 'fal.ai', 'fal.run'];

/** Only https URLs on fal's own domains (or their subdomains). Anything else could be an SSRF or junk. */
export function isFalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && FAL_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

function errorText(err: unknown): string {
  const e = rec(err);
  const parts = [err instanceof Error ? err.message : String(err)];
  if (e.body !== undefined) {
    try {
      parts.push(typeof e.body === 'string' ? e.body : JSON.stringify(e.body));
    } catch {
      /* ignore */
    }
  }
  return parts.join(' ');
}

export function isBalanceError(err: unknown): boolean {
  return err instanceof FalBalanceError || /exhausted balance|balance exhausted|insufficient (balance|credit)/i.test(errorText(err));
}

async function call(model: string, input: Record<string, unknown>): Promise<{ data: unknown; requestId?: string }> {
  try {
    return await getSubscribe()(model, { input });
  } catch (err) {
    const requestId = typeof rec(err).requestId === 'string' ? (rec(err).requestId as string) : undefined;
    if (isBalanceError(err)) throw new FalBalanceError(requestId);
    throw new FalCallError(`${model}: ${errorText(err).slice(0, 400)}`, requestId);
  }
}

export interface ImageResult {
  image_url: string;
  image_request_id?: string;
}

export async function generateImage(prompt: string, model = process.env.FAL_IMAGE_MODEL || 'fal-ai/flux/schnell'): Promise<ImageResult> {
  const input: Record<string, unknown> = {
    prompt,
    image_size: 'square_hd',
    num_images: 1,
    output_format: 'png',
    enable_safety_checker: true,
  };
  // Step count only exists on the open FLUX models (schnell is distilled to 4 steps).
  if (model === 'fal-ai/flux/schnell') input.num_inference_steps = 4;
  else if (model === 'fal-ai/flux/dev') input.num_inference_steps = 28;
  const result = await call(model, input);
  const images = rec(result.data).images;
  const url = Array.isArray(images) ? urlOf(images[0]) : undefined;
  if (!url) throw new FalCallError(`${model} returned no image`, result.requestId);
  if (!isFalUrl(url)) throw new FalCallError(`${model} returned a non-fal image url`, result.requestId);
  return { image_url: url, image_request_id: result.requestId };
}

export interface MeshResult {
  mesh_url: string;
  mesh_request_id?: string;
}

/** Textured (coloured) by default, about $0.42 a part. FAL_TEXTURED=0 makes plain white meshes (about $0.15). */
export const texturedByDefault = () => process.env.FAL_TEXTURED !== '0';

export async function imageToMesh(imageUrl: string, textured = texturedByDefault()): Promise<MeshResult> {
  if (!isFalUrl(imageUrl)) throw new FalCallError('refusing to send a non-fal image url to fal');
  const model = process.env.FAL_3D_MODEL || 'fal-ai/hunyuan3d/v2/turbo';
  // Hunyuan3D takes input_image_url; most other fal image-to-3D models take image_url.
  const input: Record<string, unknown> = model.includes('hunyuan')
    ? { input_image_url: imageUrl, textured_mesh: textured }
    : { image_url: imageUrl };
  const result = await call(model, input);
  const d = rec(result.data);
  const url = urlOf(d.model_mesh) ?? urlOf(d.model_glb) ?? urlOf(d.glb) ?? urlOf(d.mesh);
  if (!url) throw new FalCallError(`${model} returned no mesh url`, result.requestId);
  if (!isFalUrl(url)) throw new FalCallError(`${model} returned a non-fal mesh url`, result.requestId);
  return { mesh_url: url, mesh_request_id: result.requestId };
}

export type GeneratedMesh = ImageResult & MeshResult;

/** Image then mesh. If the mesh step fails, the error still carries the image request id. */
export async function generateMesh(prompt: string, textured = texturedByDefault()): Promise<GeneratedMesh> {
  const image = await generateImage(prompt);
  try {
    const mesh = await imageToMesh(image.image_url, textured);
    return { ...image, ...mesh };
  } catch (err) {
    if (err instanceof Error) err.message += ` (image request ${image.image_request_id ?? '?'})`;
    throw err;
  }
}

/** Download a fal file (GLB, PNG) after checking it really is on fal. */
export async function downloadFalFile(url: string): Promise<Buffer> {
  if (!isFalUrl(url)) throw new Error(`refusing to download from a non-fal url: ${url}`);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download failed: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
