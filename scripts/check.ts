/**
 * npm run check: do the keys in .env really work, and is the voice agent set up? About ten seconds,
 * and it spends no credit: it only lists models, reads the agent and its tools, makes one signed URL
 * and reads fal's price list.
 *
 *   Claude      GET /v1/models and /v1/models/{ANTHROPIC_MODEL}            (x-api-key)
 *   ElevenLabs  GET /v1/convai/agents/{id}, /v1/convai/tools/{tool_id},
 *               GET /v1/convai/conversation/get-signed-url                 (xi-api-key)
 *   fal         GET https://api.fal.ai/v1/models/pricing                   (Authorization: Key)
 *   Local       .env (PORT, MOCK), ports 8791 / 5173, MediaPipe files, checked parts lists
 *
 * Key values are never printed or logged, and each key is sent only to its own provider. Keys are
 * judged only by the provider's answer, never by how they look. Every network step fails soft.
 * Exit code 0 only when the MacBook-and-hand demo with voice would work. The offline side (Wi-Fi off)
 * is `npm run predemo`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config as loadEnv, parse as parseEnv } from 'dotenv';
import { CLIENT_TOOL_NAMES } from '../shared/teardown';
import { DEMO_IDENTIFY } from '../shared/demo';
import { CHECKED_DIR, ROOT, readCheckedTeardown } from '../server/lib/cache';
import { DEFAULT_PORT, WEB_PORT, anthropicEffort, anthropicModel, apiPort, portInUseMessage } from '../server/lib/env';
import { isBlowfish, taken } from '../server/lib/ports';

const ENV_FILE = path.join(ROOT, '.env');
// Same as the server: .env fills in what the shell has not set.
loadEnv({ path: ENV_FILE });

const TIMEOUT_MS = 8000;
const env = (name: string) => (process.env[name] ?? '').trim();

/* ---------- output ---------- */

type Level = 'ok' | 'fail' | 'warn' | 'info';
interface Item {
  level: Level;
  text: string;
  fix?: string;
  /** true: the MacBook-and-hand demo with voice would not work (sets the exit code). */
  blocks?: boolean;
}
const ok = (text: string): Item => ({ level: 'ok', text });
const info = (text: string): Item => ({ level: 'info', text });
const warn = (text: string, fix?: string): Item => ({ level: 'warn', text, fix });
const fail = (text: string, fix?: string, blocks = false): Item => ({ level: 'fail', text, fix, blocks });

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const MARK: Record<Level, string> = {
  ok: paint('32', '✓'),
  fail: paint('31', '✗'),
  warn: paint('33', '!'),
  info: paint('2', '·'),
};

/** Every key value, so no provider message can echo one back to the screen. */
const SECRETS = ['ANTHROPIC_API_KEY', 'FAL_KEY', 'ELEVENLABS_API_KEY'].map(env).filter((v) => v.length >= 6);
function redact(text: string): string {
  let out = text;
  for (const s of SECRETS) out = out.split(s).join('[key]');
  return out.replace(/\s+/g, ' ').trim().slice(0, 180);
}

/* ---------- http ---------- */

type HttpResult = { kind: 'http'; status: number; body: unknown } | { kind: 'network'; reason: string };

function networkReason(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } } | null;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return `no answer within ${TIMEOUT_MS / 1000} s`;
  const code = e?.cause?.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'no network (DNS lookup failed)';
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT') return `connection failed (${code})`;
  return redact(e?.cause?.message ?? e?.message ?? String(err));
}

async function getJson(url: string, headers: Record<string, string>): Promise<HttpResult> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { kind: 'http', status: res.status, body };
  } catch (err) {
    return { kind: 'network', reason: networkReason(err) };
  }
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** The provider's own error text: Anthropic and fal { error: { message } }, ElevenLabs { detail: { message } | string }. */
function providerMessage(body: unknown): string {
  const b = rec(body);
  const detail = b.detail;
  const msg =
    str(rec(b.error).message) ??
    str(b.error) ??
    str(rec(detail).message) ??
    str(detail) ??
    str(b.message) ??
    (typeof body === 'string' ? str(body) : undefined);
  return msg ? redact(msg) : '';
}
const withMessage = (status: number, body: unknown) => {
  const m = providerMessage(body);
  return m ? `${status}: ${m}` : `${status}`;
};

/* ---------- Claude ---------- */

