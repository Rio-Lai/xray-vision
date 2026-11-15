/**
 * `npm run phone` (scripts/phone.mjs) sets BLOWFISH_SERVE_DIST=1: this server then also serves the
 * built app (dist/, from `vite build`) on its own port, so one port (and one tunnel) carries the page,
 * its assets and /api. Everything sits behind the access code (./phoneAccess.ts). Without the variable
 * nothing here runs, and `npm run dev` (Vite on 5173, this server on 8791) is exactly as before.
 *  - MIME types the phone needs set explicitly: .wasm (application/wasm, or MediaPipe's streaming
 *    compile fails), .task / .tflite (MediaPipe models), .glb (3D models)
 *  - long cache headers for the hashed /assets/ files, a day for models and meshes, none for the page
 *  - any other GET without a file extension (/, /arm-demo) gets index.html; a missing file is a 404,
 *    never index.html, so src/detect/mediapipe.ts sees a missing local model as missing
 */
import express from 'express';
import type { Express } from 'express';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { phoneGate } from './phoneAccess';

export const serveDistOn = (): boolean => process.env.BLOWFISH_SERVE_DIST === '1';

const DIST = fileURLToPath(new URL('../../dist', import.meta.url));

const TYPES: Record<string, string> = {
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.tflite': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
};
const BIG_FILES = new Set(['.wasm', '.task', '.tflite', '.glb', '.png', '.jpg', '.jpeg', '.webp', '.ktx2']);

function cacheControl(urlPath: string, ext: string): string {
  if (urlPath.startsWith('/assets/')) return 'public, max-age=31536000, immutable'; // Vite's hashed bundles
  if (BIG_FILES.has(ext)) return 'public, max-age=86400';
  return 'no-cache'; // index.html, the parts lists: always the ones from this run
}

/** The access gate, the built app and its index.html fallback. Call right after `express()`, before the routes. */
export function mountPhone(app: Express): void {
  app.use(phoneGate(process.env.BLOWFISH_PHONE_CODE));
  if (!existsSync(join(DIST, 'index.html'))) {
    console.warn('[server] BLOWFISH_SERVE_DIST=1 but dist/index.html is missing: run "npm run build" (npm run phone does it).');
  }
  app.use(
    express.static(DIST, {
      index: false,
      setHeaders: (res, filePath) => {
        const ext = extname(filePath).toLowerCase();
        const type = TYPES[ext];
        if (type) res.setHeader('Content-Type', type);
        const rel = `/${filePath.slice(DIST.length).split('\\').join('/').replace(/^\/+/, '')}`;
        res.setHeader('Cache-Control', cacheControl(rel, ext));
      },
    }),
  );
  app.get(/.*/, (req, res, next) => {
    if (req.path === '/api' || req.path.startsWith('/api/') || extname(req.path) !== '') {
      next();
      return;
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(join(DIST, 'index.html'), (err) => {
      if (err && !res.headersSent) res.status(404).type('text/plain').send('Blowfish: the app is not built yet. Run "npm run phone" again.\n');
    });
  });
}
