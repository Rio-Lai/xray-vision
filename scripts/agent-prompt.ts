/**
 * npm run agent:prompt: put the repo's system prompt and first message (docs/agent/) into the
 * ElevenLabs agent, so nobody copies them by hand (#96).
 *
 *   npm run agent:prompt              dry run: reads the agent, compares its prompt and first message
 *                                     with docs/agent/, changes nothing
 *   npm run agent:prompt -- --apply   saves the agent's whole config to .agent-backup/<id>-<time>.json,
 *                                     then PATCHes only conversation_config.agent.prompt.prompt and
 *                                     conversation_config.agent.first_message, then reads it back
 *
 *   GET / PATCH https://api.elevenlabs.io/v1/convai/agents/{ELEVENLABS_AGENT_ID}   (xi-api-key)
 *
 * Tools, voice, language and every other setting are never sent. Written from the documented API and
 * NOT yet tested against the live API: run the dry run first. As in scripts/check.ts, .env fills in
 * what the shell has not set, key values are never printed, and every network step fails soft.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv({ path: path.join(ROOT, '.env') });

const PROMPT_FILE = path.join(ROOT, 'docs', 'agent', 'system-prompt.md');
const FIRST_FILE = path.join(ROOT, 'docs', 'agent', 'first-message.txt');
const BACKUP_DIR = path.join(ROOT, '.agent-backup');
const TIMEOUT_MS = 15000;
const UNTESTED = 'Untested against the live ElevenLabs API (written from its documented shape): check what it prints.';

const env = (name: string) => (process.env[name] ?? '').trim();
const KEY = env('ELEVENLABS_API_KEY');
const AGENT_ID = env('ELEVENLABS_AGENT_ID');

/** The key never reaches the screen, even inside a provider message. */
function redact(text: string): string {
  const out = KEY.length >= 6 ? text.split(KEY).join('[key]') : text;
  return out.replace(/\s+/g, ' ').trim().slice(0, 180);
}

const say = (mark: '✓' | '✗' | '!' | '·', text: string) => console.log(`  ${mark} ${text}`);

/* ---------- http ---------- */

type HttpResult = { kind: 'http'; status: number; body: unknown } | { kind: 'network'; reason: string };

