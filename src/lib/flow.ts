/**
 * The explode pipeline. Plain functions over the store, safe to call from
 * keyboard handlers, the HUD and the voice client tools.
 */
import { useStore, type SceneObject } from '../state/store';
import type { IdentifyResponse, Lens, Teardown } from '../../shared/teardown';
import { isDemoObject, kindOf, mockIdentify } from '../../shared/demo';
import { partPrompt } from '../../shared/prompts';
import { ApiError, SERVER_DOWN_MESSAGE, api, isServerDown, type ServerFlags } from './api';
import { voiceBridge } from '../voice/bridge';
import { stageTeardownFor } from '../stage/armTeardown';
import { setBusyText } from '../hud/hudStore';

/**
 * How long "analyse this" waits for Claude to name a detected object before it goes on with the
 * detector's label, as it does when identify fails (#84). On slow Wi-Fi the call could otherwise
 * take a minute or two. The server's identify call has a matching limit (server/lib/claude.ts).
 */
export const IDENTIFY_TIMEOUT_MS = 4_000;

/**
 * A cached object opened at once from its detector label (the MacBook from "laptop") switches to
 * what Claude names instead only when Claude is at least this sure (#84). Below it, our own
 * MacBook seen from a bad angle stays the MacBook.
 */
export const SWITCH_MIN_CONFIDENCE = 0.7;

/** Bumped by resetAll and each new explode, so stale async results are dropped. */
let runId = 0;
/** Which scene object the current teardown belongs to. */
let explodedSceneId: string | null = null;

export interface ExplodeResult {
  ok: boolean;
  message: string;
}
/**
 * What Claude said a cached guess really is, by scene id, after a confident disagreement (#84), so
 * analysing the same object again goes straight to that and never shows the guess again. Valid only
 * while the scene object still carries that name (a new track reusing the id has no name yet).
 */
const corrected = new Map<string, IdentifyResponse>();

/** The explode in progress, so a second "explode this" for the same object joins it instead of cancelling it. */
let inFlight: { sceneId: string; promise: Promise<ExplodeResult> } | null = null;

/** What "this" means: the named scene object, else the focused one, else the selected one, else the most confident. Any kind. */
function pickTarget(objectId?: string): SceneObject | null {
  const s = useStore.getState();
  const byId = (id: string | null | undefined) => (id ? s.objects.find((o) => o.id === id) ?? null : null);
  if (objectId) {
    const hit = byId(objectId);
    if (hit) return hit;
    // The agent sometimes passes a teardown id ("macbook-air-m3-13") or a made-up one; fall back to "this".
    console.warn(`[flow] no scene object "${objectId}", using the focused object`);
  }
  const direct = byId(s.focusedObjectId) ?? byId(s.selectedObjectId);
  if (direct) return direct;
  if (s.objects.length === 0) return null;
  return s.objects.reduce((a, b) => (b.confidence > a.confidence ? b : a));
}

