# Contracts

The source of truth is code: `shared/teardown.ts` (schemas and API shapes) and `src/state/store.ts` (app state). This page explains how they are used. Ask the team before changing a field.

## Teardown JSON

See `TeardownSchema` in `shared/teardown.ts`. Conventions:

- `id`: kebab-case, unique within the teardown.
- `layer`: 0 = outermost, nearest the camera. Higher = deeper. Sets explode order.
- `dimensions_mm` (optional, top level): the object's real [width, depth, height] in millimetres. On stage the model's proportions come from it, not from the detector's on-screen box (which is squashed by the camera angle). It is [width, depth, height] in the pose the parts are laid out in. On stage it sets the proportion of the object's body: the largest-footprint part if it covers at least half the box each way (the shell, or a laptop's base when the open lid lies beyond it), else the whole box; without it the box's proportion is clamped to 2:3..3:2 (#120).
- `layout` (optional, top level): `"layers"` (default) or `"solid"` (#124). Solid parts carry `size_mm` [x, y, z] extents and `position_mm` [x, y, z] centre in millimetres (x right, y up, z towards the viewer, origin at the object's centre), and `axis` for a cylinder or tube. The flat `size` / `offset` / `layer` are derived on the server from the front view. On stage, solid lists are drawn by `src/overlay/SolidStage.tsx` and turn freely.
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
- Naming (#84): a cached demo object (the MacBook from a `laptop` label; a hand) opens at once from the detector label and Claude is asked in the background. Same `object_id`: the exact name is patched in. A different `object_id` with confidence >= 0.7 (`SWITCH_MIN_CONFIDENCE`): the app says so, loads that object's parts list and replaces the one on screen (the agent gets a "Correction" contextual update); if that fails the model is put away with one sentence. A different id below 0.7: the cached object stays. Any other detected object waits for Claude at most 6 s (`IDENTIFY_TIMEOUT_MS`), then goes on with the detector label. The server's identify call has a 7 s limit (11 s with no hint) and no retry. Model `claude-opus-5-5`; naming runs at `ANTHROPIC_IDENTIFY_EFFORT` (default low), parts lists at `ANTHROPIC_EFFORT` (default medium, 120 s timeout) (#95).
- fal (#80, stopgap for #75): a live (uncached) parts list asks fal for at most 4 part models (`MAX_LIVE_MESHES`, outermost and largest first). Cached parts with a `mesh_url`, hands and the arm never ask fal.
- `pickPart(partId)`: a silent pick (hidden arrow keys, mouse click, gaze dwell): highlights the part and sends the agent a contextual update naming it, never a user message, so no caption appears of words the wearer did not say; a spoken question goes through the `highlight_part` tool instead.
- `resetAll()`: saves what was open first (#97, `src/lib/saved.ts`), then `store.resetView()` and drops any in-flight explode; returns the saved entry or null. Saved: `{ id (parts-list object_id), name, kind: 'stored' | 'live', savedAt, thumb, glyph, anchor, lens, label, box }`, newest first, one per id, at most 12, in memory and `localStorage` (`blowfish.saved.v1`). `thumb` is a ~96 px JPEG data URL of the object's crop taken when it was analysed; never for an eye, a hand or the arm, anything biological or a person (a glyph instead). Live parts lists are kept for the session and in `localStorage` (`blowfish.saved.parts.v1.<id>`) when they fit, oldest dropped first; a reopened live model uses its kept list (no Claude) and asks fal only for the parts it asked for the first time. `?saved=clear` forgets everything.
- `resolveSavedObjectId(objectId, s)` (#97): a saved id or name (case-insensitive, partial) -> the same thing in view if there is one, else a pinned scene object at the saved box (as for the centre and the eye), so it opens when not in view. The arm reopens as the arm, the eye as the eye. `bringBack(id)` does the same for the saved pills (`src/hud/SavedRow.tsx`: top left, newest 6, only while the overlay is on and nothing is open or loading).
- `describeTeardown(td)`: the text sent to the agent as a contextual update.
- `reopenedSavedId(sceneId)` (#109): the saved id when the scene object was pinned to bring a saved model back because its object is not in view, else null.

## Client tools (`src/voice/clientTools.ts`)

Names match `CLIENT_TOOL_NAMES`. Each takes a parameters object and returns a string (often JSON). All must be set to "wait for response" in the ElevenLabs dashboard.

| Tool | Params | Does | Returns |
| --- | --- | --- | --- |
| `get_scene` | none | reads the store | JSON: overlay_on, objects, focused id, teardown parts (id, name, summary, safety), status, explode amount, highlight, step |
| `set_overlay` | `on` (boolean) | `true` = label what is in view ("Hey Blowfish, overlay on"); `false` = clean view, also resets | JSON: ok, say ("Labels on." / "Labels off."), saved? {id, name} |
| `select_object` | `object_id?` | selects it (default: focused) | JSON: ok, say ("Selected <name>." / "I cannot see that."), object_id |
| `explode` | `object_id?`, `amount?` | `amount` 0 collapses; otherwise loads and explodes (default 1) | JSON: ok, say ("<short name> analysed." below 0.5 / "<short name> exploded." from 0.5, plus " Parts are AI-estimated." for live; "Put back together."; "Closed." for 0; on failure the flow's sentence), name, source, part_ids, tour, if_asked (arm: layers, steps; eye: steps, steps_are, no tour) |
| `highlight_part` | `part_id` | highlights; accepts an id or a loose name | JSON: part id, name, summary, details, safety (arm: nerve, typing_role, layer), present |
| `show_step` | `n` | sets `activeStep` | JSON: step, of, text, part_ids, part_names (arm extras), present |
| `reset_view` | none | `resetAll()` | JSON: ok, say ("Put away. Saved <short name>." / "View reset."), saved? {id, name} |
| `rotate_model` | `direction` ("left", "right", "up", "down", "around"), `degrees?` (default 45; "around" = 180) | turns the floating model (`store.rotateModel`) | JSON: ok, say ("Turned left/right/up/down/around." / "That is as far as it turns." for a flat model at its limit, via `voiceTurn` / "Nothing is open yet."), degrees |
| `adjust_view` | `action` ("zoom_in", "zoom_out", "move_left", "move_right", "move_up", "move_down", "centre", "normal_size"), `amount?` (zoom factor, default 1.5; or distance in stage sizes, default 0.5) | zoom multiplies `store.modelZoom` (0.5 to 4; normal_size = 1); move calls `panModel`; centre = `centreModel`, zoom 1, yaw and pitch back to the front | JSON: ok, say ("Zoomed in." / "Zoomed out." / "Back to normal size." / "Back in the middle." / "Moved left." ... / "That is as close as it goes." / "That is as far out as it goes." / "That is as far as it goes." / "Nothing is open yet."), zoom? |
| `get_pose` | none | reads hands | JSON: per hand: handedness, finger curl and pressing, activeFinger, action, muscles (part ids) |

Action tools (#96): the agent says `say` exactly and stops; `if_asked` is only for when the user asks to be taught, toured or walked through. The agent's system prompt and first message live in `docs/agent/` (`npm run agent:prompt` compares them with the dashboard).

`CLIENT_TOOL_NAMES` has ten names, and `docs/agent/tools.json` defines each one (`npm run agent:tools -- --apply` adds the missing ones to the agent). `npm run check` only warns while `adjust_view` is missing. `zoom_model` (#109) is still answered for an agent that has it (`legacyClientTools`), but is not in the list.

Command lock (`src/voice/voiceLock.ts`, `?lock=0` off): when ElevenLabs sends the wearer's final transcript, the microphone is muted until Blowfish has answered (spoken and finished, plus 0.4 s), or 2.5 s after its last tool call with no speech, 8 s with nothing at all, 25 s at most; it is also muted while Blowfish speaks. Holding the talk key always opens it. Agent captions drop audio tags such as "[patient]".

There is no `set_lens` tool: Blowfish has no lenses.

`get_pose` muscle mapping: index, middle, ring or pinky pressing -> `fdp`, `fds`, `flexor-tendons`; thumb pressing -> `fpl`, `thenar`; active finger not pressing (lifting) -> `extensor-digitorum`.

Saved models (#97): `get_scene` also returns `saved: [{ id, name, saved_ago }]`. `explode` with an `object_id` that is not a scene object and matches a saved model brings it back; with nothing saved it resolves as before. `reset_view` returns "Put away. Saved <name>." when something was open, else "View reset.". For a new "analyse this" the agent should call `explode` with no `object_id`, so an old id does not reopen a saved model.

### A hand on stage is the arm (#74)

- In stage mode (the default), a hand's parts list is replaced after loading by Kash's arm, `object_id` `arm-hand` (`public/cache/arm-hand/teardown.json`, mapped to a valid `Teardown` in `src/stage/armTeardown.ts`; the schema is unchanged). 21 parts, layers 0 (skin) to 5, six steps. `isArmTeardown(td)` tells the two apart. In freeze or follow mode a hand keeps `hand-finger-muscles`, drawn on the real hand.
- The arm is drawn by its own renderer (`src/overlay/ArmStage.tsx`, Kash's `ArmXrayView`), driven by the same store fields as any model: `explodeAmount`, `modelYaw`, `modelPitch`, `highlightedPartId`, `activeStep`; `resetAll()` puts it away. No Pose model: the arm stands in a fixed typing pose.
- `explode`: `object_id` `"arm-hand"`, `"arm"` or `"hand"` means the hand in view. For the arm the reply adds `layers` and `steps`, and its `next` asks for `show_step` 1 to 6 instead of a part-by-part tour.
- `highlight_part` adds `nerve`, `typing_role`, `layer` for arm parts. `show_step` opens the arm if it is closed and adds `layer`, `parts`, `typing_roles`, and `clinical_note` on the last step.
- `get_pose`: while the arm is on stage the muscle ids are the arm's: pressing finger -> `forearm-flexors`, `flexor-tendons`; thumb -> `thenar`, `forearm-flexors`; lifting -> `forearm-extensors`, `extensor-tendons`. The `arm` field (Kash's typing detector) is always present.
- fal is never called for a hand or the arm.

### The eye (#94)

- MediaPipe Face Landmarker runs on every third frame (about 3 times a second while a model other than the eye is up, #131) on a centred square crop of the frame (`?facecrop=`, default 0.6 of the frame height). Each tracked face adds scene objects `eye-left` / `eye-right` (the person's own left and right; `-2` for a second face) with `label: 'eye'`, `anchor: 'face'`. There is no object or label for the face or the person, and no face image is kept.
- Focus: when the frame centre is inside a face's outline, the nearer eye is "this", unless a smaller box or a hand in the middle holds the centre. Eyes never take focus any other way.
- An eye always opens the stored `eye` parts list (`public/cache/eye.json`, Kash's procedural models). No picture of a face is sent to Claude for an eye: the flow skips the background name check for `anchor: 'face'`, and `/api/identify` answers an eye hint from its mapping.
- `explode` with `object_id` "eye" / "eyes" / "left eye" / "right eye": the eye on stage, else the focused or selected eye, else the one nearest the centre; with no eye in view the stored eye is pinned in the middle and opened anyway. Its reply gives `steps` (the path of light, 1 to 5) instead of a part tour.
- Drawn by `src/overlay/EyeStage.tsx` in the models' shared frame (never stretched), cut away as it opens, driven by the same store fields as any model.
- `get_pose` adds `eyes` while a face is tracked: per eye `open` and `looking` (left, right, up, down, centre; the person's own left and right) and a `note`.
- fal is never called for the eye.

### On stage: turning, zoom, lift-out (#107, #109)

- Every stage renderer (box rig, `ArmStage`, `EyeStage`) applies `store.modelYaw` / `modelPitch` / `modelZoom`, eased.
- Flat (box-rig) models never rest edge-on (`src/stage/turnLimit.ts`): yaw stays within 65 degrees of the face shown (front, or back after "around"); pitch may tip away only 5 degrees past the default view; the idle drift sways 35 degrees either side instead of spinning. Mouse, hands (`turnModel`) and voice (`voiceTurn`) all go through it. The eye and the arm are not limited.
- Lift-out and put-away come from `src/overlay/liftOut.ts`: an outline draws round the object (0.15 s), the model appears over it fully opaque, holds, then rises to the middle in 1.0 s on one curve (position, size, angle), parts separating in the last third; labels and the title come after arrival (`useHud.stageArrived`). Put-away reverses in 0.6 s into the object's current box, or into its saved pill when the object is out of view. `?lift=0` or the system's reduced-motion setting gives a short cross-fade instead.
- Zoom: trackpad pinch (wheel with ctrl), `+` / `-`, the two-hand spread past fully exploded, and `adjust_view`.
- Pan (#121): `modelPanX` / `modelPanY` in stage sizes (one stage size = 0.56 of the view height, `panPx()` in `src/stage/modelControl.ts`), eased like turn and zoom and scaled by the lift position so the lift-out and put-away start and end on the object. Set by a one-hand pinch moved, a fist grab (open hand over the model, then a fist), a two-hand pinch moved the same way (`?pan=1`), shift- or right-drag, shift + arrows and `adjust_view`; `0` or a double-click centres it and resets zoom.
- Smooth first open (#125): the stored models are parsed, uploaded and compiled in idle slices a few seconds after the overlay starts (`src/overlay/glbCache.ts`); every stage animation advances by at most 1/30 s per frame (`frameStep()` in `liftOut.ts`); a model appears only after one frame has been drawn with it at opacity 0. The debug panel shows the longest frame gap of the last open and whether its models were warm.

- Frame budget (#131): once a model has arrived on stage, the object detector runs about 3 times a second (`SLOW_VISION_MS` = 1/3 s; the next slot again after a run misses something tracked), and the face landmarker too unless the eye is up; hands every frame; normal rates while loading and lifting out and from the put-away on; while slow the trackers allow 1/3 s more before dropping (`extraHoldMs`). The scan's shift sampler pauses while a model is up unless it came out of a scanned thing. The overlay canvas is cleared once and hidden when it has nothing to show. Every WebGL canvas draws at most `?dpr=` (1 to 2, default 1.5) device pixels per CSS pixel. `?budget=0` turns all of this but the dpr cap off. The debug panel shows fps, vision and drawing ms per frame, runs per model and frames per canvas in the last second.

### Hands that may turn the model (#107)

- A hand counts for gestures only if it has been tracked for 300 ms and is not "on the desk and busy": smaller than `restHandMax` (0.22 of the frame height) **and** either typed within `typingMs` (1500 ms; middle, ring or pinky presses) or with its palm centre inside a detected laptop or keyboard box. An ignored hand starts no pinch, stops a drag dead, cannot join a two-hand spread or grab and gets no ring. `?resthand=`, `?typingms=`; `?gestures=0` turns hand gestures off.

- Gestures (#121, Rio's mapping of 15 Nov, `src/detect/gestures.ts`): a one-hand pinch moves the model with the pinch point (`?pinchturn=1`: turns it, as before); an open hand over the model (the driver passes its screen box, 1.35 times the stage size) that closes to a fist within 0.9 s grabs it, and it follows the fist until the hand opens; two open raised hands turn like a globe (held still 200 ms first); a two-hand pinch apart / together opens, then zooms (the same direction moves it only with `?pan=1`); a flat open hand from the top of the frame (palm above 0.38 of the height) down past 0.6, at least 0.28, within 1.1 s of leaving the top and mostly straight, closes the exploded view (to 0.12). The fist flick (burst) is off unless `?burst=1`. Pinch distance, reach and a second openness come from MediaPipe's world landmarks when present (`?world=0` off). Hands never open something from nothing or put it away. Hands are followed by position, and a hand with no new camera frame keeps its state for 250 ms. A ring marks each free hand between its thumb and index tips (at the palm for a fist), filled as soon as a pinch counts and while acting, and one word sits above the voice zone. Saved tuning key `blowfish.gestureTuning.v3`. `?grab=0`, `?sweep=0`, `?globe=0`, `?twohand=0`, `?gestures=0`.

### Object detection (#110)

- EfficientDet-Lite2 on the GPU, Lite0 as the fallback (not loaded, failed, or a median above 30 ms in the first second); `?detector=lite0|lite2`. A thing needs two detections at 0.45 or more to get a label, keeps it at 0.25 or more, and survives 1 s unmatched at its last place (`?appear=`, `?keep=`). Boxes are smoothed with a One Euro filter. Objects and faces never run on the same frame; hands run on every frame.

### Naming and building things that are not stored (#122, #124)

- **Whole-view scan** (`POST /api/scan`, `src/detect/scan.ts`): request `{ image, width, height }` (base64 JPEG of the visible view, longest side 768 px, tracked faces blacked out); reply `{ things: [{ name, box: {x, y, w, h} (0..1, top-left), interest (0..1), centre?: true, object_id? }], seconds }`, at most 10, most interesting first; `mock: true` with no things when there is no key (the app then stops scanning for the session); `fallback: true` + `error` on any failure. It runs while the overlay is on and nothing is open or loading, when the view is steady and has changed (one in flight, at least 3 s apart; at once when the middle of the view is unnamed and held still). A scanned thing over a detector box object sets that object's `name` (never over an identify name); anything else is a scene object `scan-N` (`anchor: 'box'`, `confidence` = interest), moved with the whole-frame shift and dropped when out of frame, after the view moves a third of a frame, or when later scans miss it. Labels: up to 10 with the scan on (focused first, then interest), 4 with `?scan=0` or no key. `explodeObject` on a scanned thing uses its name with no identify call; a detected laptop, hand or eye opens its stored model as before.
- **Sketch** (`POST /api/sketch`, `src/lib/look.ts`): request `{ image, hint?, object_id?, lens? }`; reply a solid `Teardown` plus `confidence` and `summary`, or `{ checked: true, object_id, name }`, `{ unknown: true }`, `{ mock: true }`, `{ shortcut: true }`, `{ fallback: true, error }`. Anything that is not stored and is a box object (not biology, not a saved model coming back) is sketched first: one low-effort vision call, at most 8 simple solids; the client waits 14 s and the server 12 s; anything unusable goes the old identify-then-teardown way. `ANTHROPIC_SKETCH_MODEL` (default the main model), `ANTHROPIC_SKETCH_EFFORT` (default low). Kept in `.cache-live/<object_id>.sketch.json`. No fal for solid lists. `?sketch=0` turns it off; `?mock=bottle` shows a built-in one.
- **Enrich** (`POST /api/enrich`): request `{ object_id, name, parts: [{ id, name, summary? }] }`; reply `{ parts: [{ id, details, safety }], steps: [{ n, text, part_ids }] }` (404 `mock` with no key, 502 on failure). Runs in the background at `ANTHROPIC_EFFORT` once the sketch is on stage and is merged into the open list, the kept copy and the disk cache; until then a sketched list has no steps and `show_step` says so.

## Store rules

- `src/state/store.ts` is the only shared state. Read with `useStore(selector)` in React, `useStore.getState()` elsewhere.
- detect writes `objects`, `focusedObjectId`, `hands`. The camera module calls `registerCamera`.
- overlay reads `teardown`, `explodeAmount`, `highlightedPartId`, `activeStep`, `frozen`.
- `modelPanX` / `modelPanY` (offset from the middle of the view in stage sizes, clamped to 2 each way; `panModel(dx, dy)`, `centreModel()`; back to 0 on reset): every stage renderer applies it.
- `modelZoom` (1 = the normal stage size, 0.5 to 4; `zoomModel(factor)`, `setModelZoom(z)`; back to 1 on reset): every stage renderer multiplies its size by it.
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
