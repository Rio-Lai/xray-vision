/**
 * npm run agent:tools: the ElevenLabs agent's client tools against docs/agent/tools.json, so nobody
 * types a new tool into the dashboard by hand.
 *
 *   npm run agent:tools              dry run: reads the agent and its tools, says which client tools
 *                                     are there, which are missing and which are set up wrong; changes nothing
 *   npm run agent:tools -- --apply   saves the agent's whole config to .agent-backup/<id>-<time>.json, adds
 *                                     only the missing client tools, then reads the agent back
 *
 * How it adds a tool: newer agents keep their tools in the workspace and list them by id
 * (conversation_config.agent.prompt.tool_ids). The tool is created with POST /v1/convai/tools (or an
 * existing workspace client tool with the same name is reused), and its id is added to tool_ids with a
 * PATCH that sends only tool_ids. Agents with their tools written inline (prompt.tools, the older
 * shape) get the new tool added to that list instead. Tools already on the agent are never changed:
 * one that is set up wrong is reported, to fix in the dashboard.
 *
 * After the update it reads the agent back. If the system prompt or anything else in the agent changed
 * (the API replaced the whole prompt instead of merging), it puts the backed-up prompt settings back.
 * Written from the documented API and NOT yet tested against the live API: run the dry run first. As
 * in scripts/check.ts, .env fills in what the shell has not set, key values are never printed, and
 * every network step fails soft.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { CLIENT_TOOL_NAMES } from '../shared/teardown';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv({ path: path.join(ROOT, '.env') });

const TOOLS_FILE = path.join(ROOT, 'docs', 'agent', 'tools.json');
const BACKUP_DIR = path.join(ROOT, '.agent-backup');
const BASE = 'https://api.elevenlabs.io';
const TIMEOUT_MS = 15000;
const UNTESTED = 'Untested against the live ElevenLabs API (written from its documented shape): check what it prints.';

const env = (name: string) => (process.env[name] ?? '').trim();
const KEY = env('ELEVENLABS_API_KEY');
const AGENT_ID = env('ELEVENLABS_AGENT_ID');

function redact(text: string): string {
  const out = KEY.length >= 6 ? text.split(KEY).join('[key]') : text;
  return out.replace(/\s+/g, ' ').trim().slice(0, 180);
}

const say = (mark: '✓' | '✗' | '!' | '·', text: string) => console.log(`  ${mark} ${text}`);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/* ---------- http ---------- */

type HttpResult = { kind: 'http'; status: number; body: unknown } | { kind: 'network'; reason: string };

