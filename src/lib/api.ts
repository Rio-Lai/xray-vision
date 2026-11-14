/** Typed client for the server routes. All calls go through the Vite proxy at /api. */
import type {
  AgentTokenResponse,
  GeneratePartRequest,
  GeneratePartResponse,
  IdentifyRequest,
  IdentifyResponse,
  Teardown,
  TeardownRequest,
} from '../../shared/teardown';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const b = body as { message?: string; error?: string } | null;
    throw new ApiError(b?.message ?? b?.error ?? `${path} failed (${res.status})`, res.status, body);
  }
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
  health: () => request<Health>('/api/health'),
};
