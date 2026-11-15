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
import type { EnrichRequest, EnrichResponse, SketchAnswer, SketchRequest } from '../../shared/sketch';

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

/** A call that took longer than its time limit; the request was aborted. Our server may be fine: this is not "server down". */
export class ApiTimeoutError extends Error {
  constructor(
    path: string,
    public ms: number,
  ) {
    super(`${path} took longer than ${(ms / 1000).toFixed(1)} s`);
    this.name = 'ApiTimeoutError';
  }
}

export const isTimeout = (err: unknown): err is ApiTimeoutError => err instanceof ApiTimeoutError;

/** fetch rejects with AbortError (AbortController) or TimeoutError (AbortSignal.timeout) when its signal fires. */
const isAbort = (err: unknown): boolean =>
  err instanceof DOMException && (err.name === 'AbortError' || err.name === 'TimeoutError');

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

/** Is /api answered by our server? Runs only after a failed call; calls failing together share one probe. */
let probe: Promise<boolean> | null = null;
function ourServerAnswers(): Promise<boolean> {
  probe ??= fetch('/api/health', { cache: 'no-store' })
    .then(async (res) => res.ok && isOurHealth(await res.json().catch(() => null)))
    .catch(() => false)
    .finally(() => {
      probe = null;
    });
  return probe;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (err) {
    if (init?.signal?.aborted || isAbort(err)) throw err; // we gave up on it (see withTimeout), not "server down"
    throw serverDown(); // nothing answered at all: the dev server is stopped
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch (err) {
    if (init?.signal?.aborted || isAbort(err)) throw err;
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

const post = <T>(path: string, data: unknown, signal?: AbortSignal) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(data), signal });

/**
 * Run a call with a time limit: after `ms` the request is aborted and this rejects with
 * ApiTimeoutError. No limit when `ms` is undefined or 0.
 */
async function withTimeout<T>(path: string, ms: number | undefined, run: (signal?: AbortSignal) => Promise<T>): Promise<T> {
  if (!ms || ms <= 0) return run();
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ApiTimeoutError(path, ms));
      ctl.abort();
    }, ms);
  });
  try {
    return await Promise.race([run(ctl.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}

export interface CallOptions {
  /** Give up after this many milliseconds (rejects with ApiTimeoutError). */
  timeoutMs?: number;
}

/** Extra flags the server may add: mock = no key, fallback = live call failed, shortcut = skipped the call. */
export interface ServerFlags {
  mock?: boolean;
  fallback?: boolean;
  shortcut?: boolean;
  error?: string;
}

/** POST /api/scan (#122): one downscaled picture of the wearer's view, faces blacked out (base64 JPEG, its size in px). */
export interface ScanRequest {
  image: string;
  width: number;
  height: number;
}

/** One thing Claude found in the picture. */
export interface ScanThing {
  /** short and specific, sentence case: "Casio scientific calculator" */
  name: string;
  /** normalised to the picture that was sent (0..1, top-left origin), clamped into it */
  box: { x: number; y: number; w: number; h: number };
  /** 0..1: how rewarding it is to look inside or learn about */
  interest: number;
  /** the thing at the centre of the picture (at most one) */
  centre?: true;
  /** a checked parts list it plausibly is (e.g. "macbook-air-m3-13") */
  object_id?: string;
}

/** At most 10 things, most interesting first; `seconds` = how long Claude took. `mock: true` (no key): no things. */
export interface ScanResponse {
  things: ScanThing[];
  seconds: number;
}

export interface Health {
  ok: boolean;
  mock: boolean;
  keys: { anthropic: boolean; fal: boolean; elevenlabs: boolean };
  model: string;
}

export const api = {
  identify: (req: IdentifyRequest, opts: CallOptions = {}) =>
    withTimeout('/api/identify', opts.timeoutMs, (signal) =>
      post<IdentifyResponse & ServerFlags>('/api/identify', req, signal),
    ),
  teardown: (req: TeardownRequest) => post<Teardown>('/api/teardown', req),
  generatePart: (req: GeneratePartRequest) =>
    post<GeneratePartResponse & ServerFlags>('/api/generate-part', req),
  scan: (req: ScanRequest, opts: CallOptions = {}) =>
    withTimeout('/api/scan', opts.timeoutMs, (signal) => post<ScanResponse & ServerFlags>('/api/scan', req, signal)),
  agentToken: () => request<AgentTokenResponse>('/api/agent-token'),
  /** #124: one look -> a solid parts list (check it with TeardownSchema), or checked / unknown / mock / fallback. */
  sketch: (req: SketchRequest, opts: CallOptions = {}) =>
    withTimeout('/api/sketch', opts.timeoutMs, (signal) => post<Partial<Teardown> & SketchAnswer>('/api/sketch', req, signal)),
  /** #124: the longer text, safety notes and steps for a sketched parts list (no client limit: it runs in the background). */
  enrich: (req: EnrichRequest) => post<EnrichResponse>('/api/enrich', req),
  /** Rejects with SERVER_DOWN_MESSAGE unless our own server answers. */
  health: async () => {
    const h = await request<unknown>('/api/health');
    if (!isOurHealth(h)) throw serverDown();
    return h;
  },
};