async function checkClaude(): Promise<Item[]> {
  const key = env('ANTHROPIC_API_KEY');
  if (!key) {
    return [
      warn(
        'Claude: no ANTHROPIC_API_KEY',
        "the MacBook and hand still open from the cache; a judge's object cannot be analysed. Add the key to .env and restart npm run dev.",
      ),
    ];
  }
  // The Anthropic SDK in server/lib/claude.ts honours ANTHROPIC_BASE_URL too.
  const base = (env('ANTHROPIC_BASE_URL') || 'https://api.anthropic.com').replace(/\/+$/, '');
  const host = new URL(base).host;
  const headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  const items: Item[] = [];
  if (host !== 'api.anthropic.com') items.push(info(`Claude: ANTHROPIC_BASE_URL is set, so checking against ${host}`));

  const list = await getJson(`${base}/v1/models?limit=100`, headers);
  if (list.kind === 'network') {
    return [...items, fail(`Claude: could not reach ${host} (${list.reason})`, 'check the network, then run npm run check again.')];
  }
  if (list.status === 401) {
    return [
      ...items,
      fail(
        `Claude key rejected (${withMessage(list.status, list.body)})`,
        'make an API key at console.anthropic.com > API keys (a Claude.ai or Claude Code login is not an API key), put it in .env as ANTHROPIC_API_KEY, restart npm run dev.',
      ),
    ];
  }
  if (list.status === 403) {
    return [...items, fail(`Claude key not allowed (${withMessage(list.status, list.body)})`, 'check the key is active and its organisation has API access and credit.')];
  }
  if (list.status !== 200) {
    return [...items, fail(`Claude: unexpected answer from ${host} (${withMessage(list.status, list.body)})`, 'try again in a minute.')];
  }
  items.push(ok('Claude key valid'));

  const ids = (Array.isArray(rec(list.body).data) ? (rec(list.body).data as unknown[]) : [])
    .map((m) => str(rec(m).id))
    .filter((x): x is string => Boolean(x));
  const model = anthropicModel();
  const one = await getJson(`${base}/v1/models/${encodeURIComponent(model)}`, headers);
  if (one.kind === 'network') {
    items.push(warn(`Claude: could not check ANTHROPIC_MODEL ${model} (${one.reason})`));
  } else if (one.status === 200) {
    const shown = str(rec(one.body).display_name);
    items.push(ok(`ANTHROPIC_MODEL ${model} exists${shown ? ` (${shown})` : ''}`));
    items.push(info(`Claude effort: ${anthropicEffort('teardown')} for parts lists (ANTHROPIC_EFFORT), ${anthropicEffort('identify')} for naming (ANTHROPIC_IDENTIFY_EFFORT)`));
  } else if (one.status === 404) {
    items.push(
      fail(
        `ANTHROPIC_MODEL ${model} is not available to this key`,
        ids.length ? `set ANTHROPIC_MODEL in .env to one of: ${ids.slice(0, 6).join(', ')}` : 'set ANTHROPIC_MODEL in .env to a model this key can use.',
      ),
    );
  } else {
    items.push(warn(`Claude: could not check ANTHROPIC_MODEL ${model} (${withMessage(one.status, one.body)})`));
  }
  return items;
}

/* ---------- ElevenLabs ---------- */

interface FoundTool {
  name: string;
  type: string;
  expectsResponse: boolean | undefined;
}

const TOOL_TYPES = new Set(['client', 'webhook', 'system', 'mcp', 'api_integration_webhook']);

/**
 * Collects tools anywhere in an agent or tool response, whatever the nesting: inline tools
 * (conversation_config.agent.prompt.tools on older agents) and tool_config objects (the toolbox),
 * plus every tool id the agent references (prompt.tool_ids on newer agents).
 */
function collectTools(node: unknown, tools: Map<string, FoundTool>, ids: Set<string>, depth = 0): void {
  if (depth > 25 || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const x of node) collectTools(x, tools, ids, depth + 1);
    return;
  }
  const o = node as Record<string, unknown>;
  const name = str(o.name);
  const type = str(o.type);
  if (name && type && TOOL_TYPES.has(type)) {
    const prev = tools.get(name);
    // A client definition wins over any other kind with the same name.
    if (!prev || (prev.type !== 'client' && type === 'client')) {
      tools.set(name, { name, type, expectsResponse: typeof o.expects_response === 'boolean' ? o.expects_response : undefined });
    }
  }
  for (const [k, v] of Object.entries(o)) {
    if (k === 'tool_ids' && Array.isArray(v)) {
      for (const id of v) if (typeof id === 'string' && id.trim()) ids.add(id.trim());
    } else {
      collectTools(v, tools, ids, depth + 1);
    }
  }
}