async function request(method: 'GET' | 'POST' | 'PATCH', urlPath: string, body?: unknown): Promise<HttpResult> {
  try {
    const res = await fetch(`${BASE}${urlPath}`, {
      method,
      headers: { 'xi-api-key': KEY, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { kind: 'http', status: res.status, body: parsed };
  } catch (err) {
    const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } } | null;
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return { kind: 'network', reason: `no answer within ${TIMEOUT_MS / 1000} s` };
    const code = e?.cause?.code;
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { kind: 'network', reason: 'no network (DNS lookup failed)' };
    return { kind: 'network', reason: redact(e?.cause?.message ?? e?.message ?? String(err)) };
  }
}

const isOk = (r: HttpResult): r is { kind: 'http'; status: number; body: unknown } => r.kind === 'http' && r.status >= 200 && r.status < 300;

function withMessage(r: HttpResult): string {
  if (r.kind === 'network') return r.reason;
  const b = rec(r.body);
  const d = b.detail;
  const fromList = Array.isArray(d) ? d.map((x) => str(rec(x).msg)).filter(Boolean).join('; ') : undefined;
  const m = [rec(d).message, d, fromList, b.message, typeof r.body === 'string' ? r.body : undefined].find((x) => typeof x === 'string' && x.trim());
  return typeof m === 'string' ? `${r.status}: ${redact(m)}` : `${r.status}`;
}

const agentPath = () => `/v1/convai/agents/${encodeURIComponent(AGENT_ID)}`;

/* ---------- the agent's tools ---------- */

interface ToolDef {
  type: string;
  name: string;
  description: string;
  [k: string]: unknown;
}

interface OnAgent {
  name: string;
  type: string;
  expectsResponse: boolean | undefined;
  /** workspace tool id (tool_ids shape); undefined for an inline tool */
  id?: string;
}

interface AgentTools {
  /** conversation_config.agent.prompt, as read */
  prompt: Record<string, unknown> | null;
  inline: unknown[];
  ids: string[];
  tools: Map<string, OnAgent>;
  unreadable: string[];
}

const promptOf = (agent: unknown): Record<string, unknown> | null => {
  const p = rec(rec(rec(agent).conversation_config).agent).prompt;
  return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
};

const toolConfigOf = (body: unknown): Record<string, unknown> => {
  const b = rec(body);
  return b.tool_config && typeof b.tool_config === 'object' ? rec(b.tool_config) : b;
};

function remember(map: Map<string, OnAgent>, cfg: Record<string, unknown>, id?: string): void {
  const name = str(cfg.name);
  const type = str(cfg.type);
  if (!name || !type) return;
  const prev = map.get(name);
  if (prev && prev.type === 'client') return;
  map.set(name, { name, type, expectsResponse: typeof cfg.expects_response === 'boolean' ? cfg.expects_response : undefined, id });
}

async function readAgentTools(agent: unknown): Promise<AgentTools> {
  const prompt = promptOf(agent);
  const inline = Array.isArray(prompt?.tools) ? (prompt!.tools as unknown[]) : [];
  const ids = Array.isArray(prompt?.tool_ids) ? (prompt!.tool_ids as unknown[]).filter((x): x is string => typeof x === 'string' && !!x.trim()) : [];
  const tools = new Map<string, OnAgent>();
  for (const t of inline) remember(tools, rec(t));
  const unreadable: string[] = [];
  await Promise.all(
    ids.map(async (id) => {
      const r = await request('GET', `/v1/convai/tools/${encodeURIComponent(id)}`);
      if (isOk(r)) remember(tools, toolConfigOf(r.body), id);
      else unreadable.push(`${id} (${withMessage(r)})`);
    }),
  );
  return { prompt, inline, ids, tools, unreadable };
}

/** Workspace client tools by name, to reuse one made by an earlier run instead of making a second. */
async function workspaceClientTools(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const r = await request('GET', '/v1/convai/tools');
  if (!isOk(r)) return out;
  const list = Array.isArray(rec(r.body).tools) ? (rec(r.body).tools as unknown[]) : Array.isArray(r.body) ? (r.body as unknown[]) : [];
  for (const t of list) {
    const id = str(rec(t).id);
    const cfg = toolConfigOf(t);
    const name = str(cfg.name);
    if (id && name && cfg.type === 'client' && !out.has(name)) out.set(name, id);
  }
  return out;
}

/* ---------- read back: nothing else changed ---------- */

/** conversation_config without the tool lists. */
function withoutTools(agent: unknown): unknown {
  const copy = JSON.parse(JSON.stringify(rec(agent).conversation_config ?? null)) as unknown;
  const p = rec(rec(rec(copy).agent).prompt);
  delete p.tools;
  delete p.tool_ids;
  return copy;
}

function diffPaths(a: unknown, b: unknown, at: string, out: string[]): void {
  if (out.length >= 8 || a === b) return;
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) diffPaths((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], at ? `${at}.${k}` : k, out);
    return;
  }
  out.push(at || '(whole config)');
}

/* ---------- main ---------- */

