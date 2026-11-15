/**
 * npm run predetail: make the pre-made detail models ahead of the demo, so they open at once (`?detail=1`).
 *
 *   npm run predetail              every topic in docs/detail-topics.json that is not kept yet
 *   npm run predetail -- --force   make every one again
 *
 * Uses exactly the code POST /api/detail uses (server/lib/detail.ts, Claude via server/lib/claude.ts) and
 * writes the same disk cache, .cache-live/detail/<key>.json (gitignored). These are still AI-made, unreviewed
 * models: they are only generated ahead of time, and the app still shows them as "AI sketch".
 * Prints one line per topic. As in scripts/check.ts, .env fills in what the shell has not set; key values
 * are never printed. Exit code 1 if any topic has no model afterwards.
 */
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { ROOT } from '../server/lib/cache';
import { hasAnthropic } from '../server/lib/env';
import { DetailError, PREMADE_FILE, getDetail, readPremades } from '../server/lib/detail';

loadEnv({ path: path.join(ROOT, '.env') });

async function main() {
  const force = process.argv.includes('--force');
  const topics = readPremades();
  if (topics.length === 0) {
    console.error(`No topics in ${path.relative(ROOT, PREMADE_FILE)}.`);
    process.exit(1);
  }
  console.log(`${topics.length} topics from ${path.relative(ROOT, PREMADE_FILE)}; Claude key: ${hasAnthropic() ? 'yes' : 'no'}${force ? '; --force: making every one again' : ''}`);
  let missing = 0;
  // One at a time: each is a single Claude call of 20 to 40 s, and the log stays readable.
  for (const t of topics) {
    const label = t.object ? `${t.object}: ${t.topic}` : t.topic;
    try {
      const hit = await getDetail({ topic: t.topic, object: t.object }, { force });
      const what = hit.from === 'claude' ? `made in ${hit.seconds} s` : `already kept (${hit.from})`;
      console.log(`  ok    ${hit.key}  "${hit.scene.title}", ${hit.scene.parts.length} parts, ${hit.scene.animations.length} animations, ${hit.scene.steps.length} steps, ${what}`);
    } catch (err) {
      missing++;
      if (err instanceof DetailError && err.kind === 'noKey') console.log(`  miss  ${label}: not kept yet, and no Claude key to make it`);
      else console.log(`  FAIL  ${label}: ${err instanceof DetailError ? `${err.say} (${err.message})` : err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(missing ? `${missing} of ${topics.length} topics have no model yet.` : `All ${topics.length} topics are kept in .cache-live/detail/.`);
  process.exit(missing ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
