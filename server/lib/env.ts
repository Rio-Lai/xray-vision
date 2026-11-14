/** Key checks. A missing key (or MOCK=1) puts that route in mock mode. */
const has = (name: string) => Boolean(process.env[name] && process.env[name]!.trim());

export const isMock = () => process.env.MOCK === '1';
export const hasAnthropic = () => !isMock() && has('ANTHROPIC_API_KEY');
export const hasFal = () => !isMock() && has('FAL_KEY');
export const hasEleven = () => !isMock() && has('ELEVENLABS_API_KEY') && has('ELEVENLABS_AGENT_ID');

export const anthropicModel = () => process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';

/**
 * Ports. This is the ONE place the defaults live: server/index.ts, server/lib/preflight.ts and
 * vite.config.ts (its /api proxy) all read them from here.
 *
 * The API port is uncommon on purpose: 8787, the old default, is also the default of other dev
 * tools (Cloudflare Wrangler, for one), and on the first real run something else answered there.
 */
export const DEFAULT_PORT = 8791;
/** The app. Fixed (Vite strictPort), because camera and microphone permissions belong to the origin. */
export const WEB_PORT = 5173;

type Env = Record<string, string | undefined>;

/** The API port: PORT from the shell or .env, else DEFAULT_PORT. vite.config.ts passes its loadEnv result. */
export function apiPort(env: Env = process.env): number {
  const raw = env.PORT?.trim();
  if (!raw) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT=${raw} is not a valid port. Set PORT in .env to a number such as ${DEFAULT_PORT}, or remove the line.`);
  }
  return port;
}

/**
 * What to print when the API port is taken. Shared by the preflight check and the server.
 * byBlowfish: true = one of our own servers answers there, false = some other program, null = not checked.
 */
export function portInUseMessage(port: number, byBlowfish: boolean | null): string {
  const free = port === DEFAULT_PORT ? DEFAULT_PORT + 1 : DEFAULT_PORT;
  const lines =
    byBlowfish === true
      ? [
          `Port ${port} is already used by another Blowfish server (an older "npm run dev" still running?).`,
          'Stop it with Ctrl+C in its terminal, then run "npm run dev" again.',
        ]
      : [
          byBlowfish === false
            ? `Port ${port} is already used by another program, so the Blowfish server cannot start there.`
            : `Port ${port} is already in use (another program, or an older Blowfish server still running).`,
          `Stop that program, or pick a free port: set PORT=${free} in .env, then run "npm run dev" again.`,
        ];
  lines.push(`To see what is using it (macOS): lsof -nP -iTCP:${port} -sTCP:LISTEN`);
  return lines.join('\n');
}