async function checkElevenLabs(): Promise<Item[]> {
  const key = env('ELEVENLABS_API_KEY');
  const agentId = env('ELEVENLABS_AGENT_ID');
  if (!key || !agentId) {
    const missing = [!key && 'ELEVENLABS_API_KEY', !agentId && 'ELEVENLABS_AGENT_ID'].filter(Boolean).join(' and ');
    return [fail(`ElevenLabs: no ${missing} in .env, so voice is off`, 'add both (docs/ROHAN.md, "Setup") and restart npm run dev.', true)];
  }
  const base = 'https://api.elevenlabs.io';
  const headers = { 'xi-api-key': key };
  const items: Item[] = [];

  const agent = await getJson(`${base}/v1/convai/agents/${encodeURIComponent(agentId)}`, headers);
  if (agent.kind === 'network') {
    return [fail(`ElevenLabs: could not reach api.elevenlabs.io (${agent.reason})`, 'voice needs the network: check it, then run npm run check again.', true)];
  }
  if (agent.status === 401 || agent.status === 403) {
    const status = str(rec(rec(agent.body).detail).status) ?? '';
    if (/permission/i.test(status) || /permission/i.test(providerMessage(agent.body))) {
      return [
        fail(
          `ElevenLabs key is valid but may not read agents (${withMessage(agent.status, agent.body)})`,
          'in ElevenLabs > Developers > API keys, give this key access to ElevenLabs Agents (or use a key without restrictions), then update .env.',
          true,
        ),
      ];
    }
    return [
      fail(
        `ElevenLabs key rejected (${withMessage(agent.status, agent.body)})`,
        'make a new key in ElevenLabs > Developers > API keys, put it in .env as ELEVENLABS_API_KEY, restart npm run dev.',
        true,
      ),
    ];
  }
  if (agent.status === 404 || agent.status === 400 || agent.status === 422) {
    return [
      ok('ElevenLabs key valid'),
      fail(
        `ElevenLabs: ELEVENLABS_AGENT_ID does not name an agent this key can see (${withMessage(agent.status, agent.body)})`,
        "copy the Agent ID from the Blowfish agent's page in the ElevenLabs dashboard (same account as the key) into .env.",
        true,
      ),
    ];
  }
  if (agent.status !== 200) {
    return [fail(`ElevenLabs: unexpected answer reading the agent (${withMessage(agent.status, agent.body)})`, 'try again in a minute.', true)];
  }
  const agentName = str(rec(agent.body).name);
  items.push(ok('ElevenLabs key valid'));
  items.push(ok(`ElevenLabs agent found${agentName ? `: "${agentName}"` : ''}`));

  // The signed URL the app asks for (server/routes/agent-token.ts). Never printed: it is a credential.
  const signed = await getJson(`${base}/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`, headers);
  if (signed.kind === 'network') items.push(fail(`ElevenLabs: could not make a signed URL (${signed.reason})`, undefined, true));
  else if (signed.status === 200 && str(rec(signed.body).signed_url)) items.push(ok('signed URL created, so the voice session can connect'));
  else items.push(fail(`ElevenLabs: could not make a signed URL (${withMessage(signed.status, signed.body)})`, 'check the key may use ElevenLabs Agents and the agent id is right.', true));

  items.push(...(await checkAgentTools(agent.body, base, headers)));
  return items;
}

