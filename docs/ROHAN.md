# Rohan: ElevenLabs agent and Claude routes

## Where your code lives

- `server/routes/identify.ts`, `server/routes/teardown.ts`: Claude routes. The prompts and Claude calls are in `server/lib/claude.ts`.
- `server/routes/agent-token.ts`: fetches the ElevenLabs signed URL.
- `src/voice/`: `useVoiceAgent.ts` (SDK wrapper), `clientTools.ts` (the eight tools), `VoiceBar.tsx` (mic button, transcript, typed input), `bridge.ts` (lets non-React code talk to the session), `localCommands.ts` (typed fallback when voice is off).

## Setup

1. ElevenLabs dashboard: create an agent. Turn on authentication so the app uses a signed URL.
2. Put `ELEVENLABS_API_KEY` and `ELEVENLABS_AGENT_ID` in `.env`, restart `npm run dev`.
3. Add the eight client tools below. Names must match exactly. Tick **Wait for response** on every one.
4. Paste the system prompt below.

## System prompt (draft)

```
You are X-Ray, a friendly tutor who shows people how gadgets and the human body work.
The user wears AR glasses and sees an exploded 3D view of what they are looking at.

Rules:
- Answer in 2 to 3 short sentences. Plain words. No lists.
- When the user says "explode this", "open it" or "what's inside", call explode with no object_id.
  "This" always means the object in front of them.
- Before you talk about a part, call highlight_part with its id so it lights up. Use the ids from
  the scene context or from get_scene.
- Always mention the part's safety note if it has one.
- For a step-by-step question (how do I replace the battery?), call show_step for each step in order.
- For "which muscle is working?" or "what moves my finger?", call get_pose, then highlight_part
  with the first id in muscles, then explain.
- Biology answers are educational, not medical advice. Say so if someone asks about pain or injury.
- If a teardown says source "live", say the parts are AI-estimated.
- If you do not know, say so. Never invent part names; use the ones you were given.
```

First message idea: "Hi, I'm X-Ray. Look at something and say explode this."

## Client tools to enter in the dashboard

All type Client, all with **Wait for response** on.

| Name | Description | Parameters |
| --- | --- | --- |
| `get_scene` | What the user can see now: objects, lens, and the exploded parts. | none |
| `select_object` | Select an object in view. | `object_id` (string, optional) |
| `explode` | Explode the object the user is looking at into its parts. amount 0 collapses it. | `object_id` (string, optional; leave empty for "this"), `amount` (number 0 to 1, optional) |
| `highlight_part` | Light up one part before talking about it. Returns its facts. | `part_id` (string, required) |
| `show_step` | Show step n of the walkthrough (repair steps or how a key press works). | `n` (integer, required) |
| `reset_view` | Collapse everything and clear the selection. | none |
| `set_lens` | Switch between engineering (gadgets) and biology (the body). | `lens` (string, required, "engineering" or "biology") |
| `get_pose` | Which finger is pressing right now and which muscle part ids are working. | none |

## What the app sends the agent

After each explode, the app sends a contextual update listing the part ids, names, one-line summaries, safety notes and steps (`describeTeardown` in `src/lib/flow.ts`). It also sends it again when a session connects while something is already exploded. Clicking a part in the overlay sends a user message "Tell me about the <part name>."

## Things to verify on the real SDK

- `src/voice/useVoiceAgent.ts`: the shape of the `onMessage` payload (we read `message`, then `role` or `source`).
- `startSession({ signedUrl, connectionType: 'websocket' })`.
- Whether the installed `@elevenlabs/react` has `ConversationProvider`; `src/voice/VoiceProvider.tsx` handles both.
