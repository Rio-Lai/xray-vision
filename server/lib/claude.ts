import type { IdentifyRequest, IdentifyResponse, Teardown, TeardownRequest } from '../../shared/teardown';

// Stage 1 stubs. The routes only call these when ANTHROPIC_API_KEY is set.
export async function identifyLive(_req: IdentifyRequest): Promise<IdentifyResponse> {
  throw new Error('identifyLive not implemented yet');
}

export async function teardownLive(_req: TeardownRequest): Promise<Teardown> {
  throw new Error('teardownLive not implemented yet');
}