async function checkAgentTools(agentBody: unknown, base: string, headers: Record<string, string>): Promise<Item[]> {
  const items: Item[] = [];
  const tools = new Map<string, FoundTool>();
  const ids = new Set<string>();
  collectTools(agentBody, tools, ids);

  // Newer agents reference toolbox tools by id; read each one.
  const unreadable: string[] = [];
  await Promise.all(
    [...ids].slice(0, 40).map(async (id) => {
      const r = await getJson(`${base}/v1/convai/tools/${encodeURIComponent(id)}`, headers);
      if (r.kind === 'http' && r.status === 200) collectTools(r.body, tools, new Set<string>());
      else unreadable.push(r.kind === 'network' ? r.reason : withMessage(r.status, r.body));
    }),
  );
  if (unreadable.length) {
    items.push(warn(`could not read ${unreadable.length} of the agent's ${ids.size} tools by id (${unreadable[0]})`, 'the list below may be incomplete.'));
  }

  const want = [...CLIENT_TOOL_NAMES] as string[];
  const client = [...tools.values()].filter((t) => t.type === 'client');
  const clientNames = new Set(client.map((t) => t.name));
  const notClient = want.filter((n) => !clientNames.has(n));
  // New tools not yet on the agent only warn: adjust_view (npm run agent:tools -- --apply adds it).
  const SOFT_TOOLS = new Set(['adjust_view']);
  // Old tools the app still answers (src/voice/clientTools.ts legacyClientTools): never "extra".
  const LEGACY_TOOLS = new Set(['zoom_model']);
  const missingSoft = notClient.filter((n) => !tools.has(n) && SOFT_TOOLS.has(n));
  const missing = notClient.filter((n) => !tools.has(n) && !SOFT_TOOLS.has(n));
  const wrongType = notClient.filter((n) => tools.has(n)).map((n) => `${n} is a ${tools.get(n)!.type} tool`);
  const extra = client.map((t) => t.name).filter((n) => !want.includes(n) && !LEGACY_TOOLS.has(n));
  const notWaiting = client.filter((t) => want.includes(t.name) && t.expectsResponse === false).map((t) => t.name);
  const unknownWait = client.filter((t) => want.includes(t.name) && t.expectsResponse === undefined).map((t) => t.name);
  const present = want.filter((n) => clientNames.has(n));

  if (client.length === 0) {
    items.push(
      fail(
        `no client tools found on the agent (the app needs ${want.length}: ${want.join(', ')})`,
        'add them as Client tools with "Wait for response" ticked (docs/ROHAN.md, "Client tools to enter in the dashboard").',
        true,
      ),
    );
    return items;
  }
  items.push(info(`client tools on the agent: ${client.map((t) => t.name).sort().join(', ')}`));
  if (missing.length) {
    items.push(
      fail(
        `missing client tools: ${missing.join(', ')}`,
        'add each as a Client tool, named exactly as shown, with "Wait for response" ticked (docs/ROHAN.md).',
        true,
      ),
    );
  }
  if (missingSoft.length) {
    items.push(
      warn(
        `client tools not on the agent yet: ${missingSoft.join(', ')}`,
        'run npm run agent:tools -- --apply (or add each as a Client tool with "Wait for response" ticked, docs/ROHAN.md); until then the agent cannot call it.',
      ),
    );
  }
  if (wrongType.length) {
    items.push(fail(`wrong tool type: ${wrongType.join(', ')}`, 'the app answers only Client tools: delete it and add it again as a Client tool.', true));
  }
  if (notWaiting.length) {
    items.push(fail(`not set to wait for a response: ${notWaiting.join(', ')}`, 'in the dashboard open each one and tick "Wait for response".', true));
  }
  if (unknownWait.length) {
    items.push(warn(`the agent did not say whether these wait for a response: ${unknownWait.join(', ')}`, 'check "Wait for response" is ticked on each in the dashboard.'));
  }
  if (extra.length) {
    items.push(warn(`extra client tools the app does not answer: ${extra.join(', ')}`, 'remove them, or the agent may call a tool nobody answers.'));
  }
  if (notClient.length === missingSoft.length && !notWaiting.length) {
    const of = missingSoft.length ? ` of ${want.length}` : '';
    items.push(ok(`all ${present.length}${of} client tools match CLIENT_TOOL_NAMES${unknownWait.length ? '' : ' and wait for a response'}`));
  }
  return items;
}

/* ---------- fal ---------- */

