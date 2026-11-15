# Contracts

The source of truth is code: `shared/teardown.ts` (schemas and API shapes) and `src/state/store.ts` (app state). This page explains how they are used. Ask the team before changing a field.

## Teardown JSON

See `TeardownSchema` in `shared/teardown.ts`. Conventions:

- `id`: kebab-case, unique within the teardown.
- `layer`: 0 = outermost, nearest the camera. Higher = deeper. Sets explode order.
- `visual` (optional, per part): one plain phrase saying what the part looks like. Used only to write the fal image prompt (`partPrompt` in `shared/prompts.ts`); never shown or spoken.
  - Laptop: camera looks down at an open laptop's keyboard deck. Keyboard and display are 0, bottom case is deepest.
  - Hand: camera looks down at the back of a typing hand. Skin is 0, then extensor tendons, bones, the small hand muscles, the forearm flexors, and the palm pads (thenar, hypothenar) deepest.
- `size`: [width, height, depth] as fractions of the anchor box.
- `offset`: [x, y] of the part centre from the anchor centre, as fractions of the anchor box (-0.5..0.5). **y uses image convention: +y is down**, same as `Box` in the store. Vision: flip y if your scene is y-up.
- `source`: `cached` = checked by a human; `live` = Claude just made it. Show "AI-estimated" for live.
- `safety`: null or one sentence. The tutor always mentions it.
- `mesh_url`: null until fal makes a GLB.

## API

All JSON. The Vite dev server proxies `/api` to the local API server on `127.0.0.1` (default port 8791; `PORT` in `.env` moves both; one definition in `server/lib/env.ts`).

| Route | Request | Response |
| --- | --- | --- |
| `POST /api/identify` | `IdentifyRequest` `{ image, lens, hint? }` (image = base64 JPEG, no `data:` prefix) | `IdentifyResponse` `{ object_id, name, confidence, summary }` plus optional flags `mock`, `fallback`, `shortcut`, `error` |
| `POST /api/teardown` | `TeardownRequest` `{ object_id, name, lens }` | `Teardown`; 404 in mock mode when no cache file exists |
| `POST /api/generate-part` | `GeneratePartRequest` `{ object_id, part_id, prompt }` | `GeneratePartResponse` `{ image_url, mesh_url, cached }`; `mock: true` with empty urls when there is no `FAL_KEY` |
| `GET /api/agent-token` | none | `{ signed_url }`; 503 `{ error: "voice_not_configured", message }` without ElevenLabs keys |
| `GET /api/health` | none | `{ ok, mock, keys: { anthropic, fal, elevenlabs }, model }` (booleans only, never key values) |

Mock mode: a route with its key missing (or `MOCK=1`) answers from the cache.

- identify: hint containing "laptop" -> `macbook-air-m3-13`; "hand" -> `hand-finger-muscles` (see `shared/demo.ts`). A hand always maps to `hand-finger-muscles`, even with a key. There are no lenses: the `lens` value in a request is only an internal hint (`kindOf(label, anchor)` in `shared/demo.ts`: hand -> biology, anything else -> engineering); the user never sees or sets it.
- teardown: cache-first always. Order: `public/cache/<id>.json`, then `.cache-live/<id>.json`, then Claude.
- generate-part: checked GLB in `public/cache/meshes/`, then `.cache-live/meshes.json`, then fal.

## Flow (`src/lib/flow.ts`)

