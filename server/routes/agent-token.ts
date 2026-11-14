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

  const agentId = process.env.ELEVENLABS_AGENT_ID!;
  const url = `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`;
  const r = await fetch(url, { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY! } });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    console.error(`[agent-token] ElevenLabs ${r.status}: ${text.slice(0, 300)}`);
    return res.status(502).json({ error: 'elevenlabs_error', message: `ElevenLabs returned ${r.status}` });
  }
  const body = (await r.json()) as { signed_url?: string };
  if (!body.signed_url) {
    return res.status(502).json({ error: 'elevenlabs_error', message: 'ElevenLabs sent no signed_url' });
  }
  return res.json({ signed_url: body.signed_url });
}