function report(want: ToolDef[], found: AgentTools): { missing: ToolDef[]; wrong: string[] } {
  const missing: ToolDef[] = [];
  const wrong: string[] = [];
  for (const def of want) {
    const t = found.tools.get(def.name);
    if (!t) {
      say('✗', `${def.name}: not on the agent`);
      missing.push(def);
    } else if (t.type !== 'client') {
      say('!', `${def.name}: on the agent as a ${t.type} tool, not a client tool (delete it in the dashboard, then run this again)`);
      wrong.push(def.name);
    } else if (t.expectsResponse === false) {
      say('!', `${def.name}: does not wait for a response (tick "Wait for response" on it in the dashboard)`);
      wrong.push(def.name);
    } else {
      say('✓', `${def.name}${t.expectsResponse === undefined ? ' (could not see "Wait for response")' : ''}`);
    }
  }
  const extra = [...found.tools.values()].filter((t) => t.type === 'client' && !want.some((d) => d.name === t.name)).map((t) => t.name);
  if (extra.length) say('·', `other client tools on the agent (left alone): ${extra.join(', ')}`);
  if (found.unreadable.length) say('!', `could not read ${found.unreadable.length} tool(s) by id: ${found.unreadable[0]}`);
  return { missing, wrong };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  console.log(`Blowfish agent tools: ${apply ? 'APPLY' : 'dry run (changes nothing; add -- --apply to add the missing tools)'}`);
  console.log(`  ${UNTESTED}`);
  for (const a of args.filter((x) => x !== '--apply')) say('!', `ignoring unknown argument ${JSON.stringify(a)}`);

  let want: ToolDef[];
  try {
    const file = JSON.parse(fs.readFileSync(TOOLS_FILE, 'utf8')) as { tools?: unknown };
    want = (Array.isArray(file.tools) ? file.tools : []).filter((t): t is ToolDef => !!str(rec(t).name) && rec(t).type === 'client');
  } catch (err) {
    say('✗', `Could not read docs/agent/tools.json (${redact(err instanceof Error ? err.message : String(err))}). Run this from the repo.`);
    return 1;
  }
  const names = new Set(want.map((t) => t.name));
  const notInFile = (CLIENT_TOOL_NAMES as readonly string[]).filter((n) => !names.has(n));
  if (notInFile.length) say('!', `docs/agent/tools.json lacks ${notInFile.join(', ')} (in CLIENT_TOOL_NAMES): they are not checked`);
  if (!KEY || !AGENT_ID) {
    const missing = [!KEY && 'ELEVENLABS_API_KEY', !AGENT_ID && 'ELEVENLABS_AGENT_ID'].filter(Boolean).join(' and ');
    say('✗', `No ${missing} in .env: add it (docs/ROHAN.md, "Setup") and run this again.`);
    return 1;
  }

  const before = await request('GET', agentPath());
  if (!isOk(before)) {
    say('✗', `Could not read the agent (${withMessage(before)}). Nothing was changed.`);
    return 1;
  }
  const agentName = str(rec(before.body).name);
  say('✓', `Agent found${agentName ? `: "${redact(agentName)}"` : ''}`);
  const found = await readAgentTools(before.body);
  if (!found.prompt) {
    say('✗', 'The agent has no conversation_config.agent.prompt in its answer, so the API is not the shape this was written for. Nothing was changed.');
    return 1;
  }
  const shape = found.ids.length > 0 || found.inline.length === 0 ? 'ids' : 'inline';
  say('·', shape === 'ids' ? `tools listed by id (${found.ids.length} in tool_ids)` : `tools written inline (${found.inline.length} in prompt.tools)`);
  const { missing, wrong } = report(want, found);

  if (!missing.length) {
    console.log(`\n${wrong.length ? 'Nothing to add; fix the tools marked ! in the dashboard.' : 'The agent has every client tool. Nothing to do.'}`);
    return wrong.length ? 1 : 0;
  }
  if (!apply) {
    console.log(`\nDry run: nothing was changed. To add ${missing.map((t) => t.name).join(', ')}: npm run agent:tools -- --apply`);
    return 0;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(BACKUP_DIR, `${AGENT_ID.replace(/[^A-Za-z0-9_-]/g, '_')}-tools-${stamp}.json`);
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.writeFileSync(backup, `${JSON.stringify(before.body, null, 2)}\n`);
  } catch (err) {
    say('✗', `Could not save the backup (${redact(err instanceof Error ? err.message : String(err))}). Nothing was changed.`);
    return 1;
  }
  say('✓', `Backup of the agent's current config: ${path.relative(ROOT, backup)}`);

  let patchBody: unknown;
  if (shape === 'ids') {
    const existing = await workspaceClientTools();
    const newIds: string[] = [];
    for (const def of missing) {
      const reuse = existing.get(def.name);
      if (reuse) {
        say('✓', `${def.name}: reusing the workspace tool made earlier (${reuse})`);
        newIds.push(reuse);
        continue;
      }
      const made = await request('POST', '/v1/convai/tools', { tool_config: def });
      const id = isOk(made) ? str(rec(made.body).id) : undefined;
      if (!id) {
        say('✗', `Could not create ${def.name} (${withMessage(made)}). The agent was not changed. Add it by hand: docs/ROHAN.md, "Client tools to enter in the dashboard".`);
        return 1;
      }
      say('✓', `${def.name}: created in the workspace (${id})`);
      newIds.push(id);
    }
    patchBody = { conversation_config: { agent: { prompt: { tool_ids: [...found.ids, ...newIds.filter((id) => !found.ids.includes(id))] } } } };
  } else {
    patchBody = { conversation_config: { agent: { prompt: { tools: [...found.inline, ...missing] } } } };
  }

  const patch = await request('PATCH', agentPath(), patchBody);
  if (!isOk(patch)) {
    say('✗', `ElevenLabs refused the update (${withMessage(patch)}). Nothing should have changed; run npm run agent:tools to see.`);
    say('·', 'Or add the missing tools by hand: docs/ROHAN.md, "Client tools to enter in the dashboard".');
    return 1;
  }
  say('✓', `Update sent (${patch.status}).`);

  let after = await request('GET', agentPath());
  if (!isOk(after)) {
    say('✗', `Could not read the agent back (${withMessage(after)}): run npm run agent:tools to check.`);
    return 1;
  }

  // Only the tool lists should differ. If the PATCH replaced the whole prompt (the system prompt or the
  // LLM settings changed), put the backed-up prompt settings back with the new tool list.
  const changed: string[] = [];
  diffPaths(withoutTools(before.body), withoutTools(after.body), 'conversation_config', changed);
  if (changed.some((p) => p.startsWith('conversation_config.agent.prompt'))) {
    say('!', `The update also changed ${changed.filter((p) => p.startsWith('conversation_config.agent.prompt')).join(', ')}: putting the backed-up prompt settings back`);
    const restored = { ...found.prompt } as Record<string, unknown>;
    const afterPrompt = promptOf(after.body) ?? {};
    if (shape === 'ids') {
      delete restored.tools;
      restored.tool_ids = afterPrompt.tool_ids;
    } else {
      restored.tools = afterPrompt.tools;
    }
    const heal = await request('PATCH', agentPath(), { conversation_config: { agent: { prompt: restored } } });
    if (!isOk(heal)) {
      say('✗', `Could not put them back (${withMessage(heal)}). Run npm run agent:prompt -- --apply for the system prompt, and check the LLM settings in the dashboard against ${path.relative(ROOT, backup)}.`);
      return 1;
    }
    const again = await request('GET', agentPath());
    if (!isOk(again)) {
      say('✗', `Could not read the agent back (${withMessage(again)}): run npm run agent:tools to check.`);
      return 1;
    }
    after = again;
    changed.length = 0;
    diffPaths(withoutTools(before.body), withoutTools(after.body), 'conversation_config', changed);
  }

  const now = await readAgentTools(after.body);
  console.log('\nAfter the update:');
  const result = report(want, now);
  if (changed.length) {
    say('!', `Other settings differ from the backup: ${changed.join(', ')}. Check them in the dashboard; the old values are in ${path.relative(ROOT, backup)}.`);
  } else {
    say('✓', 'Nothing else in the agent changed (prompt, voice, language as before).');
  }
  if (result.missing.length) {
    say('·', 'If the dashboard shows the change as an unpublished draft, publish it there; otherwise add the tools by hand (docs/ROHAN.md).');
    return 1;
  }
  console.log('\nDone. Restart npm run dev (or start a new voice session) so the agent uses them.');
  return changed.length || result.wrong.length ? 1 : 0;
}

const exit = (code: number) => process.stdout.write('', () => process.exit(code));
main().then(exit, (err: unknown) => {
  console.error(`npm run agent:tools stopped: ${redact(err instanceof Error ? err.message : String(err))}`);
  exit(1);
});
