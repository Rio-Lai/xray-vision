/**
 * The explode pipeline. Plain functions over the store, safe to call from
 * keyboard handlers, the HUD and the voice client tools.
 */
import { useStore, type AppState, type SceneObject } from '../state/store';
import type { IdentifyResponse, Lens, Teardown } from '../../shared/teardown';
import { DEMO_IDENTIFY, isDemoObject, kindOf, mockIdentify } from '../../shared/demo';
import { partPrompt } from '../../shared/prompts';
import { ApiError, SERVER_DOWN_MESSAGE, api, isServerDown, isTimeout, type ServerFlags } from './api';
import { voiceBridge } from '../voice/bridge';
import { stageTeardownFor } from '../stage/armTeardown';
import { setBusyText } from '../hud/hudStore';
import { centreDistance, centreRegion, inCentre, pinObject, pinnedIdent, unpinObject } from '../detect/centre';
import { scanIdent } from '../detect/scan';
import { findSaved, keptTeardown, mayKeepPicture, noteAnalysedShot, saveOpened, savedItems, type SavedItem } from './saved';

/**
 * How long "analyse this" waits for Claude to name a detected object before it goes on with the
 * detector's label, as it does when identify fails (#84). On slow Wi-Fi the call could otherwise
 * take a minute or two. The server's identify call has a matching limit (server/lib/claude.ts).
 * 6 s since Opus names objects (#95; 4 s with Sonnet); the server stops at 7 s.
 */
export const IDENTIFY_TIMEOUT_MS = 6_000;

/**
 * A cached object opened at once from its detector label (the MacBook from "laptop") switches to
 * what Claude names instead only when Claude is at least this sure (#84). Below it, our own
 * MacBook seen from a bad angle stays the MacBook.
 */
export const SWITCH_MIN_CONFIDENCE = 0.7;

/**
 * How long "analyse this" waits for Claude to name something in the middle of the view that the
 * detector did not find (#80). Longer than IDENTIFY_TIMEOUT_MS: there is no label to fall back on.
 */
export const CENTRE_IDENTIFY_TIMEOUT_MS = 12_000;

/** Sentences for the tutor and the status pill when the middle of the view cannot be named (#80). */
const NOTHING_IN_VIEW = 'Nothing in view to explode. Look at an object first.';
const CENTRE_NO_CLAUDE = "I can't name that without Claude.";
const CENTRE_UNKNOWN = 'I could not tell what that is. Hold it in the middle of the view and try again.';
const CENTRE_SLOW = 'I could not name that in time. Try again in a moment.';
const CENTRE_FAILED = 'I could not name that just now. Try again in a moment.';

/** inFlight id while the middle of the view is being named and there is no scene object yet. */
const CENTRE_SCAN = '(centre)';

/** Bumped by resetAll and each new explode, so stale async results are dropped. */
let runId = 0;
/** Which scene object the current teardown belongs to. */
let explodedSceneId: string | null = null;
/** That scene object as it was when it was analysed (#97: its label and box are saved with it, even once it is out of view). */
let explodedTarget: SceneObject | null = null;

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

/** Saved models being brought back (#97), by the scene id pinned for them (one at a time, like the pinned object). */
const reopening = new Map<string, SavedItem>();

/** The explode in progress, so a second "explode this" for the same object joins it instead of cancelling it. */
let inFlight: { sceneId: string; promise: Promise<ExplodeResult> } | null = null;