/** Text pushed to the voice agent after an explode, so it knows the parts without calling get_scene. */
export function describeTeardown(td: Teardown): string {
  const parts = td.parts
    .map((p) => `- ${p.id}: ${p.name}. ${p.summary}${p.safety ? ` SAFETY: ${p.safety}` : ''}`)
    .join('\n');
  const steps = td.steps.map((s) => `${s.n}. ${s.text}`).join('\n');
  return [
    `The user is now looking at an exploded view of: ${td.name} (source: ${td.source}${
      td.source === 'live' ? ', AI-estimated, not checked' : ''
    }).`,
    `Parts (use these ids with highlight_part):\n${parts}`,
    steps ? `Steps (use show_step with n):\n${steps}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** The tutor reads this aloud, so it is short and never a raw error. */
function teardownFailMessage(err: unknown, name: string): string {
  if (isServerDown(err)) return SERVER_DOWN_MESSAGE;
  // Our server's only 404: no checked parts list and no Anthropic key to make one.
  if (err instanceof ApiError && err.status === 404) return `I do not have parts for the ${name} yet.`;
  return `I could not load the parts for the ${name}. Try again in a moment.`;
}

export function explodeObject(objectId?: string): Promise<ExplodeResult> {
  // "Explode this" means Blowfish is on: show the labels if they were off.
  const s = useStore.getState();
  if (!s.overlayOn) s.setOverlayOn(true);
  const target = pickTarget(objectId);
  if (!target) {
    return Promise.resolve({ ok: false, message: 'Nothing in view to explode. Look at an object first.' });
  }
  if (inFlight && inFlight.sceneId === target.id) return inFlight.promise;
  const promise = runExplode(target);
  const entry = { sceneId: target.id, promise };
  inFlight = entry;
  const clear = () => {
    if (inFlight === entry) inFlight = null;
  };
  promise.then(clear, clear);
  return promise;
}

async function runExplode(target: SceneObject): Promise<ExplodeResult> {
  const store = useStore.getState();
  store.selectObject(target.id);
  const froze = target.anchor === 'box' && store.trackingMode === 'freeze';
  if (froze) store.setFrozen(true);

  // Already exploded this object: just open it again.
  if (store.teardown && explodedSceneId === target.id) {
    store.setExplode(1);
    return { ok: true, message: `Exploded ${store.teardown.name}: ${store.teardown.parts.length} parts.` };
  }

  const myRun = ++runId;
  const stale = () => myRun !== runId;
  const fail = (message: string): ExplodeResult => {
    if (stale()) return { ok: false, message: 'Cancelled.' };
    useStore.getState().setTeardownStatus('error', message);
    if (froze) useStore.getState().setFrozen(false);
    return { ok: false, message };
  };
  setBusyText(null);
  store.setTeardownStatus('loading');
  // Which server prompt to use comes from the object itself, never from a UI setting.
  const kind = kindOf(target.label, target.anchor);

  // 1. Identify. The detector's label gives a first guess (shared/demo.ts).
  const guess = mockIdentify(target.label, kind);
  let ident: IdentifyResponse = guess;
  let background: Promise<(IdentifyResponse & ServerFlags) | null> | null = null;
  const fix = corrected.get(target.id);
  if (fix && fix.name === target.name) {
    // Claude already said this is not the cached guess: straight on to what it is.
    ident = fix;
  } else if (isDemoObject(guess.object_id)) {
    // Cached (the MacBook, a hand): never wait on the network. Open it now from the label and ask
    // Claude in the background; its answer is checked once the model is shown (step 5, #84). The
    // server answers a hand itself without asking Claude, so a hand is not sent at all.
    if (target.anchor !== 'hand') background = identifyInBackground(target, kind);
  } else {
    // Anything else waits for Claude, but at most IDENTIFY_TIMEOUT_MS. Any failure except
    // "server not running" (a time-out included) goes on with the detector's label.
    try {
      const crop = useStore.getState().camera?.captureCrop(target.box) ?? null;
      if (crop) {
        ident = await api.identify({ image: crop, lens: kind, hint: target.label }, { timeoutMs: IDENTIFY_TIMEOUT_MS });
      }
    } catch (err) {
      if (isServerDown(err)) return fail(SERVER_DOWN_MESSAGE);
      console.warn('[flow] identify failed or timed out, using the detector label', err);
    }
  }
  if (stale()) return { ok: false, message: 'Cancelled.' };
  useStore.getState().patchObject(target.id, { name: ident.name });

  // 2. Teardown (server is cache-first).
  let td: Teardown;
  try {
    td = await api.teardown({ object_id: ident.object_id, name: ident.name, lens: kind });
  } catch (err) {
    console.warn(`[flow] teardown for ${ident.object_id} failed`, err);
    return fail(teardownFailMessage(err, ident.name));
  }
  if (stale()) return { ok: false, message: 'Cancelled.' };
  // On stage a hand is shown as Kash's 3D arm, so its parts list becomes the arm's (src/stage/armTeardown.ts).
  td = await stageTeardownFor(td);
  if (stale()) return { ok: false, message: 'Cancelled.' };

  // 3. Show it.
  const s = useStore.getState();
  explodedSceneId = target.id;
  s.setTeardown(td);
  s.setExplode(1);
  voiceBridge.sendContextualUpdate(describeTeardown(td));

  // 4. Real meshes in the background. Not for hands: the hand overlay draws from landmarks and ignores mesh_url.
  if (td.anchor !== 'hand') void generateMeshes(td, myRun);

  // 5. A cached object opened from its label: what Claude says it is, when it answers (#84).
  if (background) {
    const opened = td;
    void background.then((answer) => {
      if (answer) checkCachedGuess(target, opened, answer, kind, myRun);
    });
  }

  return { ok: true, message: `Exploded ${td.name}: ${td.parts.length} parts.` };
}

/**
 * Ask Claude what a cached object opened from its detector label really is, without waiting.
 * Resolves null on any failure. No client time limit: the server's identify call has its own
 * (server/lib/claude.ts).
 */
function identifyInBackground(target: SceneObject, kind: Lens): Promise<(IdentifyResponse & ServerFlags) | null> {
  const crop = useStore.getState().camera?.captureCrop(target.box) ?? null;
  if (!crop) return Promise.resolve(null);
  return api.identify({ image: crop, lens: kind, hint: target.label }).catch((err: unknown) => {
    console.warn('[flow] background identify failed; keeping the cached object', err);
    return null;
  });
}

/**
 * Claude's answer for a cached object that is already on screen. Ignored if a newer run started
 * (or a reset) or the server only had its demo mapping (mock / fallback). The same object: patch
 * in the exact name. Something else, and sure (SWITCH_MIN_CONFIDENCE): switch to it, so a guess is
 * never presented as an identification. Something else, unsure: keep the cached object.
 */
function checkCachedGuess(target: SceneObject, opened: Teardown, ident: IdentifyResponse & ServerFlags, kind: Lens, myRun: number): void {
  if (myRun !== runId || explodedSceneId !== target.id || ident.mock || ident.fallback) return;
  if (ident.object_id === opened.object_id) {
    useStore.getState().patchObject(target.id, { name: ident.name });
    return;
  }
  if (ident.confidence < SWITCH_MIN_CONFIDENCE) {
    console.info(
      `[flow] Claude thinks ${target.id} is "${ident.object_id}" (confidence ${ident.confidence}); too unsure, keeping ${opened.object_id}`,
    );
    return;
  }
  console.info(`[flow] Claude says ${target.id} is "${ident.object_id}" (confidence ${ident.confidence}), not ${opened.object_id}: switching`);
  corrected.set(target.id, ident);
  // Registered like an explode, so "analyse this" on the same object meanwhile joins the switch.
  const promise = switchTeardown(target, opened, ident, kind);
  const entry = { sceneId: target.id, promise };
  inFlight = entry;
  const clear = () => {
    if (inFlight === entry) inFlight = null;
  };
  promise.then(clear, clear);
}

/** "a laptop", "an Apple Watch". */
const withArticle = (name: string) => `${/^[aeiou]/i.test(name.trim()) ? 'an' : 'a'} ${name.trim()}`;

/**
 * Replace the cached parts list on screen with the parts of what Claude says the object is: the
 * quiet pill says so while they load, then the new list replaces the old one at the same explode
 * amount (highlight and step cleared). If its parts cannot be loaded the model is put away,
 * rather than leaving the cached parts under another name. The tutor hears of it each time.
 */
async function switchTeardown(target: SceneObject, opened: Teardown, ident: IdentifyResponse, kind: Lens): Promise<ExplodeResult> {
  const myRun = ++runId; // the cached run's mesh jobs stop here
  const stale = () => myRun !== runId;
  const cancelled: ExplodeResult = { ok: false, message: 'Cancelled.' };
  const thing = withArticle(ident.name);
  const store = useStore.getState();
  store.patchObject(target.id, { name: ident.name });
  setBusyText(`This is ${thing}. Getting its parts\u2026`);
  store.setTeardownStatus('loading');
  voiceBridge.sendContextualUpdate(
    `Correction: this is ${thing}, not the ${opened.name}. The ${opened.name} parts list shown so far is wrong for it: ` +
      'stop describing those parts. Its own parts list is loading and will replace it.',
  );

  let td: Teardown;
  try {
    td = await api.teardown({ object_id: ident.object_id, name: ident.name, lens: kind });
    if (stale()) return cancelled;
    td = await stageTeardownFor(td);
  } catch (err) {
    if (stale()) return cancelled;
    console.warn(`[flow] teardown for ${ident.object_id} (switching from ${opened.object_id}) failed`, err);
    const message = `This looks like ${thing}, but I could not get its parts.`;
    putAway();
    setBusyText(null);
    useStore.getState().setTeardownStatus('error', message);
    voiceBridge.sendContextualUpdate(
      `Correction: this is ${thing}, not the ${opened.name}, but its parts could not be loaded. ` +
        `The model was put away and nothing is exploded now. Tell the user: "${message}"`,
    );
    return { ok: false, message };
  }
  if (stale()) return cancelled;

  const s = useStore.getState();
  setBusyText(null);
  s.highlightPart(null);
  s.showStep(null);
  explodedSceneId = target.id;
  s.setTeardown(td); // keeps the explode amount
  voiceBridge.sendContextualUpdate(
    `Correction: this is not the ${opened.name} after all. The earlier parts list is replaced; forget its parts.\n\n${describeTeardown(td)}`,
  );
  if (td.anchor !== 'hand') void generateMeshes(td, myRun);
  return { ok: true, message: `Exploded ${td.name}: ${td.parts.length} parts.` };
}

/** Two fal jobs at a time. Stops on mock mode, skips failures silently. */
async function generateMeshes(td: Teardown, myRun: number) {
  const queue = td.parts.filter((p) => !p.mesh_url);
  let stop = false;
  const worker = async () => {
    while (!stop && queue.length > 0 && myRun === runId) {
      const part = queue.shift()!;
      try {
        const out = await api.generatePart({
          object_id: td.object_id,
          part_id: part.id,
          prompt: partPrompt(td, part),
        });
        if (out.mock) {
          stop = true;
          return;
        }
        const current = useStore.getState().teardown;
        if (out.mesh_url && myRun === runId && current?.object_id === td.object_id) {
          useStore.getState().setPartMesh(part.id, out.mesh_url);
        }
      } catch (err) {
        console.warn(`[flow] mesh for ${part.id} failed`, err);
      }
    }
  };
  await Promise.all([worker(), worker()]);
}

/**
 * A silent pick: a hidden arrow key, a mouse click or gaze dwell. Highlights the part (the card
 * shows) and tells the agent as a contextual update only. Never a user message: that would
 * caption words the wearer did not say. A spoken "tell me about the battery" is the agent
 * calling highlight_part, which does not come through here.
 */
export function pickPart(partId: string): void {
  const s = useStore.getState();
  s.highlightPart(partId);
  const part = s.teardown?.parts.find((p) => p.id === partId);
  if (part) {
    voiceBridge.sendContextualUpdate(
      `The wearer selected the ${part.name} (part id ${part.id}) without speaking; it is highlighted now. ` +
        `Do not reply to this. If they ask about "this part", they mean the ${part.name}.`,
    );
  }
}

/** Drop every run in progress and put the model away (no message to the agent). */
function putAway(): void {
  runId++;
  explodedSceneId = null;
  inFlight = null;
  useStore.getState().resetView();
}

export function resetAll(): void {
  putAway();
  setBusyText(null);
  voiceBridge.sendContextualUpdate('The view was reset. Nothing is exploded now.');
}
