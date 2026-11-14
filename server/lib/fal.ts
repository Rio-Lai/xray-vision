import type { MeshEntry } from './cache';

// Stage 1 stub. The route only calls this when FAL_KEY is set.
export async function generateMesh(_prompt: string): Promise<MeshEntry> {
  throw new Error('generateMesh not implemented yet');
}
