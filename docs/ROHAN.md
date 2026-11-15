# Rohan: ElevenLabs agent and Claude routes

## Where your code lives

- `server/routes/identify.ts`, `server/routes/teardown.ts`: Claude routes. The prompts and Claude calls are in `server/lib/claude.ts`.
- `server/routes/agent-token.ts`: fetches the ElevenLabs signed URL.
- `src/voice/`: `useVoiceAgent.ts` (SDK wrapper), `clientTools.ts` (the nine tools), `VoiceBar.tsx` (voice pill, captions, hidden typed input; styles in `voiceStyles.ts`), `bridge.ts` (lets non-React code talk to the session), `localCommands.ts` (typed fallback when voice is off).

## Voice UI and hidden keys

- A small frosted pill at the bottom centre shows **Voice off**, **Connecting**, **Listening**, **Thinking** (after you speak, until Blowfish answers) or **Speaking** (gentle waveform). Click it, or press **V**, to start or stop the session.
- What was heard and what Blowfish says appear above the pill as captions and fade out after a few seconds (longer sentences stay longer).
- Press **/** to open the typed command box (developer fallback, never shown during the demo). Enter sends it (to the agent when connected, otherwise to `localCommands.ts`); Esc or clicking away closes it.
- Missing ElevenLabs keys or a voice error never show on screen: the pill says "Voice off" and the reason is in the browser console.

## Claude routes (identify, teardown)

- **No lenses.** The `lens` in a request is only a hint from the detector. Claude decides whether the thing is a machine (`engineering`) or a living thing (`biology`) and sets the parts list's `lens` itself. A detector label of "hand" always maps to `hand-finger-muscles` without a Claude call.
- **Model and speed (#95).** `ANTHROPIC_MODEL` picks the model (default `claude-opus-5-5`). Effort (`output_config.effort`) is set per call: the parts list uses `ANTHROPIC_EFFORT` (default `medium`), naming an object uses `ANTHROPIC_IDENTIFY_EFFORT` (default `low`, so it answers inside the identify limits: 7 s on the server, 6 s on the client for a detected object; 11 s and 12 s for the middle of the view). `none` sends no effort, for older models that reject it. Each Claude call logs one line: `[claude] <call>: <model>, effort <effort>, <s> s, <in> in / <out> out tokens, stop <reason>` (or `failed`); the routes still log `[identify] <id> in <s> s` and `[teardown] live <id> (<n> parts) in <s> s`.
- **Better models for live objects (#95).** The parts-list prompt asks for 6 to 12 parts a person would really find inside, sizes and offsets inside the outer shell's outline, layers from the outside in, and a `visual` phrase on every part (what it looks like on its own: shape, colour, material, one distinguishing feature; no brands, text or logos). `partPrompt` (`shared/prompts.ts`) leads the fal image prompt with that phrase; the hand-written `LOOKS_LIKE` entries for the MacBook's speakers and ports still win.
- **Validation.** Sizes are clamped to 0..1, offsets to -0.5..0.5 and layers to whole numbers before the schema check. Invalid JSON is retried once with the errors. If it still fails, `/api/teardown` returns 502 with one sentence the tutor can say ("I could not work out the parts for the <name>. Try again in a moment.").

## Setup (ElevenLabs dashboard)

1. Create a new agent named **Blowfish**. Pick a clear, warm voice (for example a calm British or American conversational voice; avoid dramatic or "narrator" voices). Turn on **authentication** so the app connects with a signed URL.
2. Paste the **system prompt** from `docs/agent/system-prompt.md` and the **first message** from `docs/agent/first-message.txt`, or run `npm run agent:prompt` (dry run) then `npm run agent:prompt -- --apply` (see below).
3. Add exactly the ten **client tools** below, or run `npm run agent:tools` (dry run) then `npm run agent:tools -- --apply`, which adds the missing ones from `docs/agent/tools.json` (see below). Names must match exactly. Tick **Wait for response** on every one. `adjust_view` (zoom, move, recentre) replaced `zoom_model`; an agent that still has `zoom_model` keeps working. There is no `set_lens` (lenses were removed in #32).
4. In the agent's **Advanced** settings keep **interruptions** on (the user can talk over Blowfish and it stops), and keep the turn timeout short.
5. Put `ELEVENLABS_API_KEY` and `ELEVENLABS_AGENT_ID` in your local `.env` (never commit it; share with Rio privately for the demo laptop), then restart `npm run dev`. `GET /api/health` should report `keys.elevenlabs: true`.

## System prompt and first message

One source of truth, in the repo: **`docs/agent/system-prompt.md`** (the whole file is the prompt) and **`docs/agent/first-message.txt`** ("Blowfish ready."). Change them there, never only in the dashboard.

How Blowfish talks (#96, `docs/PROJECT.md` section 1): after an action tool it says the reply's `say` line exactly and stops ("MacBook Air 13-inch exploded."). It explains, tours and walks through steps only when asked ("tell me about...", "teach me...", "how does... work", "walk me through..."), and stops at once on "shorter", "stop" or an interruption. "Stop" no longer turns the overlay off ("overlay off" or "clean view" does).

To put them into the agent:

- `npm run agent:prompt`: dry run. Reads the agent (your `.env` key and agent id), prints its name and whether its prompt and first message are the same as the repo's (lengths, first differing line). Changes nothing.
- `npm run agent:prompt -- --apply`: saves the agent's whole config to `.agent-backup/<agent-id>-<time>.json` (gitignored), changes only the prompt text and the first message, reads the agent back and confirms both match and nothing else changed. Tools, voice and language are never sent. Untested against the live API so far: read what it prints. If it refuses or fails, paste the two files by hand.

## Client tools to enter in the dashboard

All type **Client**, all with **Wait for response** on. Exactly these thirteen, also in `docs/agent/tools.json` (`npm run check` only warns while `adjust_view`, `show_detail`, `detail_step` or `close_detail` is missing). The last three are the detail model: the app answers them only when opened with `?detail=1`; without it they reply "I cannot build detail models yet." and do nothing.

- `npm run agent:tools`: dry run. Reads the agent and its tools and says which are there, missing or set up wrong. Changes nothing.
- `npm run agent:tools -- --apply`: saves the agent's whole config to `.agent-backup/` (gitignored), adds only the missing client tools (creates each in the workspace and adds its id to the agent), reads the agent back, and puts the prompt settings back if anything else changed. Tools already there are left alone. Untested against the live API so far: read what it prints.

| Name | Description | Parameters |
| --- | --- | --- |
| `get_scene` | What the user can see now: the objects in view, which one is in the centre, and the exploded parts with their ids. | none |
| `set_overlay` | Turn Blowfish's labels on (true) or go back to the clean camera view (false). Off also puts everything back. | `on` (boolean, required) |
| `select_object` | Select an object in view. Leave empty for the one in the centre. | `object_id` (string, optional) |
| `explode` | Bring a 3D model of the object the user is looking at into the middle of the view and spread its parts. amount 0.12 = assembled ("analyse this", "put it back together"), 1 = fully exploded, 0 collapses it. | `object_id` (string, optional; leave empty for "this"), `amount` (number 0 to 1, optional) |
| `highlight_part` | Light up one part before talking about it. Returns its facts and safety note. | `part_id` (string, required) |
| `show_step` | Show step n of the walkthrough (repair steps, or how a key press works). | `n` (integer, required) |
| `reset_view` | Put the model away: collapse everything and clear the selection. | none |
| `rotate_model` | Turn the floating model. "around" turns it half a turn. | `direction` (string, required: "left", "right", "up", "down" or "around"), `degrees` (number, optional; default 45, "around" 180) |
| `get_pose` | Which finger is pressing right now and which muscle part ids are working. | none |
| `adjust_view` | Move the view of the floating model without changing it: zoom in or out, move it left, right, up or down, put it back in the middle (also normal size and facing the front), or back to normal size. | `action` (string, required: "zoom_in", "zoom_out", "move_left", "move_right", "move_up", "move_down", "centre" or "normal_size"), `amount` (number, optional: zoom factor, default 1.5, or distance in model widths, default 0.5) |
| `show_detail` | Build and show a simple, animated 3D model of one specific mechanism, material, inner structure or manufacturing process beside the model on stage (also with nothing open). It is an AI sketch. Takes some seconds; follow its "present". Response timeout 60 s. | `topic` (string, required: a few words, e.g. "battery cell discharging"), `part_id` (string, optional: a part of the open model) |
| `detail_step` | Light up step n of the detail model and get that step's sentence. | `n` (integer, required) |
| `close_detail` | Close the detail model and put the main model back where it was. | none |

## Noisy room (judging): "Hey Blowfish" and push-to-talk

Chosen approach, in two layers:

1. **Prompt-level wake word (default).** The microphone is always open and the agent only acts on speech addressed to "Blowfish" (see the system prompt: it ignores other people and stays silent when unsure). Test it with background chatter before judging: play a busy-room recording or have two people talk nearby, then say "Hey Blowfish, explode this".
2. **Push-to-talk (fallback, hidden).** Hold **Space**, or hold a **side button of the wireless mouse** (middle, back or forward; left click still picks parts), to talk. In normal mode holding does nothing extra. In **push-to-talk-only** mode the microphone is muted except while you hold, and the pill says "Hold to talk".

How to switch:

| What | How | Remembered |
| --- | --- | --- |
| Push-to-talk only on/off | press **P**, or open with `?ptt=1` / `?ptt=0` | yes, in this browser |
| Microphone | open with `?mic=<part of its name>` (for example `?mic=c920` for the webcam on the cap, `?mic=iphone` for Continuity Camera), or press `\` (backslash) to cycle | yes, in this browser |

Changes apply at once to a running session, and each one is logged in the hidden debug panel (**D**). The camera's microphone is closest to the wearer's mouth, so pick it on the rig. Code: `src/voice/pushToTalk.ts`.

## What the tools reply (#96: short by default)

- Every action tool (`explode`, `set_overlay`, `reset_view`, `rotate_model`, `adjust_view`, `select_object`) returns JSON with `say`, the exact line to speak, and nothing that asks for more:

  | Tool | `say` |
  | --- | --- |
  | `explode` | "<short name> analysed." (opened below 0.5, e.g. 0.12) or "<short name> exploded." (0.5 and above); a live list adds " Parts are AI-estimated."; "Put back together." when closing an open model; "Closed." for amount 0; on failure the flow's one plain sentence |
  | `set_overlay` | "Labels on." / "Labels off." |
  | `reset_view` | "Put away. Saved <short name>." or "View reset." |
  | `rotate_model` | "Turned left." / "Turned right." / "Turned up." / "Turned down." / "Turned around."; "That is as far as it turns." (a flat model at its limit, #107); "Nothing is open yet." |
  | `adjust_view` | "Zoomed in." / "Zoomed out." / "Back to normal size." / "Back in the middle." / "Moved left." (right, up, down); "That is as close as it goes." / "That is as far out as it goes." / "That is as far as it goes."; "Nothing is open yet." |
  | `select_object` | "Selected <name>." / "I cannot see that." |
  | `show_detail` (`?detail=1`) | "<Title>. AI sketch.", then `present`: the summary in one sentence and `detail_step` 1 to N, one short sentence each; on failure one plain sentence ("I could not build a model of that just now. Try again in a moment.", "That model took too long to build. Try again in a moment.", "I cannot build new detail models without a Claude key."); without the flag "I cannot build detail models yet." |
  | `detail_step` | the step's sentence in `say`, the lit part names in `focus`, and `present` (next step or stop) |
  | `close_detail` | "Back to the <short name>." / "Closed." / "Nothing to close." |

  The short name drops the bracketed details ("MacBook Air 13-inch", not "MacBook Air 13-inch (M3, 2024)").
- `explode` also keeps the data for when the user asks: `part_ids`, `tour` (three parts: the two outermost, then one with a safety note such as the battery), for the arm `layers` and `steps`, for the eye `steps` (the path of light), and `if_asked`: what to do only if the user asks to be taught, toured or walked through (highlight each tour part; for the arm and the eye, `show_step` 1 to N). It no longer has `message` or `next`.
- `highlight_part` (a teaching tool) returns the part's summary, details and safety note, and `present`: two or three short sentences (one in a tour), and the safety note when there is one.
- `show_step` also highlights the step's first part; its `present` says to say the step in one short sentence and which step comes next if walking through.
- `get_pose` returns `working_now` (muscle names) and says what to highlight. If no finger is moving it suggests the forearm flexors and asks the user to type. If the hand layers are not shown yet, it says to call `explode` first.

## What the app sends the agent

After each explode, the app sends a contextual update listing the part ids, names, one-line summaries, safety notes and steps, ending "For questions only: do not describe these parts or steps unless the user asks." (`describeTeardown` in `src/lib/flow.ts`). It also sends it again when a session connects while something is already exploded. Clicking a part in the overlay sends a user message "Tell me about the <part name>."

## SDK notes (checked against the published @elevenlabs/react 1.22.1 / @elevenlabs/client 1.36.1 types)

- `@elevenlabs/react` 1.x needs a `ConversationProvider` ancestor; `src/voice/VoiceProvider.tsx` is that provider and takes the client tools and callbacks. `useVoiceAgent` calls `useConversation()` inside it.
- `onMessage` payload: `{ message, role: 'user' | 'agent', source (deprecated), event_id }`; `onModeChange`: `{ mode: 'speaking' | 'listening' }`; `onStatusChange`: `{ status }`; `onError(message: string, context?)`.
- **Mismatch fixed in #14:** `startSession()` and `endSession()` return `void`, not a Promise, and `status` can be `'error'`. The old code awaited `startSession` to catch failures, which never happens, so a failed connect left the pill on "Connecting" forever. Now `onError`, `onStatusChange` and a 15 s connect timeout put the store back to `disconnected`.
- `startSession({ signedUrl, connectionType: 'websocket' })`: signed URLs are the WebSocket path for authenticated agents.
- Each client tool returns a string and never throws (errors come back as `Error in <tool>: ...`).
- `/api/agent-token` returns 503 `voice_not_configured` without keys, and 502 if ElevenLabs is unreachable or refuses; the app shows "Voice off" in both cases.

## End-to-end check (run once with the real agent)

1. `npm run dev`, open http://localhost:5173 in Chrome, allow camera and microphone. `GET /api/health` shows `keys.elevenlabs: true`.
2. Press **V** (or click the pill). The pill goes Connecting -> Listening; the console has no errors.
3. "Hey Blowfish, overlay on" -> `set_overlay` runs and labels appear.
4. Look at the laptop: "Hey Blowfish, analyse this" -> the model floats up assembled and Blowfish says only "MacBook Air 13-inch analysed."; the pill shows Speaking and captions appear. "Tell me about the battery" -> it lights up and Blowfish answers in two or three sentences with the safety note, then stops.
5. "Turn it around" -> "Turned around." "Explode it" -> "MacBook Air 13-inch exploded." "Put it back together" -> "Put back together."
6. "Put it away" -> it clears: "Put away. Saved MacBook Air 13-inch."
7. Remove the keys from `.env` and restart: the app loads, the pill says "Voice off", nothing crashes.
