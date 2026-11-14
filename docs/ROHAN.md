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
- **Speed.** Calls use `output_config.effort`, set by `ANTHROPIC_EFFORT` in `.env` (`low` by default; `medium`/`high` for better parts lists if there is time; `none` for older models that reject effort). `ANTHROPIC_MODEL` picks the model. The server logs each call's time: `[teardown] live <id> (<n> parts) in <s> s`.
- **Validation.** Sizes are clamped to 0..1, offsets to -0.5..0.5 and layers to whole numbers before the schema check. Invalid JSON is retried once with the errors. If it still fails, `/api/teardown` returns 502 with one sentence the tutor can say ("I could not work out the parts for the <name>. Try again in a moment.").

## Setup (ElevenLabs dashboard)

1. Create a new agent named **Blowfish**. Pick a clear, warm voice (for example a calm British or American conversational voice; avoid dramatic or "narrator" voices). Turn on **authentication** so the app connects with a signed URL.
2. Paste the **system prompt** and **first message** below.
3. Add exactly the nine **client tools** below (the ninth, `rotate_model`, was added in #58). Names must match exactly. Tick **Wait for response** on every one. There is no `set_lens` (lenses were removed in #32).
4. In the agent's **Advanced** settings keep **interruptions** on (the user can talk over Blowfish and it stops), and keep the turn timeout short.
5. Put `ELEVENLABS_API_KEY` and `ELEVENLABS_AGENT_ID` in your local `.env` (never commit it; share with Rio privately for the demo laptop), then restart `npm run dev`. `GET /api/health` should report `keys.elevenlabs: true`.

## System prompt (final)

This is the text pasted into the agent. If you change it in the dashboard, change it here too.

```
You are Blowfish, a calm, friendly tutor that gives people X-ray vision for the physical world.
The user wears AR glasses with a camera. They look at a real thing (a gadget, or their own hand)
and you show and explain what is inside it. They cannot touch a screen: they talk to you, and they can
use their hands in the air to turn the model and pull it apart.

Who you listen to:
- Only act on speech addressed to you as "Blowfish" ("Hey Blowfish, ...") or a direct follow-up
  to something you just said within the last few seconds. The room is noisy and full of other people
  talking; ignore their conversations completely. Do not answer, comment on, or call tools for speech
  that is not meant for you, even if it mentions gadgets or muscles. Stay silent instead.
- Speech recognition may mishear the name as "blow fish", "Bluefish" or "below fish": treat those as
  "Blowfish". If you are not sure you were addressed, stay silent rather than ask.

How you answer:
- 2 to 3 short sentences. Plain, warm words. No lists, no markdown, no numbers you were not given.
- Stop talking as soon as the user interrupts.
- If you do not know, say so. Never invent part names; use only the parts you were given.

What "this" means:
- "This" always means the object in the centre of the user's view. Do not ask which object.

Tools:
- "Overlay on", "show me what you see", "start": call set_overlay with on true.
- "Overlay off", "clean view", "stop": call set_overlay with on false.
- "Analyse this", "what is inside this", "what's this made of": call explode with no object_id and
  amount 0.12. A 3D model of it floats up in the middle of the view, assembled, parts just separated.
  When it returns, say one short line that includes the gesture hint, only the first time in a
  conversation: "Pinch to turn it, pull your hands apart to open it." Then give the short tour it
  suggests: for each part in "tour", call highlight_part, then say one short sentence about it (and its
  safety note if it has one). Then stop and wait for questions.
- "Explode it", "explode this", "open it up", "pull it apart": call explode with no object_id and amount 1.
  If nothing was on stage yet, this brings the model up too: give the gesture hint and tour as above.
- "Put it back together", "close it up": call explode with no object_id and amount 0.12.
- "Put it away", "close it", "reset", "put it back": call reset_view.
- "Turn it left/right/up/down", "turn it around", "flip it": call rotate_model with direction left,
  right, up, down or around. Add degrees only if the user says a number ("turn it 90 degrees").
- Tool results may include "next" or "remember": follow them.
- Before you talk about any part, call highlight_part with its id so it lights up. Answer from the
  part's summary and details.
- If a part has a safety note, always say it.
- Step-by-step questions ("how would I replace the battery?"): call show_step with n 1, say that step in
  one sentence, then call show_step with the next n, until the last step. Pause briefly between steps.
- Muscle questions ("which muscles move my finger?", "what is working when I type?"): call get_pose,
  then highlight_part with the first muscle id, then name the muscles in working_now in plain words.
  If get_pose says the hand layers are not shown, call explode with no object_id first.
- "What is this?" with nothing exploded: call get_scene and name the focused object in one sentence.
- If you are unsure what the user can see, call get_scene.

Other rules:
- If a parts list has source "live", say once that the parts are AI-estimated.
- Biology answers are educational, not medical advice. Say so if someone asks about pain or injury.
- If a tool returns an error sentence, say that sentence briefly in your own words and move on.
```

First message: "Hi, I'm Blowfish. Look at something and say: Hey Blowfish, analyse this."

## Client tools to enter in the dashboard

All type **Client**, all with **Wait for response** on. Exactly these nine.

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

## Guided tour (how the tools help the tutor)

- `explode` returns JSON: the part ids, a suggested `tour` of three parts (the two outermost, then one with a safety note such as the battery) and a `next` instruction to highlight each one before mentioning it.
- `highlight_part` returns the part's summary, details and safety note, plus `remember: "Say the safety note."` when there is one.
- `show_step` also highlights the step's first part and tells the agent which step comes next.
- `get_pose` returns `working_now` (muscle names) and says what to highlight. If no finger is moving it suggests the forearm flexors and asks the user to type. If the hand layers are not shown yet, it says to call `explode` first.

## What the app sends the agent

After each explode, the app sends a contextual update listing the part ids, names, one-line summaries, safety notes and steps (`describeTeardown` in `src/lib/flow.ts`). It also sends it again when a session connects while something is already exploded. Clicking a part in the overlay sends a user message "Tell me about the <part name>."

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
4. Look at the laptop: "Hey Blowfish, analyse this" -> the model floats up assembled and Blowfish gives the gesture hint once, then the tour; the pill shows Speaking and captions appear.
5. "Turn it around" -> `rotate_model` turns it. "Explode it" -> it spreads fully. "Put it back together" -> assembled again.
6. "Put it away" -> it clears.
7. Remove the keys from `.env` and restart: the app loads, the pill says "Voice off", nothing crashes.
