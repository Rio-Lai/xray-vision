import type { Request, Response } from 'express';
import { hasEleven } from '../lib/env';

/** GET /api/agent-token -> { signed_url } for the ElevenLabs agent. 503 when not configured. */
export async function agentToken(_req: Request, res: Response) {
  if (!hasEleven()) {
    return res.status(503).json({
      error: 'voice_not_configured',
      message: 'Voice not configured yet: set ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID in .env and restart.',
    });
  }
  // Stage 2: real signed URL fetch.
  return res.status(501).json({ error: 'not_implemented', message: 'Signed URL fetch lands in stage 2.' });
}
