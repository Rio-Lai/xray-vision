/**
 * fal 2D textures for the procedural eye (iris and retinal fundus).
 * Each texture is generated once and saved to public/cache/eye/textures/<name>.raw.png;
 * an existing file is never regenerated (delete it to get a new one).
 */
import fs from 'node:fs';
import path from 'node:path';
import { downloadFalFile, generateImage } from '../../server/lib/fal';

/** flux/dev drew the iris well but invented anatomy in the fundus (twice), so the retina uses flux-pro. */
export const TEXTURE_MODELS: Record<string, string> = {
  iris: 'fal-ai/flux/dev',
  retina: 'fal-ai/flux-pro/v1.1',
};

export const TEXTURE_PROMPTS = {
  iris:
    'extreme macro photograph of a single human iris seen straight on, perfectly centred, the iris fills the whole square frame edge to edge, ' +
    'radial fibres and crypts, collarette ring, hazel brown-green, round black pupil exactly in the centre, even soft lighting, no eyelids, no eyelashes, no reflections',
  retina:
    'Colour fundus photograph of a normal healthy right eye, as taken by a retinal camera in an eye clinic, ' +
    'circular image on a black background. Small pale optic disc on the right side of the image, retinal arteries and veins ' +
    'branching from it and sweeping in long arcs above and below the centre of the image. Uniform orange-red retina, ' +
    'the centre of the image is plain, slightly darker retina. Photorealistic, ophthalmology textbook image.',
} as const;

export type TextureName = keyof typeof TEXTURE_PROMPTS;

export interface TextureRecord {
  file: string;
  model: string;
  prompt: string;
  request_id?: string;
  image_url?: string;
}

export async function ensureTextures(dir: string, log = console.log): Promise<Record<TextureName, TextureRecord>> {
  fs.mkdirSync(dir, { recursive: true });
  const metaFile = path.join(dir, 'textures.json');
  const meta: Record<string, TextureRecord> = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : {};
  for (const name of Object.keys(TEXTURE_PROMPTS) as TextureName[]) {
    const file = path.join(dir, `${name}.raw.png`);
    if (fs.existsSync(file)) {
      log(`[eye] texture ${name}: using existing ${path.relative(process.cwd(), file)}`);
      continue;
    }
    if (!process.env.FAL_KEY) throw new Error(`Missing ${file} and FAL_KEY is not set`);
    const started = Date.now();
    const model = TEXTURE_MODELS[name];
    const img = await generateImage(TEXTURE_PROMPTS[name], model);
    fs.writeFileSync(file, await downloadFalFile(img.image_url));
    meta[name] = { file: path.basename(file), model, prompt: TEXTURE_PROMPTS[name], request_id: img.image_request_id, image_url: img.image_url };
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n');
    log(`[eye] texture ${name}: fal ${model} ${((Date.now() - started) / 1000).toFixed(1)} s, request ${img.image_request_id}`);
  }
  return meta as Record<TextureName, TextureRecord>;
}

// Run directly: npx tsx scripts/eye/textures.ts
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  await import('dotenv/config');
  await ensureTextures(path.resolve('public/cache/eye/textures'));
}