- `explodeObject(objectId?)`: target = objectId (if it names a scene object), else focused, else selected, else the thing nearest the centre among those whose box centre is in the middle of the view (the central 50% x 60%, `src/detect/centre.ts`). If nothing is detected there, the middle of the view is cropped and sent to `/api/identify` with no hint (up to 12 s); the named thing is added as a temporary scene object `centre-N` (republished by the engine while selected, removed on reset) and the normal flow continues; if it cannot be named (no key, time-out, unsure) the status pill and the reply say so in one sentence and nothing else happens (#80). Turns the overlay on (`setOverlayOn(true)`) if it was off. Selects it, freezes the frame for box anchors in freeze mode (unfreezes again if loading fails), identifies, loads the teardown, sets explode to 1, tells the voice agent, then fetches meshes in the background (two at a time; never for `anchor: 'hand'`). A second call for the same object while one is loading joins it. Returns `{ ok, message }`. On failure `message` is one sentence the tutor can say: "I do not have parts for the <name> yet." (no checked parts list and no Anthropic key), "Blowfish server is not running. Check the terminal where npm run dev was started.", or "I could not load the parts for the <name>. Try again in a moment."
- Naming (#84): a cached demo object (the MacBook from a `laptop` label; a hand) opens at once from the detector label and Claude is asked in the background. Same `object_id`: the exact name is patched in. A different `object_id` with confidence >= 0.7 (`SWITCH_MIN_CONFIDENCE`): the app says so, loads that object's parts list and replaces the one on screen (the agent gets a "Correction" contextual update); if that fails the model is put away with one sentence. A different id below 0.7: the cached object stays. Any other detected object waits for Claude at most 4 s (`IDENTIFY_TIMEOUT_MS`), then goes on with the detector label. The server's identify call has a 5 s limit (11 s with no hint) and no retry.
- fal (#80, stopgap for #75): a live (uncached) parts list asks fal for at most 4 part models (`MAX_LIVE_MESHES`, outermost and largest first). Cached parts with a `mesh_url`, hands and the arm never ask fal.
- `pickPart(partId)`: a silent pick (hidden arrow keys, mouse click, gaze dwell): highlights the part and sends the agent a contextual update naming it, never a user message, so no caption appears of words the wearer did not say; a spoken question goes through the `highlight_part` tool instead.
- `resetAll()`: `store.resetView()` and drops any in-flight explode.
- `describeTeardown(td)`: the text sent to the agent as a contextual update.

## Client tools (`src/voice/clientTools.ts`)

Names match `CLIENT_TOOL_NAMES`. Each takes a parameters object and returns a string (often JSON). All must be set to "wait for response" in the ElevenLabs dashboard.

| Tool | Params | Does | Returns |
| --- | --- | --- | --- |
| `get_scene` | none | reads the store | JSON: overlay_on, objects, focused id, teardown parts (id, name, summary, safety), status, explode amount, highlight, step |
| `set_overlay` | `on` (boolean) | `true` = label what is in view ("Hey Blowfish, overlay on"); `false` = clean view, also resets | text |
| `select_object` | `object_id?` | selects it (default: focused) | text |
| `explode` | `object_id?`, `amount?` | `amount` 0 collapses; otherwise loads and explodes (default 1) | text, e.g. "Exploded MacBook Air 13-inch (M3, 2024): 12 parts." |
| `highlight_part` | `part_id` | highlights; accepts an id or a loose name | JSON: part id, name, summary, details, safety |
| `show_step` | `n` | sets `activeStep` | JSON: step text and part ids |
| `reset_view` | none | `resetAll()` | text |
| `rotate_model` | `direction` ("left", "right", "up", "down", "around"), `degrees?` (default 45; "around" = 180) | turns the floating model (`store.rotateModel`) | text |
| `get_pose` | none | reads hands | JSON: per hand: handedness, finger curl and pressing, activeFinger, action, muscles (part ids) |

There is no `set_lens` tool: Blowfish has no lenses.

`get_pose` muscle mapping: index, middle, ring or pinky pressing -> `fdp`, `fds`, `flexor-tendons`; thumb pressing -> `fpl`, `thenar`; active finger not pressing (lifting) -> `extensor-digitorum`.

### A hand on stage is the arm (#74)

- In stage mode (the default), a hand's parts list is replaced after loading by Kash's arm, `object_id` `arm-hand` (`public/cache/arm-hand/teardown.json`, mapped to a valid `Teardown` in `src/stage/armTeardown.ts`; the schema is unchanged). 21 parts, layers 0 (skin) to 5, six steps. `isArmTeardown(td)` tells the two apart. In freeze or follow mode a hand keeps `hand-finger-muscles`, drawn on the real hand.
- The arm is drawn by its own renderer (`src/overlay/ArmStage.tsx`, Kash's `ArmXrayView`), driven by the same store fields as any model: `explodeAmount`, `modelYaw`, `modelPitch`, `highlightedPartId`, `activeStep`; `resetAll()` puts it away. No Pose model: the arm stands in a fixed typing pose.
- `explode`: `object_id` `"arm-hand"`, `"arm"` or `"hand"` means the hand in view. For the arm the reply adds `layers` and `steps`, and its `next` asks for `show_step` 1 to 6 instead of a part-by-part tour.
- `highlight_part` adds `nerve`, `typing_role`, `layer` for arm parts. `show_step` opens the arm if it is closed and adds `layer`, `parts`, `typing_roles`, and `clinical_note` on the last step.
- `get_pose`: while the arm is on stage the muscle ids are the arm's: pressing finger -> `forearm-flexors`, `flexor-tendons`; thumb -> `thenar`, `forearm-flexors`; lifting -> `forearm-extensors`, `extensor-tendons`. The `arm` field (Kash's typing detector) is always present.
- fal is never called for a hand or the arm.

## Store rules

- `src/state/store.ts` is the only shared state. Read with `useStore(selector)` in React, `useStore.getState()` elsewhere.
- detect writes `objects`, `focusedObjectId`, `hands`. The camera module calls `registerCamera`.
- overlay reads `teardown`, `explodeAmount`, `highlightedPartId`, `activeStep`, `frozen`.
- voice and flow call the actions. `voiceStatus`, `agentSpeaking`, `transcript` are written only by `src/voice/`.

## Cache layout

```
public/cache/<object_id>.json                   checked teardowns (committed)
public/cache/meshes/<object_id>/<part_id>.glb   checked meshes (committed), served at /cache/meshes/...
.cache-live/<object_id>.json                    live Claude teardowns (gitignored, not reviewed)
.cache-live/meshes.json                         live fal results (gitignored)
.cache-live/review/                             output of npm run pregenerate (gitignored)
```

To promote live output, a human reviews it and copies it into `public/cache/` with `source` set to `cached`.