async function request(method: 'GET' | 'PATCH', body?: unknown): Promise<HttpResult> {
  const url = `https://api.elevenlabs.io/v1/convai/agents/${encodeURIComponent(AGENT_ID)}`;
  try {
    const res = await fetch(url, {
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

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/** ElevenLabs errors: { detail: { message } | string }. */
function withMessage(status: number, body: unknown): string {
  const b = rec(body);
  const d = b.detail;
  const m = [rec(d).message, d, b.message, typeof body === 'string' ? body : undefined].find((x) => typeof x === 'string' && x.trim());
  return typeof m === 'string' ? `${status}: ${redact(m)}` : `${status}`;
}

/** A plain sentence for a failed read of the agent. */
function readFailure(r: HttpResult): string {
  if (r.kind === 'network') return `Could not reach api.elevenlabs.io (${r.reason}).`;
  if (r.status === 401 || r.status === 403) return `ElevenLabs refused the key (${withMessage(r.status, r.body)}): it must be valid and allowed to use ElevenLabs Agents.`;
  if (r.status === 404 || r.status === 400 || r.status === 422) return `ELEVENLABS_AGENT_ID does not name an agent this key can see (${withMessage(r.status, r.body)}).`;
  return `Unexpected answer reading the agent (${withMessage(r.status, r.body)}).`;
}

/* ---------- where the two fields are ---------- */

type FieldPath = readonly string[];
/** The documented place (and the one the PATCH writes) first, then shapes other clients use. */
const PROMPT_PATHS: FieldPath[] = [
  ['conversation_config', 'agent', 'prompt', 'prompt'],
  ['conversationConfig', 'agent', 'prompt', 'prompt'],
  ['agent', 'prompt', 'prompt'],
];
const FIRST_PATHS: FieldPath[] = [
  ['conversation_config', 'agent', 'first_message'],
  ['conversationConfig', 'agent', 'firstMessage'],
  ['agent', 'first_message'],
];

interface Found {
  value: string;
  path: string;
  /** At the documented path, where the PATCH writes. */
  expected: boolean;
}

function find(body: unknown, paths: FieldPath[]): Found | null {
  for (const [i, p] of paths.entries()) {
    const parent = p.slice(0, -1).reduce<unknown>((o, k) => rec(o)[k], body);
    const key = p[p.length - 1];
    if (!parent || typeof parent !== 'object' || !(key in parent)) continue;
    const v = rec(parent)[key];
    // An unset first message may come back as null at the documented path.
    if (typeof v === 'string' || (v === null && i === 0)) return { value: v ?? '', path: p.join('.'), expected: i === 0 };
  }
  return null;
}

const norm = (s: string) => s.replace(/\r\n?/g, '\n').trim();
const cut = (s: string, n = 100) => (s.length > n ? `${s.slice(0, n)}...` : s);

/** Same / different, lengths, and the first differing line. */
function compare(label: string, found: Found | null, repo: string): boolean {
  if (!found) {
    say('✗', `${label}: not found in the agent's answer (looked at ${label === 'System prompt' ? PROMPT_PATHS[0].join('.') : FIRST_PATHS[0].join('.')} and fallbacks)`);
    return false;
  }
  const where = found.expected ? '' : ` (found at ${found.path}, not where expected)`;
  const a = norm(found.value);
  if (a === repo) {
    say('✓', `${label}: same as the repo (${repo.length} characters)${where}`);
    return true;
  }
  say('!', `${label}: different. Agent ${a.length} characters, repo ${repo.length}${where}`);
  const al = a.split('\n');
  const rl = repo.split('\n');
  const i = al.findIndex((line, n) => line !== rl[n]);
  const n = i === -1 ? al.length : i;
  say('·', `first differing line: ${n + 1}`);
  say('·', `  agent: ${n < al.length ? JSON.stringify(cut(al[n])) : '(ends here)'}`);
  say('·', `  repo:  ${n < rl.length ? JSON.stringify(cut(rl[n])) : '(ends here)'}`);
  return false;
}

/* ---------- read back: nothing else changed ---------- */

function without(body: unknown): unknown {
  const copy = JSON.parse(JSON.stringify(rec(body).conversation_config ?? null)) as unknown;
  const agent = rec(rec(copy).agent);
  delete agent.first_message;
  delete rec(agent.prompt).prompt;
  return copy;
}

function diffPaths(a: unknown, b: unknown, at: string, out: string[]): void {
  if (out.length >= 8 || a === b) return;
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) diffPaths(rec(a)[k], rec(b)[k], at ? `${at}.${k}` : k, out);
    return;
  }
  out.push(at || '(whole config)');
}

/* ---------- main ---------- */

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  console.log(`Blowfish agent prompt: ${apply ? 'APPLY' : 'dry run (changes nothing; add -- --apply to update the agent)'}`);
  console.log(`  ${UNTESTED}`);
  for (const a of args.filter((x) => x !== '--apply')) say('!', `ignoring unknown argument ${JSON.stringify(a)}`);

  let repoPrompt: string;
  let repoFirst: string;
  try {
    repoPrompt = norm(fs.readFileSync(PROMPT_FILE, 'utf8'));
    repoFirst = norm(fs.readFileSync(FIRST_FILE, 'utf8'));
  } catch {
    say('✗', 'Could not read docs/agent/system-prompt.md or docs/agent/first-message.txt. Run this from the repo.');
    return 1;
  }
  if (!repoPrompt || !repoFirst) {
    say('✗', 'docs/agent/system-prompt.md or docs/agent/first-message.txt is empty: nothing to send.');
    return 1;
  }
  if (!KEY || !AGENT_ID) {
    const missing = [!KEY && 'ELEVENLABS_API_KEY', !AGENT_ID && 'ELEVENLABS_AGENT_ID'].filter(Boolean).join(' and ');
    say('✗', `No ${missing} in .env: add it (docs/ROHAN.md, "Setup") and run this again.`);
    return 1;
  }

  const before = await request('GET');
  if (before.kind === 'network' || before.status !== 200) {
    say('✗', `${readFailure(before)} Nothing was changed.`);
    return 1;
  }
  const name = rec(before.body).name;
  say('✓', `Agent found${typeof name === 'string' && name.trim() ? `: "${redact(name)}"` : ' (no name in the answer)'}`);
  const curPrompt = find(before.body, PROMPT_PATHS);
  const curFirst = find(before.body, FIRST_PATHS);
  const samePrompt = compare('System prompt', curPrompt, repoPrompt);
  const sameFirst = compare('First message', curFirst, repoFirst);

  if (samePrompt && sameFirst) {
    console.log('\nThe agent already has the repo\'s prompt and first message. Nothing to do.');
    return 0;
  }
  if (!apply) {
    console.log('\nDry run: nothing was changed. To put the repo\'s text into the agent: npm run agent:prompt -- --apply');
    return 0;
  }

  // Refuse unless both are where the PATCH writes them: otherwise the API's shape is not the one this was written for.
  if (!curPrompt?.expected || !curFirst?.expected) {
    const which = [!curPrompt?.expected && PROMPT_PATHS[0].join('.'), !curFirst?.expected && FIRST_PATHS[0].join('.')].filter(Boolean).join(' and ');
    const verb = which.includes(' and ') ? 'are' : 'is';
    say('✗', `Refusing to apply: the agent's current ${which} ${verb} not where expected, so the API may have changed. Nothing was changed.`);
    say('·', 'Paste docs/agent/system-prompt.md and docs/agent/first-message.txt into the dashboard by hand (docs/ROHAN.md, "Setup").');
    return 1;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(BACKUP_DIR, `${AGENT_ID.replace(/[^A-Za-z0-9_-]/g, '_')}-${stamp}.json`);
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.writeFileSync(backup, `${JSON.stringify(before.body, null, 2)}\n`);
  } catch (err) {
    say('✗', `Could not save the backup (${redact(err instanceof Error ? err.message : String(err))}). Nothing was changed.`);
    return 1;
  }
  say('✓', `Backup of the agent's current config: ${path.relative(ROOT, backup)}`);

  // Only these two fields: no tools, voice, language or anything else.
  const patch = await request('PATCH', { conversation_config: { agent: { first_message: repoFirst, prompt: { prompt: repoPrompt } } } });
  if (patch.kind === 'network') {
    say('✗', `The update did not get an answer (${patch.reason}). The agent may or may not have changed: run npm run agent:prompt to see.`);
    return 1;
  }
  if (patch.status < 200 || patch.status >= 300) {
    say('✗', `ElevenLabs refused the update (${withMessage(patch.status, patch.body)}). Nothing should have changed; run npm run agent:prompt to see.`);
    return 1;
  }
  say('✓', `Update sent (${patch.status}).`);

  const after = await request('GET');
  if (after.kind === 'network' || after.status !== 200) {
    say('✗', `${readFailure(after)} Could not read the agent back to confirm: run npm run agent:prompt to check.`);
    return 1;
  }
  const newPrompt = find(after.body, PROMPT_PATHS);
  const newFirst = find(after.body, FIRST_PATHS);
  const okPrompt = newPrompt !== null && norm(newPrompt.value) === repoPrompt;
  const okFirst = newFirst !== null && norm(newFirst.value) === repoFirst;
  say(okPrompt ? '✓' : '✗', `System prompt ${okPrompt ? 'now matches the repo' : 'does not match the repo after the update'}`);
  say(okFirst ? '✓' : '✗', `First message ${okFirst ? 'now matches the repo' : 'does not match the repo after the update'}`);

  const changed: string[] = [];
  diffPaths(without(before.body), without(after.body), 'conversation_config', changed);
  if (changed.length) {
    say('✗', `Other settings differ from the backup: ${changed.join(', ')}. Check the agent in the dashboard; the old values are in ${path.relative(ROOT, backup)}.`);
  } else {
    say('✓', 'Nothing else in conversation_config changed (tools, voice, language as before).');
  }
  if (!okPrompt || !okFirst) {
    say('·', 'If the dashboard shows the new text as an unpublished draft, publish it there; otherwise paste it by hand (docs/ROHAN.md, "Setup").');
  }
  return okPrompt && okFirst && changed.length === 0 ? 0 : 1;
}

/** Exit once stdout is flushed, so idle keep-alive sockets do not hold the process open. */
const exit = (code: number) => process.stdout.write('', () => process.exit(code));
main().then(exit, (err: unknown) => {
  console.error(`npm run agent:prompt stopped: ${redact(err instanceof Error ? err.message : String(err))}`);
  exit(1);
});
