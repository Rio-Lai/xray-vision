/**
 * Typed client for the server routes. All calls go through the Vite proxy at /api.
 * If /api is not our server (not running, or another program on its port), every call rejects
 * with an ApiError whose message is SERVER_DOWN_MESSAGE, so the UI and the tutor can say it.
 */
import type {
  AgentTokenResponse,
  GeneratePartRequest,
  GeneratePartResponse,
  IdentifyRequest,
  IdentifyResponse,
  Teardown,
  TeardownRequest,
} from '../../shared/teardown';

/** The one message for "the browser is not talking to our server". Shown as-is by the UI and the tutor. */
export const SERVER_DOWN_MESSAGE =
  'Blowfish server is not running. Check the terminal where npm run dev was started.';

export class ApiError extends Error {
  constructor(
    message: string,
    /** HTTP status from our server; 0 when our server was not reached at all. */
    public status: number,
    public body: unknown,
    /** True when /api is not answered by our server (not running, or some other program on its port). */
    public serverDown = false,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const isServerDown = (err: unknown): boolean => err instanceof ApiError && err.serverDown;

const serverDown = () => new ApiError(SERVER_DOWN_MESSAGE, 0, null, true);

/** Our /api/health shape. Anything else on that URL is some other program. */
function isOurHealth(body: unknown): body is Health {
  const h = body as Partial<Health> | null;
  return (
    !!h &&
    h.ok === true &&
    typeof h.mock === 'boolean' &&
    typeof h.keys === 'object' &&
    h.keys !== null &&
    typeof h.model === 'string'
  );
}

/** One health probe at a time, reused for 3 s so a burst of failing calls checks once. */
let probe: { at: number; result: Promise<boolean> } | null = null;
function ourServerAnswers(): Promise<boolean> {
  if (probe && Date.now() - probe.at < 3000) return probe.result;
  const result = fetch('/api/health', { cache: 'no-store' })
    .then(async (res) => res.ok && isOurHealth(await res.json().catch(() => null)))
    .catch(() => false);
  probe = { at: Date.now(), result };
  return result;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw serverDown(); // nothing answered at all: the dev server is stopped
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  // Our routes always answer JSON. An error or a non-JSON answer may come from something else
  // (Vite's empty 500 when nothing listens on the API port, or another program's 404 / 405).
  if ((!res.ok || body === null) && !(await ourServerAnswers())) throw serverDown();
  if (!res.ok) {
    const b = body as { message?: string; error?: string } | null;
    throw new ApiError(b?.message ?? b?.error ?? `${path} failed (${res.status})`, res.status, body);
  }
  if (body === null) throw new ApiError(`${path} sent no JSON`, res.status, null);
  return body as T;
}

const post = <T>(path: string, data: unknown) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(data) });

/** Extra flags the server may add: mock = no key, fallback = live call failed, shortcut = skipped the call. */
export interface ServerFlags {
  mock?: boolean;
  fallback?: boolean;
  shortcut?: boolean;
  error?: string;
}

export interface Health {
  ok: boolean;
  mock: boolean;
  keys: { anthropic: boolean; fal: boolean; elevenlabs: boolean };
  model: string;
}

export const api = {
  identify: (req: IdentifyRequest) => post<IdentifyResponse & ServerFlags>('/api/identify', req),
  teardown: (req: TeardownRequest) => post<Teardown>('/api/teardown', req),
  generatePart: (req: GeneratePartRequest) =>
    post<GeneratePartResponse & ServerFlags>('/api/generate-part', req),
  agentToken: () => request<AgentTokenResponse>('/api/agent-token'),
  /** Rejects with SERVER_DOWN_MESSAGE unless our own server answers. */
  health: async () => {
    const h = await request<unknown>('/api/health');
    if (!isOurHealth(h)) throw serverDown();
    return h;
  },
};
