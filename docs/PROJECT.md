# Blowfish: project brief

Read this before you start any work. It is the source of truth for what we are building, who owns what, and how work gets into `main`. If a ticket disagrees with this file, say so on the ticket.

Last updated: Sat 14 Nov 2026, 20:00. Owner of this file: the orchestrator (Rio's Claude).

## 1. What we are building

**Blowfish** is voice-controlled X-ray vision for the physical world. You wear a camera and AR glasses, look at a real thing, and say "Hey Blowfish, explode this". Blowfish freezes the view, pulls the object apart into its parts as floating 3D pieces placed over the real object, and a voice tutor explains each part and answers questions. It works on machines and on living things with the same pipeline.

- **Event:** Imperial AI Hack. Submissions close **Sunday 15 Nov, 12:00**. Live demo to judges 13:00 to 16:30, no video.
- **Track:** Voice, Vision & Generative Media. Bounties: ElevenLabs (main), fal. Extra prize: Figma.
- **Team:** Rio (design engineering), Rohan (ElevenLabs voice), Kash (4th-year medic; fal 3D models and content).
- **Repo name** stays `xray-vision` until after the event (renaming mid-build risks breaking tooling). The product name everywhere in the UI and docs is **Blowfish**.

### The experience (this is the spec)

There are no modes, tabs, lenses or menus. One flow:

1. **Clean view (default).** The wearer sees exactly what the camera sees. Nothing is drawn on it except a very small "listening" dot.
2. **"Hey Blowfish, overlay on."** Blowfish starts analysing. Each thing it recognises (laptop, phone, hand, mug...) gets a small, quiet label that fades in on the object.
3. **"What is this?" / "Explode this."** "This" means whatever is in the centre of the wearer's view. For "explode", the frame freezes, the object's parts lift out into an exploded view placed over the object, and each part gets a label.
4. **Questions.** "Tell me about the battery." "How would I replace it?" The tutor highlights the part it is talking about and walks through steps.
5. **Living things.** Look at a hand typing: "Which muscles move my finger?" The tendons and forearm muscles are drawn over the real hand, follow it live (no freeze), and light up with each key press.
6. **"Put it back." / "Overlay off."** Back to the clean view.

Everything is driven by voice. Keyboard shortcuts and the typed command box exist only as a hidden developer fallback and must never appear on screen during the demo.

### Live demo scope (what must work on Sunday)

- A **MacBook Air M3 (13-inch)** on a desk with a teammate typing on it: label, explode, part tour, battery replacement steps.
- The **typing hands**: live muscle and tendon overlay with key-press activation, explained by the tutor.
- One **judge's object** generated live (marked "AI-estimated"), if the network allows.
- The Figma prototype shows the wider vision (world-locked tracking, eye, leaf, iPhone).

### Demo rig

Camera on the wearer's head (USB webcam on a cap, or an iPhone as a Continuity Camera) -> MacBook Pro (Chrome, `localhost`) in a backpack -> XREAL Air 2 Pro glasses mirroring the laptop screen (video passthrough) -> the same screen on the projector. The wearer cannot touch anything: voice only.

## 2. Look and feel

The first version looked like a sci-fi HUD (dark panels, cyan brackets, monospace, percentages). **That is wrong for Blowfish.** The target is calm and modern, like Apple Vision Pro or Meta Ray-Ban Display: the real world stays the hero and the interface almost disappears.

- **Clean passthrough first.** No frames, grids, reticles, badges, FPS counters or confidence percentages in the normal view. Debug information lives only in the hidden debug panel (key `D`).
- **Labels:** small frosted-glass pills (backdrop blur, white at ~14% with a hairline white border, radius 999px), white sans-serif text (`system-ui, -apple-system, "SF Pro Text", Inter, sans-serif`), sentence case ("MacBook Air", not "LAPTOP 79%"). A small dot or short hairline connects the pill to its object. Fade and scale in over ~250 ms.
- **Focus:** the thing in the centre of view gets a slightly brighter pill and a soft glow on the object. No crosshair.
- **Exploded view:** the frozen frame dims and blurs slightly behind the parts so they read clearly. Parts look like real components where we have fal models, and like soft translucent glass shapes where we do not (no wireframe-cyan). Label pills per part, never overlapping.
- **Cards:** one frosted card for the selected part: name (17-20px semibold), one sentence, safety note in a warm amber. Large radius (20px), soft shadow.
- **Voice:** a small pill at the bottom centre showing listening / thinking / speaking with a gentle waveform, and subtitle-style captions of what was heard and said that fade out. No chat box on screen.
- **Colour:** neutral whites and greys; one accent (soft blue `#4DA3FF`) for focus and highlight; warm orange (`#FF9F45`) only for active muscles and safety.
- **Type sizes** must be readable in 1080p glasses: body 18px minimum, labels 16px minimum.
- **Motion:** eased, quick, no flicker. Nothing blinks.

The design spec from the Figma prototype (`docs/design/blowfish-ui.md`, once it exists) refines this section. Until then this section is the spec.

## 3. Architecture

```
Camera (getUserMedia) -> Detection in the browser (MediaPipe: objects + hands, every frame)
        -> Store (zustand: src/state/store.ts)  <- Voice agent (ElevenLabs) calls client tools
        -> Overlay (three.js, transparent canvas over the video) + UI (labels, cards, captions)

Browser --/api--> Local server (Express, 127.0.0.1)
   POST /api/identify       Claude vision: crop -> exact product name
   POST /api/teardown       Claude: name -> parts list JSON (cache first)
   POST /api/generate-part  fal: part prompt -> image -> 3D model (GLB)
   GET  /api/agent-token    ElevenLabs signed URL for the voice session
```

- **Fast things run on the laptop** (camera, detection, drawing). **Slow things run in the background** (Claude, fal) and are cached. The explode animation is just three.js moving meshes; nothing is generated per frame.
- **Cache first.** `public/cache/<object_id>.json` is a checked parts list; `public/cache/meshes/<object_id>/<part_id>.glb` are checked 3D models. Demo objects are pre-generated and reviewed. Anything generated live goes to `.cache-live/` (gitignored) and is shown as "AI-estimated".
- **With no API keys the server answers from the cache**, so the app runs from a fresh clone.
- **Tracking:** laptop-type objects freeze the frame on explode (stable). Hands are tracked live every frame. World-locked tracking on a printed mat (MindAR) is a stretch goal.

### Tech stack

Vite + React 18 + TypeScript (strict) · three.js (plain, no react-three-fiber) · @mediapipe/tasks-vision 0.10.14 · zustand · zod · Express + tsx · @anthropic-ai/sdk (model from `ANTHROPIC_MODEL`) · @fal-ai/client · @elevenlabs/react · GitHub Actions for CI.

Run it: `npm install`, `cp .env.example .env`, `npm run dev`, open http://localhost:5173 in **Chrome** (not Safari), allow camera and microphone. `npm run fetch-models` once for offline vision models. `?mock=1` runs without a camera.

### The contracts (do not edit; ask for changes)

- `shared/teardown.ts`: the parts-list schema (`Teardown`), the API request and response shapes, and `CLIENT_TOOL_NAMES`.
- `src/state/store.ts`: the one shared store. Read every field's comment before using it.
- `docs/CONTRACTS.md`: the same in prose.

Voice tools the agent can call (configure exactly these in ElevenLabs, each set to "wait for response"): `get_scene`, `set_overlay`, `select_object`, `explode`, `highlight_part`, `show_step`, `reset_view`, `get_pose`. (`set_lens` still exists in code but is deprecated and must not be added to the dashboard.)

**No lenses.** The old Engineering/Biology switch is being removed. The `lens` field on a parts list and on a detected object stays only as internal metadata (it tells the server which prompt to use: `hand` -> biology, everything else -> engineering, or Claude decides). The user never sees or sets it. `store.lens` and `set_lens` are deprecated; do not use them in new code.

## 4. Roles and ownership

A label belongs to one person or one agent. Humans and agents follow the same rules.

| Label | Who | Covers | Owns (only these paths) |
| --- | --- | --- | --- |
| `person1` | Rio's Claude sub-agent | Camera, detection, 3D overlay, labels and cards | `src/stage/`, `src/camera/`, `src/detect/`, `src/overlay/`, `src/hud/`, `public/models/`, `scripts/fetch-models.mjs` |
| `person2` | **Rohan** and his Claude | Voice agent and voice UI, Claude endpoints | `src/voice/`, `server/routes/identify.ts`, `server/routes/teardown.ts`, `server/routes/agent-token.ts`, `server/lib/claude.ts`, `shared/prompts.ts`, `docs/ROHAN.md` |
| `person3` | **Kash** and his Claude | fal 3D models, parts-list content and accuracy | `server/routes/generate-part.ts`, `server/lib/fal.ts`, `scripts/pregenerate.ts`, `public/cache/`, `docs/KASH.md`, `docs/design/assets/` |
| `person4` | Rio's Claude sub-agent | App glue, build, CI, README | `package.json`, `package-lock.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `src/main.tsx`, `src/App.tsx`, `src/lib/`, `server/index.ts`, `server/lib/` (except `claude.ts`, `fal.ts`), `shared/demo.ts`, `.github/`, `.env.example`, `README.md` |
| `person5` | Rio's Claude sub-agent | Figma prototype, design spec, pitch | `docs/design/` (except `assets/`), `docs/pitch/` |
| `person6` | **Rio** | Hardware rig, running the app, keys, decisions, submission | nothing in the repo |
| `contract` | The orchestrator | The contract files and this brief | `shared/teardown.ts`, `src/state/store.ts`, `docs/PROJECT.md`, `docs/CONTRACTS.md` |

Rules:

- Work only on open issues with **your** label, in dependency order ("Blocked by #X" means wait until #X is merged).
- Touch only the paths you own. If your ticket needs a change somewhere else, **open a new issue with that owner's label** and describe exactly what you need; do not make the change yourself.
- A contract change is an issue labelled `contract`. The orchestrator makes it.
- If you find a bug that is not yours, open an issue with the right label.

## 5. Workflow

1. **Nobody commits to `main`.** It is protected. Only the orchestrator merges.
2. **One branch per ticket**, from the latest `main`: `personX/issue-<number>-<short-name>`, for example `person2/issue-14-voice-session`.
3. **Commit small and often**, with messages that reference the issue: `Add listening pill (#15)`. Push regularly.
4. **When the ticket's acceptance criteria are met:** rebase on the latest `main`, run `npm run typecheck` and `npm run build` (if you can install dependencies; otherwise rely on CI), push, and open a pull request titled like the issue. The description must say `Closes #<number>`, what changed, and **how it was tested** (ran on a Mac with a camera / ran in `?mock=1` / not run, CI only). One PR per issue. Keep PRs small.
5. **The orchestrator reviews** each PR against its ticket and this brief, and merges only when CI is green and there are no conflicts, in dependency order.
6. **After a merge,** rebase your open branches on the new `main` (`git fetch origin && git rebase origin/main`). Force-push only your own branch, with `--force-with-lease`. Never force-push anyone else's branch and never resolve a conflict by deleting someone else's change.
7. **Secrets** live only in your local `.env`. Never commit keys, never paste them into issues, PRs or chat.
8. **Dependencies:** adding or upgrading a package is a `person4` ticket.

### What "done" means

- The acceptance criteria on the issue are met and you have said how you checked them.
- `npm run typecheck` and `npm run build` pass in CI.
- You changed only files you own.
- Nothing appears on screen that breaks section 2 (no debug text, no sci-fi chrome).
- Docs you own are updated if behaviour changed.

## 6. Start prompts for agents

Paste one of these into your Claude (Claude Code works best), in a fresh clone of the repo.

**Rohan (person2):**

> You are person2 on the Blowfish project. Read `docs/PROJECT.md` and `docs/ROHAN.md` first, then `docs/CONTRACTS.md`. Work in auto mode through every open GitHub issue labelled `person2` in https://github.com/Rio-Lai/xray-vision, in dependency order. Follow the workflow in section 5 exactly: one branch per issue named `person2/issue-<number>-<short-name>`, small commits that reference the issue, then a pull request that says "Closes #<number>" and how you tested. Touch only the paths person2 owns. If you need a change elsewhere, open an issue with the right label instead. Never commit to main and never commit secrets.

**Kash (person3):** the same with `person3` and `docs/KASH.md`.

Rio's sub-agents (person1, person4, person5) are started by the orchestrator. They cannot install packages in their workspace, so they rely on CI for typecheck and build and must say "not run, CI only" in their PRs.

## 7. How Kash's and Rohan's work plugs in

**3D models (Kash).** For each MacBook part, save the reviewed model as `public/cache/meshes/macbook-air-m3-13/<part-id>.glb` and set that part's `mesh_url` to `/cache/meshes/macbook-air-m3-13/<part-id>.glb` in `public/cache/macbook-air-m3-13.json`. The app then replaces its placeholder shape with the model. Part ids: `display-assembly`, `keyboard-top-case`, `trackpad`, `hinges`, `antennas`, `logic-board`, `battery`, `speakers`, `magsafe-port`, `thunderbolt-ports`, `headphone-jack`, `bottom-case`. Keep each GLB small (aim for under 3 MB; decimate if needed). Transparent PNG renders of the same parts go in `docs/design/assets/` for the Figma prototype. Details: `docs/KASH.md`.

**Voice (Rohan).** ElevenLabs Agents does all three jobs in one session: it listens to the microphone (speech to text), decides what to say and which tool to call, and speaks the answer. Create the agent in the ElevenLabs dashboard, add the eight client tools above, and put `ELEVENLABS_API_KEY` and `ELEVENLABS_AGENT_ID` in your local `.env`. The browser code in `src/voice/` already registers the tools and opens the session through `/api/agent-token`. Details and the draft system prompt: `docs/ROHAN.md`.

For the demo, Rio's laptop needs all keys in its `.env`. Share them privately.

## 8. Known problems from the first real run (Sat 19:35)

- The camera, object labels and live hand overlay work at 30 to 50 fps.
- `/api/teardown` returned **405** and `/api/agent-token` **404**: the browser was not reaching our server (most likely another program already uses port 8787, or the page was not served by `npm run dev`). Ticket for person4.
- It was opened in **Safari**. Use Chrome.
- Badges overlap in the top-left corner. Superseded by the redesign in section 2.
- "explode this phone" had no parts list: only the MacBook and the hand are cached, and without an Anthropic key nothing else can be generated.

## 9. Timeline

| When | Gate |
| --- | --- |
| Sat 21:00 | Building closes. CI green on `main`; app reaches its own server; overlay toggle and new look in review |
| Sun 01:00 | MacBook flow works by voice on the rig with real 3D models |
| Sun 04:00 | Hand muscles work by voice; anything not working is cut |
| Sun 10:30 | Feature freeze, bug fixes only |
| Sun 11:30 | Devpost submitted (hard close 12:00) |
| Sun 13:00 | Judging starts |

Cut order if a gate slips: printed-mat tracking, live fal generation (use cached models), live key-press detection (show the hand's layers without it). The MacBook flow is never cut.