/**
 * What "this" means: the named scene object, else the focused one, else the selected one, else the
 * thing nearest the centre among those whose centre is in the middle of the view. Any kind, hands
 * included. null = nothing detected in the middle: explodeObject then asks Claude what is there (#80).
 */
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
  const region = centreRegion();
  const middle = s.objects.filter((o) => inCentre(o, region));
  if (middle.length === 0) return null;
  return middle.reduce((a, b) => (centreDistance(b) < centreDistance(a) ? b : a));
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
    // #96: short by default; this is background for questions, not a cue to talk.
    'For questions only: do not describe these parts or steps unless the user asks.',
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
  const sceneId = target ? target.id : CENTRE_SCAN;
  if (inFlight && inFlight.sceneId === sceneId) return inFlight.promise;
  // Nothing detected in the middle of the view: ask Claude what is there (#80).
  const promise = target ? runExplode(target) : analyseCentre();
  const entry = { sceneId, promise };
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
  // #97: a saved model being brought back keeps the picture it was saved with. Anything else: its crop
  // now, the moment it is analysed, is its picture if it is put away (never an eye, a hand or a person),
  // and is also what identify gets below, so no second crop is taken.
  const reopen = reopening.get(target.id) ?? null;
  const shot =
    !reopen && mayKeepPicture(target.anchor, kind, target.label, target.name)
      ? useStore.getState().camera?.captureCrop(target.box) ?? null
      : null;
  if (!reopen) noteAnalysedShot(target.id, shot);

  // 1. Identify. The detector's label gives a first guess (shared/demo.ts).
  const guess = mockIdentify(target.label, kind);
  let ident: IdentifyResponse = guess;
  let background: Promise<(IdentifyResponse & ServerFlags) | null> | null = null;
  // Something Claude has already named (in the middle of the view, #80, a correction of a cached
  // guess, #84, or the overlay's whole-view scan, #122) is not asked about again. A detected laptop,
  // hand or eye still opens its stored model below, whatever the scan called it.
  const fix = corrected.get(target.id);
  const known =
    pinnedIdent(target.id) ?? (fix && fix.name === target.name ? fix : null) ?? scanIdent(target, isDemoObject(guess.object_id));
  if (known) {
    ident = known;
  } else if (isDemoObject(guess.object_id)) {
    // Cached (the MacBook, a hand, an eye): never wait on the network. Open it now from the label and
    // ask Claude in the background; its answer is checked once the model is shown (step 5, #84). The
    // server answers a hand or an eye itself without asking Claude, so neither is sent at all: no
    // picture of a face leaves the laptop for an eye (#94).
    if (target.anchor !== 'hand' && target.anchor !== 'face') background = identifyInBackground(target, kind, shot);
  } else {
    // Anything else waits for Claude, but at most IDENTIFY_TIMEOUT_MS. Any failure except
    // "server not running" (a time-out included) goes on with the detector's label.
    try {
      const crop = shot ?? useStore.getState().camera?.captureCrop(target.box) ?? null;
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
    // A saved live (AI-estimated) model reopens from the parts list kept with it (#97); else the server's cache answers.
    const kept = reopen?.kind === 'live' ? keptTeardown(reopen.id) : null;
    td = kept ?? (await api.teardown({ object_id: ident.object_id, name: ident.name, lens: kind }));
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
  explodedTarget = target;
  s.setTeardown(td);
  s.setExplode(1);
  voiceBridge.sendContextualUpdate(describeTeardown(td));

  // 4. Real meshes in the background. Not for hands: the hand overlay draws from landmarks and ignores mesh_url.
  if (td.anchor !== 'hand') void generateMeshes(td, myRun, reopen !== null);

  // 5. A cached object opened from its label: what Claude says it is, when it answers (#84).
  if (background) {
    const opened = td;
    void background.then((answer) => {
      if (answer) checkCachedGuess(target, opened, answer, kind, myRun);
    });
  }

  return { ok: true, message: `Exploded ${td.name}: ${td.parts.length} parts.` };
}

/** Claude's answer is a name, not a shrug ("unknown", or too unsure to build a parts list on). */
function isNamed(ident: IdentifyResponse): boolean {
  const name = ident.name.trim();
  return (
    ident.confidence >= 0.3 &&
    name !== '' &&
    !['unknown', 'unknown-object', 'object', 'nothing', 'none', 'unclear'].includes(ident.object_id) &&
    !/^(unknown|unclear|unidentified|nothing|no object)\b/i.test(name)
  );
}

/**
 * "Analyse this" with nothing detected in the middle of the view (#80): crop the middle (the
 * central 50% x 60%, src/detect/centre.ts), ask Claude what it is (at most
 * CENTRE_IDENTIFY_TIMEOUT_MS; the status pill says "Looking…" meanwhile), add it as a scene object
 * where the crop was, and go on with the normal flow: its parts list (from Claude, as it is not
 * cached), the floating model, fal models as usual. No key, no answer or no clear answer: the pill
 * and the reply say so, and nothing else happens.
 */
async function analyseCentre(): Promise<ExplodeResult> {
  const region = centreRegion();
  const crop = useStore.getState().camera?.captureCrop(region) ?? null;
  if (!crop) return { ok: false, message: NOTHING_IN_VIEW };
  const myRun = ++runId;
  const stale = () => myRun !== runId;
  const fail = (message: string): ExplodeResult => {
    if (stale()) return { ok: false, message: 'Cancelled.' };
    useStore.getState().setTeardownStatus('error', message);
    return { ok: false, message };
  };
  setBusyText(null);
  useStore.getState().setTeardownStatus('loading');

  let ident: Awaited<ReturnType<typeof api.identify>>;
  try {
    // No hint: there is no detector label. The lens is only a hint too; Claude decides.
    ident = await api.identify({ image: crop, lens: 'engineering' }, { timeoutMs: CENTRE_IDENTIFY_TIMEOUT_MS });
  } catch (err) {
    console.warn('[flow] naming the middle of the view failed', err);
    if (isServerDown(err)) return fail(SERVER_DOWN_MESSAGE);
    return fail(isTimeout(err) ? CENTRE_SLOW : CENTRE_FAILED);
  }
  if (stale()) return { ok: false, message: 'Cancelled.' };
  // With no key (mock) or after a failed live call (fallback) the server answers with its demo
  // mapping, which for no label is the MacBook: never pass that off as the thing in view.
  if (ident.mock) return fail(CENTRE_NO_CLAUDE);
  if (ident.fallback) return fail(CENTRE_FAILED);
  if (!isNamed(ident)) return fail(CENTRE_UNKNOWN);

  const obj = pinObject(region, ident);
  // From here a second "analyse this" means this object: it joins, as for any other.
  if (inFlight && inFlight.sceneId === CENTRE_SCAN) inFlight.sceneId = obj.id;
  const result = await runExplode(obj);
  if (!result.ok) {
    // Its parts did not load (or it was cancelled): take the temporary object away again.
    unpinObject(obj.id);
    const s = useStore.getState();
    if (s.selectedObjectId === obj.id) s.selectObject(null);
  }
  return result;
}

/**
 * Ask Claude what a cached object opened from its detector label really is, without waiting.
 * Resolves null on any failure. No client time limit: the server's identify call has its own
 * (server/lib/claude.ts).
 */
function identifyInBackground(target: SceneObject, kind: Lens, shot: string | null): Promise<(IdentifyResponse & ServerFlags) | null> {
  const crop = shot ?? useStore.getState().camera?.captureCrop(target.box) ?? null;
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
  explodedTarget = target;
  s.setTeardown(td); // keeps the explode amount
  voiceBridge.sendContextualUpdate(
    `Correction: this is not the ${opened.name} after all. The earlier parts list is replaced; forget its parts.\n\n${describeTeardown(td)}`,
  );
  if (td.anchor !== 'hand') void generateMeshes(td, myRun);
  return { ok: true, message: `Exploded ${td.name}: ${td.parts.length} parts.` };
}

/**
 * fal models asked for per live (uncached) parts list. A stopgap for the nearly spent fal credit
 * now that #80 makes live objects common (server-side ticket #75): the outermost and largest parts
 * get models, the rest stay placeholder shapes.
 */
export const MAX_LIVE_MESHES = 4;

/** Outermost first, then largest: the order live parts get fal models in. */
function meshOrder(parts: Teardown['parts']): Teardown['parts'] {
  const volume = (p: Teardown['parts'][number]) => p.size[0] * p.size[1] * p.size[2];
  return [...parts].sort((a, b) => a.layer - b.layer || volume(b) - volume(a));
}

/**
 * Two fal jobs at a time. Stops on mock mode, skips failures silently. Live objects: at most MAX_LIVE_MESHES.
 * `reopened` (#97, a saved live model brought back): only the parts it asked fal for the first time
 * (the server has those models cached), never more.
 */
async function generateMeshes(td: Teardown, myRun: number, reopened = false) {
  let queue = td.parts.filter((p) => !p.mesh_url);
  if (td.source === 'live' && reopened) {
    queue = meshOrder(td.parts)
      .slice(0, MAX_LIVE_MESHES)
      .filter((p) => !p.mesh_url);
  } else if (td.source === 'live' && queue.length > MAX_LIVE_MESHES) {
    const wanted = queue.length;
    queue = meshOrder(queue).slice(0, MAX_LIVE_MESHES);
    console.info(`[flow] ${td.object_id}: asking fal for ${queue.length} of ${wanted} part models (${wanted - queue.length} skipped, MAX_LIVE_MESHES)`);
  }
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
  explodedTarget = null;
  inFlight = null;
  unpinObject();
  reopening.clear();
  useStore.getState().resetView();
}

/** #97: save the open parts list (if any) with the scene object it came out of. */
function saveOpen(): SavedItem | null {
  const s = useStore.getState();
  const td = s.teardown;
  if (!td) return null;
  const sceneId = explodedSceneId ?? s.selectedObjectId;
  const obj = (sceneId ? s.objects.find((o) => o.id === sceneId) : undefined) ?? (explodedTarget?.id === sceneId ? explodedTarget : undefined);
  try {
    return saveOpened(td, { id: sceneId, label: obj?.label, name: obj?.name, box: obj?.box });
  } catch (err) {
    console.warn('[flow] could not save the model', err);
    return null;
  }
}

/** "Put it away": saves what was open (#97), then resets. Returns what was saved, if anything. */
export function resetAll(): SavedItem | null {
  const saved = saveOpen();
  putAway();
  setBusyText(null);
  voiceBridge.sendContextualUpdate(
    saved
      ? `The view was reset and the ${saved.name} was saved: explode with object_id "${saved.id}" brings it back. ` +
          'Nothing is exploded now; for "analyse this", call explode without object_id.'
      : 'The view was reset. Nothing is exploded now.',
  );
  return saved;
}

/* ---------- bringing a saved model back (#97) ---------- */

/** Pin a scene object for a saved model (as centre.ts / eyeTeardown.ts do), where it was when it was open. */
function pinSaved(item: SavedItem): SceneObject {
  const eye = item.glyph === 'eye';
  const hand = !eye && item.anchor === 'hand';
  // The arm reopens as the arm: the hand's parts list becomes the arm's on stage (stageTeardownFor).
  const ident: IdentifyResponse = eye
    ? DEMO_IDENTIFY.eye
    : hand
      ? DEMO_IDENTIFY.hand
      : { object_id: item.id, name: item.name, confidence: 1, summary: '' };
  const obj = pinObject(item.box, ident, { label: eye ? 'eye' : hand ? 'hand' : item.label, anchor: eye ? 'face' : hand ? 'hand' : 'box' });
  reopening.clear();
  reopening.set(obj.id, item);
  return obj;
}

/** Whether a scene object in view is the same thing as a saved model. */
function isSameThing(o: SceneObject, item: SavedItem): boolean {
  if (item.glyph === 'eye') return o.anchor === 'face';
  if (item.anchor === 'hand') return o.anchor === 'hand';
  if (o.anchor !== 'box') return false;
  const name = item.name.toLowerCase();
  return (
    (o.name ?? '').toLowerCase() === name ||
    o.label.toLowerCase() === item.label.toLowerCase() ||
    mockIdentify(o.label, o.lens).object_id === item.id
  );
}

/**
 * For explode's `object_id` (#97): a saved id or name ("macbook", "the watch", "bring back the eye",
 * case-insensitive, partial). The same thing in view wins (its scene id); else the saved model is
 * pinned in view, so it opens even when the object is not there. undefined: `objectId` names a
 * scene object, or nothing saved matches (resolve it as before).
 */
export function resolveSavedObjectId(objectId: string, s: Pick<AppState, 'objects'>): string | undefined {
  const raw = objectId.trim();
  if (s.objects.some((o) => o.id === raw)) return undefined;
  const item = findSaved(raw);
  if (!item) return undefined;
  const same = s.objects.find((o) => isSameThing(o, item));
  return same ? same.id : pinSaved(item).id;
}

/**
 * #109: the saved model's id when scene object `sceneId` was pinned to bring that model back because
 * the thing itself is not in view (the stage then lifts it out of its saved pill), else null.
 */
export function reopenedSavedId(sceneId: string | null): string | null {
  return sceneId ? reopening.get(sceneId)?.id ?? null : null;
}

/** Open a saved model by its id (the saved pills; the wearer uses voice). */
export function bringBack(id: string): Promise<ExplodeResult> {
  const item = savedItems().find((i) => i.id === id);
  if (!item) return Promise.resolve({ ok: false, message: 'Nothing is saved by that name.' });
  return explodeObject(pinSaved(item).id);
}