async function checkFal(): Promise<Item[]> {
  const key = env('FAL_KEY');
  if (!key) return [warn('fal: no FAL_KEY', 'the MacBook has all its models cached; only a new object needs fal. Add the key to .env for live models.')];
  const models = [env('FAL_IMAGE_MODEL') || 'fal-ai/flux/schnell', env('FAL_3D_MODEL') || 'fal-ai/hunyuan3d/v2/turbo'];
  // Reading the price list needs a valid key and runs no model, so it costs nothing.
  const r = await getJson(`https://api.fal.ai/v1/models/pricing?endpoint_id=${models.map(encodeURIComponent).join(',')}`, {
    Authorization: `Key ${key}`,
  });
  if (r.kind === 'network') return [warn(`fal key present, not verified (could not reach api.fal.ai: ${r.reason})`)];
  if (r.status === 401 || r.status === 403) {
    return [fail(`fal key rejected (${withMessage(r.status, r.body)})`, 'make a new key at fal.ai > Dashboard > Keys, put it in .env as FAL_KEY, restart npm run dev.')];
  }
  if (r.status !== 200) return [warn(`fal key present, not verified (price list answered ${withMessage(r.status, r.body)})`)];
  const prices = (Array.isArray(rec(r.body).prices) ? (rec(r.body).prices as unknown[]) : [])
    .map((p) => {
      const o = rec(p);
      return typeof o.unit_price === 'number' ? `${str(o.endpoint_id) ?? '?'} ${o.unit_price} ${str(o.currency) ?? ''} per ${str(o.unit) ?? 'unit'}` : null;
    })
    .filter((x): x is string => Boolean(x));
  return [ok('fal key accepted'), ...(prices.length ? [info(`fal prices: ${prices.join('; ')}`)] : [])];
}

/* ---------- local ---------- */

function checkEnvFile(): Item[] {
  if (!fs.existsSync(ENV_FILE)) {
    return [fail('.env is missing', 'cp .env.example .env, add the keys, then run npm run check again.', true)];
  }
  const items: Item[] = [];
  let fileEnv: Record<string, string> = {};
  try {
    fileEnv = parseEnv(fs.readFileSync(ENV_FILE));
  } catch {
    /* unreadable: the checks above already used process.env */
  }
  const port = (fileEnv.PORT ?? '').trim();
  if (!port) items.push(ok(`PORT not set in .env (API on the default ${DEFAULT_PORT})`));
  else if (port === '8787') items.push(fail('PORT=8787 in .env: other dev tools use 8787 (that is what broke the first run)', 'delete the PORT line from .env.'));
  else items.push(warn(`PORT=${port} left in .env (default ${DEFAULT_PORT})`, 'fine if it is free (see below); delete the line to use the default.'));
  if (env('MOCK') === '1') items.push(fail('MOCK=1: every route answers from the cache and voice is off', 'set MOCK=0 in .env (or delete the line).', true));
  return items;
}

async function checkPorts(): Promise<Item[]> {
  let port: number;
  try {
    port = apiPort();
  } catch (err) {
    return [fail(err instanceof Error ? err.message : String(err), undefined, true)];
  }
  const items: Item[] = [];
  if (!(await taken(port, ['127.0.0.1']))) items.push(ok(`port ${port} (API server) is free`));
  else if (await isBlowfish(port)) items.push(ok(`port ${port} (API server) is used by a running Blowfish server`));
  else items.push(fail(`port ${port} (API server) is used by another program`, portInUseMessage(port, false).split('\n').join(' '), true));

  if (!(await taken(WEB_PORT, ['127.0.0.1', '::1']))) items.push(ok(`port ${WEB_PORT} (app) is free`));
  else if ((await isBlowfish(WEB_PORT, '127.0.0.1')) || (await isBlowfish(WEB_PORT, '[::1]'))) items.push(ok(`port ${WEB_PORT} (app) is used by the running app`));
  else {
    items.push(
      fail(
        `port ${WEB_PORT} (app) is in use and does not answer as Blowfish (an older npm run dev, or another Vite app?)`,
        `stop it with Ctrl+C in its terminal; to see what it is (macOS): lsof -nP -iTCP:${WEB_PORT} -sTCP:LISTEN`,
        true,
      ),
    );
  }
  return items;
}

function checkVisionModels(): Item[] {
  const dir = path.join(ROOT, 'public', 'models');
  const big = (f: string) => {
    try {
      return fs.statSync(path.join(dir, f)).size > 100_000; // fetchLocalModel in src/detect/mediapipe.ts
    } catch {
      return false;
    }
  };
  const present = (f: string) => fs.existsSync(path.join(dir, f));
  const missing = [
    !big('efficientdet_lite0.tflite') && 'object model',
    !big('efficientdet_lite2.tflite') && 'object model Lite2',
    !big('hand_landmarker.task') && 'hand model',
    !big('face_landmarker.task') && 'face model',
    !(present('wasm/vision_wasm_internal.js') && present('wasm/vision_wasm_internal.wasm')) && 'wasm',
  ].filter((x): x is string => Boolean(x));
  if (missing.length === 0) return [ok('MediaPipe models and wasm are on this laptop (public/models/)')];
  return [
    warn(
      `MediaPipe ${missing.join(', ')} not on this laptop: the app downloads them from storage.googleapis.com and jsDelivr at every start (needs the network)`,
      'run npm run predemo (or npm run fetch-models) once to keep them local.',
    ),
  ];
}

