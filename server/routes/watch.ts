import { Router } from 'express';
import { WatchHub, watchHandlers } from '../lib/watchHub';

/**
 * /api/watch/* (the big-screen view, `?watch=1`; server/lib/watchHub.ts says what each route does).
 * server/index.ts mounts this before express.json, so its own body limits apply (frames 300 kB raw
 * JPEG, state 2 MB JSON), and after the access gate, like the rest of /api.
 */
export function watchRoutes(hub: WatchHub = new WatchHub()): Router {
  const h = watchHandlers(hub);
  const r = Router();
  r.post('/frame', (req, res) => h.postFrame(req, res));
  r.get('/frame', (req, res) => h.getFrame(req, res));
  r.post('/state', (req, res) => h.postState(req, res));
  r.get('/stream', (req, res) => h.stream(req, res));
  r.get('/events', (req, res) => h.events(req, res));
  return r;
}