function checkCache(): Item[] {
  const items: Item[] = [];
  const files = fs.existsSync(CHECKED_DIR) ? fs.readdirSync(CHECKED_DIR).filter((f) => f.endsWith('.json')).sort() : [];
  const demoIds = new Set(Object.values(DEMO_IDENTIFY).map((d) => d.object_id));
  for (const id of demoIds) {
    if (!files.includes(`${id}.json`)) items.push(fail(`demo object ${id}: no public/cache/${id}.json`, 'restore it from main (git checkout origin/main -- public/cache).', true));
  }
  for (const f of files) {
    const id = f.slice(0, -'.json'.length);
    const td = readCheckedTeardown(id);
    if (!td) {
      items.push(fail(`public/cache/${f} does not match the parts-list schema, so the server skips it`, 'see the [cache] error above.', demoIds.has(id)));
      continue;
    }
    const withModel = td.parts.filter((p) => {
      const url = p.mesh_url?.trim();
      if (!url || !url.startsWith('/')) return false;
      return fs.existsSync(path.join(ROOT, 'public', ...url.split(/[?#]/)[0].split('/').filter(Boolean)));
    }).length;
    const label = `${td.name} (${id}): ${td.parts.length} parts`;
    if (td.anchor === 'hand' && withModel === 0) items.push(ok(`${label}, drawn on the real hand (no models needed)`));
    else if (withModel === td.parts.length) items.push(ok(`${label}, all with 3D models`));
    else items.push(warn(`${label}, ${withModel} with 3D models`, 'the others show placeholder shapes (and ask fal when FAL_KEY works).'));
  }
  if (files.length === 0) items.push(fail('no checked parts lists in public/cache/', undefined, true));
  return items;
}

/* ---------- main ---------- */

function print(title: string, items: Item[]) {
  console.log(`\n${paint('1', title)}`);
  for (const it of items) {
    console.log(`  ${MARK[it.level]} ${it.text}${it.blocks ? paint('31', '  (blocks the demo)') : ''}`);
    if (it.fix) console.log(`      ${paint('2', 'fix:')} ${it.fix}`);
  }
}

async function main() {
  console.log('Blowfish check: keys, voice agent, ports, models (no credit spent; key values are never shown)');
  const [claude, eleven, falItems, ports] = await Promise.all([checkClaude(), checkElevenLabs(), checkFal(), checkPorts()]);
  const local = [...checkEnvFile(), ...ports, ...checkVisionModels(), ...checkCache()];

  print('Voice (ElevenLabs)', eleven);
  print('Claude', claude);
  print('fal', falItems);
  print('This laptop', local);

  const all = [...eleven, ...claude, ...falItems, ...local];
  const blockers = all.filter((i) => i.level === 'fail' && i.blocks);
  const otherFails = all.filter((i) => i.level === 'fail' && !i.blocks);
  console.log('');
  if (blockers.length === 0) {
    console.log(`${MARK.ok} MacBook-and-hand demo with voice: ready.`);
  } else {
    console.log(`${MARK.fail} MacBook-and-hand demo with voice: not ready. Fix the lines marked "blocks the demo".`);
  }
  if (otherFails.length) {
    console.log(`  ${otherFails.length} other problem(s) above do not stop that demo, but break live objects (Claude, fal) or the port setup.`);
  }
  console.log('  With the Wi-Fi off? Run npm run predemo: it checks the offline side (models, wasm, every 3D model).');
  return blockers.length === 0 ? 0 : 1;
}

/** Exit once stdout is flushed, so idle keep-alive sockets do not hold the process open. */
const exit = (code: number) => process.stdout.write('', () => process.exit(code));
main().then(exit, (err: unknown) => {
  console.error(`npm run check stopped: ${redact(err instanceof Error ? err.message : String(err))}`);
  exit(1);
});
