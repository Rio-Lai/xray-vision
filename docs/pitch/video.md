# Blowfish: the 2-minute round 1 video

Storyboard, shot list, voice-over, filming plan and judges' Q&A. Issue #60. Written Sat 14 Nov, 22:30, from `main` at `73c10b4`, for filming on **Sun 15 Nov, 08:00 to 10:00**. Rio reads this first; everyone else reads section 1 and their own shots.

---

## 1. One page

**The story in three sentences.** What makes a thing work is hidden inside it, and to learn it you leave the object for a video, a repair guide or an atlas. Blowfish is X-ray vision you talk to: look at a laptop or a hand, ask, and a 3D model of its insides floats up for you to turn and pull apart with your hands, while a voice tutor explains each part. One ElevenLabs agent runs the conversation and drives the app through nine tools, fal builds the 3D parts, Claude names the object and writes its parts list, and MediaPipe tracks your hands in the browser.

**The one shot that matters most (the "wow").** First-person view: the 3D MacBook Air floats in front of the real desk, Rio's two hands pinch and pull apart, and it spreads into its twelve fal-made parts over the live, dimmed video. It is shot P5 and the cold open. If the gesture fails: the same moment by voice ("Hey Blowfish, explode it"). If the floating model fails: open on the typing hand with its tendons lighting up (P8).

**Running order (2:00).**

| Time | Beat | Length |
| --- | --- | --- |
| 0:00 | P1 Cold open: a laptop, then what is inside it | 0:05 |
| 0:05 | P2 The rig, seen from the side | 0:09 |
| 0:14 | P3 Clean view, "overlay on" | 0:05 |
| 0:19 | P4 "Analyse this": the model floats up | 0:08 |
| 0:27 | P5 Hands turn it and pull it apart | 0:07 |
| 0:34 | P6 "Tell me about the battery", "How would I replace it?" | 0:12 |
| 0:46 | P7 "Put it away" | 0:03 |
| 0:49 | P8 The typing hand: muscles drawn live | 0:11 |
| 1:00 | T1 How it works: ElevenLabs | 0:14 |
| 1:14 | T2 fal | 0:14 |
| 1:28 | T3 Claude | 0:10 |
| 1:38 | T4 MediaPipe | 0:08 |
| 1:46 | F Designed in Figma | 0:09 |
| 1:55 | C "Overlay off", end card, last line | 0:05 |

Product 1:00, technical 0:46, Figma 0:09, close 0:05.

**Check before filming (these change the plan):**

- **Voice has never run against the real agent** (#61). Do it tonight. If it has not worked once by 08:35, film Plan B (section 2, "If voice never works") and do not claim voice works.
- **Gestures are untested on real hands.** Shot first on Sunday (most fragile), with a voice fallback.
- **There is no 3D hand model on `main`.** `hand-finger-muscles.json` has no `mesh_url`s and there is no `meshes/hand-finger-muscles/` folder (#57 is open). Kash's arm work (PR #66) is a separate system, has merge conflicts and needs MediaPipe Pose wired in. So "analyse my hand" brings up the muscle layers **on the real hand only**. The plan does not depend on the 3D hand; P8 says where to add it if it lands.
- **"Checked" must be true.** The content checks are still open: #21 (hand, Kash) and #22 (MacBook against a real Air). Close them before we say "checked" on screen.
- **QuickTime alone records the microphone, not the tutor's voice.** Use OBS, or BlackHole with QuickTime (section 5). Test tonight.
- **Where the video goes** (Devpost link, file to the organisers, or played from our laptop) is still unanswered (#59).
- **The README is out of date** (it says the frame freezes and lists eight tools; `main` floats the model and has nine). Judges may read it before the Q&A. Needs a person4 fix before 11:30.

---

## 2. Shot list

Capture key: **SR** = screen recording of the app on the MacBook Pro (the wearer's view; OBS, 1080p, 30 fps, app audio plus mic). **SP** = side phone filming Rio in the rig. **FR** = screen recording of Figma or a web page. **DG** = diagram slide.

Hidden keys (a teammate at the MacBook Pro, out of the side phone's frame): `V` start or stop voice, `O` overlay, `A` analyse, `E` explode, `R` reset, `S` next step, Left / Right next part, `D` debug panel. Mouse drag turns the model; the wheel opens it. Keys show nothing on screen when they work.

| # | Time | On screen | Capture | Rio says / does | Blowfish says (approx.) | Voice-over | Fallback |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P1 | 0:00-0:05 | 1.5 s: clean view of the MacBook Air on the desk. Cut to: the floating MacBook being pulled apart into its parts over the dimmed live desk. Small "Blowfish" wordmark at 0:04. | SR (clean-view safety take + best P5 take, ideally a different take from the one used in P5) | Two-hand pinch, pull apart slowly | (none, cut) | "This is a laptop on a desk. And this is what is inside it." | Voice take of "explode it". No floating model at all: open on P8's lit hand, VO "This is a hand typing. And this is what moves it." |
| P2 | 0:05-0:14 | Rio in the rig: camera on the cap (or iPhone), XREAL glasses, looking down at the MacBook Air. 1 s insert: close-up of camera and glasses. Lower third: "Head camera > MacBook Pro > XREAL glasses (video passthrough)". | SP, 1.5-2 m away, eye height | Stand still, look at the laptop, then look up | (none) | "Blowfish is X-ray vision you control by voice. A camera on your head, the view in your glasses, and a tutor that explains what you are looking at." | Still photo of the rig with a slow push-in |
| P3 | 0:14-0:19 | Clean camera view, only the small voice pill. Labels fade in: "Laptop", "Right hand". | SR | Look at the laptop (centre of view). "Hey Blowfish, overlay on." | Short line, e.g. "Overlay's on." (cut if it lags) | "The view stays clean until you ask." (before Rio speaks) | Key `O`. Then no spoken command is heard; VO: "The view stays clean until you ask. Then it labels what it recognises." |
| P4 | 0:19-0:27 | "Looking..." pill (cut short). The 3D MacBook lifts out of the real laptop and glides to the centre, assembled, live video dimmed behind it. Title pill "MacBook Air 13-inch (M3, 2024)". Captions. Edit tag, 2 s, bottom left: "Parts list and 3D models made earlier and checked (cached)". | SR | Laptop in the centre of view. "Hey Blowfish, analyse this." Hold still. | "Pinch to turn it, pull your hands apart to open it." (said only the first time in a session: restart voice before each take) | (none: live audio) | Key `A`. No command heard; VO: "Ask it to analyse what you are looking at, and a 3D model lifts out." |
| P5 | 0:27-0:34 | Soft dot at Rio's pinch; the model turns like a globe. Then both hands pinch and pull apart: it spreads into its twelve parts with label pills. | SR | One hand: thumb and index together, other fingers open, drag slowly left to right, let go. Then both hands pinch in front of the model and pull apart to shoulder width. Hold 2 s. | The tour continues ("keyboard and top case", "trackpad"...): duck it under the VO or cut it | "Your hands are the controller." | Gesture fails: voice "Hey Blowfish, turn it around" (`rotate_model`), then "Hey Blowfish, explode it" (`explode` 1); VO "Or just ask." Voice fails too: key `E` opens it, no turning shot, VO "It opens into its twelve parts." Never mouse-drag while Rio's hands mime a gesture. |
| P6 | 0:34-0:46 | The battery lights up blue. Frosted card bottom left: "Battery", one sentence, safety note in amber ("Lithium battery: never puncture, bend or pry..."). Then step cards bottom right: "Step 1 of 7: Shut the Mac down fully...", jump cut to "Step 4 of 7: Disconnect the battery from the logic board...". | SR | Interrupt the tour: "Hey Blowfish, tell me about the battery." Then: "How would I replace it?" | "This is the battery, a lithium-polymer pack under the palm rest. Never puncture, bend or pry against the cells." / "First, shut the Mac down fully and unplug the charger." [cut] "Disconnect the battery from the logic board before anything else." | (none: live audio) | Voice off: Right arrow to the battery (card appears), `S` for the steps; VO "Ask about a part and it lights up, with its safety note. Ask how to replace it, and it walks you through." Do not use any take where a caption shows words Rio did not say. |
| P7 | 0:46-0:49 | The model glides back into the real laptop; the labels stay. | SR | "Hey Blowfish, put it away." | Short line or none | (none) | Key `R` |
| P8 | 0:49-1:00 | Looking down at a hand typing on the MacBook Air. Faint tendons and bones follow it live. After the question: the layers (skin, extensor, bones, flexor muscles towards the forearm) over the real hand, lifted apart; the pressing finger's tendon and FDS / FDP glow warm orange with each key press. Card: "Flexor digitorum profundus (FDP)". | SR | Centre of view on the back of the hand (its pill brightens). Type slowly, one finger at a time, about two keys a second. "Hey Blowfish, which muscles move my finger?" | "Right now your forearm flexors are working: profundus bends the fingertip and superficialis bends the middle joint, pulling through the flexor tendons." | "Living things too: muscles and tendons, drawn live on a real hand." (before Rio speaks) | No orange glow on presses: keep the layers; nothing in the VO claims the glow. Voice off: key `E` with the hand centred, Right arrow to FDP. If #57 is merged by 08:00: add "Hey Blowfish, analyse my hand" and let the 3D hand and forearm float up for the last 4 s. |
| T1 | 1:00-1:14 | Diagram, "Talk" row highlighted. Then 3 s of the ElevenLabs dashboard listing the nine client tools. Then 2 s of P6 again with small labels `highlight_part("battery")`, `show_step(4)`. | DG, FR, SR | (none) | (none) | ElevenLabs paragraph (section 3) | No dashboard: diagram only. Label tool calls only if the conversation log confirms them. |
| T2 | 1:14-1:28 | Diagram, "Build" row: part name > prompt > image > 3D model. Then the twelve MacBook models turning on the mesh sheet. Optional 3 s: a live object (mouse or phone) with the "AI-estimated" chip and glass placeholders being replaced by models, tag "8x". | DG, FR, SR | (for the optional clip) "Hey Blowfish, analyse this." at a mouse or phone | (cut) | fal paragraph | No live clip: keep the sentence on new objects only if the live path has run at least once; otherwise cut it. |
| T3 | 1:28-1:38 | Diagram, "Know" row: camera crop > Claude > "MacBook Air 13-inch (M3, 2024)"; then 2 s scrolling `public/cache/macbook-air-m3-13.json`. | DG, FR | (none) | (none) | Claude paragraph | Diagram only |
| T4 | 1:38-1:46 | Diagram, "See" row; then 3 s of P5's pinch dot and P8's glowing finger side by side. | DG, SR | (none) | (none) | MediaPipe paragraph | Diagram only |
| F | 1:46-1:55 | 1.5 s: the first Figma Make prototype (dark HUD), tag "First prototype, rejected". 4 s: "Blowfish — concept prototype" playing two or three of its nine steps, Figma UI and file name visible, tag "Figma Make". 2 s: the prototype's frosted pill and card next to the same element in the app. | FR | (none) | (none) | Figma paragraph | If the UI kit or the "how it works" page exist by then, see section 4, "Figma beat" |
| C | 1:55-2:00 | First-person: labels on the laptop, then "overlay off" and the clean view. End card over it: "Blowfish", "Rio, Rohan, Kash. Imperial AI Hack 2026", and in small type "Filmed on the rig, 15 Nov. Pauses cut for time. Commands, replies and models as recorded." | SR + text | "Hey Blowfish, overlay off." | (none, or cut) | "Blowfish. X-ray vision you can talk to." | Key `O`, no command heard; end card over the clean view |

### What must be real, and what we may do in the edit

Must be real, in the take we use:

- Every command you hear is the one that triggered what follows, and every Blowfish line is its real reply in that take. No re-voicing, no separately generated speech.
- A gesture shown moving the model really moved it. No mouse drag behind waving hands.
- The hand overlay is live on a real hand. The "AI-estimated" object, if shown, was generated live in that take.
- Captions, cards and labels are the app's own.
- When a hidden key triggered something, no spoken command is heard and the voice-over does not say it was voice.

Fine in the edit:

- Cutting waits ("Looking...", the agent thinking). The end card says so, and we give real numbers in the Q&A.
- Trimming Blowfish mid-reply, and skipping steps (step 1, then step 4).
- Speed-ups, always with a small "2x" / "8x" tag.
- Reusing the best moment as the cold open; choosing the best take for each shot; cutting between takes at a visible cut.
- Voice-over, titles, the diagram, and tool-name labels that match the conversation log.

Never: a command dubbed over a key press; a model composited in after; Figma prototype footage presented as the app; `?mock=1` or `?mock=gesture` footage in the product minute (it is fake data).

### If voice never works

If the agent has not completed one real run by 08:35, film P3 to P8 with hidden keys and the fallback VO lines above, and change two things so nothing claims what we have not shown: P2 VO becomes "Blowfish is X-ray vision for the things around you: a camera on your head, and the view in your glasses."; T1 VO becomes "The voice tutor is one ElevenLabs agent, built to drive the app through nine client tools. In this recording we used the keyboard instead.", and the end card says "Commands in this cut were triggered from the keyboard." This costs us the ElevenLabs bounty, so fixing voice tonight is the top priority.

---

## 3. Voice-over script

Read it calmly, at a normal pace. Pauses marked "(live)" are where Rio's commands and Blowfish's replies play. Count: about 220 words of voice-over (the technical minute runs at about 2.7 words a second); with about 25 seconds of live speech the soundtrack is close to 300 words, which is all two minutes can hold. If Blowfish's replies run long, cut the line marked *optional*.

> **[0:00]** This is a laptop on a desk. *(beat)* And this is what is inside it.
>
> **[0:05]** Blowfish is X-ray vision you control by voice. A camera on your head, the view in your glasses, and a tutor that explains what you are looking at.
>
> **[0:14]** The view stays clean until you ask.
>
> *(live: overlay on; analyse this; the gesture hint)*
>
> **[0:28]** Your hands are the controller.
>
> *(live: the battery; replacing it; put it away)*
>
> **[0:49]** Living things too: muscles and tendons, drawn live on a real hand.
>
> *(live: which muscles move my finger?)*
>
> **[1:00]** How it works. One ElevenLabs agent listens, decides and speaks. It drives the app through nine client tools, such as explode and highlight part. The app sends it each parts list, so it knows which parts are there.
>
> **[1:14]** The 3D parts come from fal: a text prompt becomes an image, then a 3D model. We made the MacBook's twelve parts earlier and checked them, so they load at once. *(optional, see T2)* New objects are made live, and marked AI-estimated.
>
> **[1:28]** Claude names the object from a camera crop. For a new object, it writes the parts list as JSON, checked against our schema.
>
> **[1:38]** In the browser, MediaPipe tracks twenty-one points on each hand, every frame. That is how it sees a pinch, or a key press.
>
> **[1:46]** We designed it in Figma Make, and threw out our first sci-fi HUD for calm frosted glass. The app follows that design.
>
> *(live: overlay off)*
>
> **[1:57]** Blowfish. X-ray vision you can talk to.

Alternative last line: "Blowfish. Look at something, and ask what is inside."

Recording: a quiet room, phone voice memo about 30 cm from the mouth, two takes of each paragraph. Use a different voice from the wearer's (see decisions), so judges can tell narration from live commands.

---

## 4. The technical minute, precisely

### Diagram (one 16:9 slide or Figma Make page)

Four rows, left to right. Highlight one row per segment (T1 Talk, T2 Build, T3 Know, T4 See); dim the others.

```
SEE    [Head camera] --video--> [MediaPipe, in the browser: objects, 21 points per hand] --> [App] --> [3D model + labels + cards] --> [XREAL glasses: mirrored screen]
TALK   [Microphone] --> [ElevenLabs agent: listen > decide > speak] <-- nine client tools --> [App]      (agent voice --> glasses / speakers)
                                         ^-- contextual update: the parts list --[App]
KNOW   [App] --camera crop--> /api/identify --> [Claude vision: "MacBook Air 13-inch (M3, 2024)"]
       [App] --name--> /api/teardown --> [Cache first, else Claude: parts list JSON, schema-checked]
BUILD  [App] --part--> /api/generate-part --> [Cache first, else fal: text > image > 3D model (GLB)]
```

Captions on the slide: "Every frame, on the laptop" (SEE); "Cached first" (KNOW, BUILD); the nine tool names in small type under TALK: `get_scene`, `set_overlay`, `select_object`, `explode`, `highlight_part`, `show_step`, `rotate_model`, `reset_view`, `get_pose`.

### Claims we make, and where they are true

| Say | True because | Do not say |
| --- | --- | --- |
| One ElevenLabs Agents session listens, decides which tool to call, and speaks. | `src/voice/useVoiceAgent.ts`; signed URL from `server/routes/agent-token.ts`, WebSocket session. | That Claude runs the conversation. The agent's own LLM is chosen in the ElevenLabs dashboard (Rohan to name it). |
| It drives the app through nine client tools, each set to "wait for response". | `CLIENT_TOOL_NAMES` in `shared/teardown.ts`; `src/voice/clientTools.ts`; dashboard set-up in `docs/ROHAN.md`. | "Eight tools" (the README is out of date). |
| Tool results guide it: `explode` returns a three-part tour and a "next" instruction; `highlight_part` returns the facts and "say the safety note"; `show_step` says which step is next; `get_pose` names the working muscles. | `src/voice/clientTools.ts` | That every reply is scripted, or that nothing is guided. |
| After each explode, the app sends the parts list as a contextual update (again when a session connects mid-explode). | `describeTeardown` in `src/lib/flow.ts`; `useVoiceAgent.ts` | |
| "Hey Blowfish" is handled by the agent's prompt; push-to-talk (Space or a mouse side button; `P` for push-to-talk only) is the fallback. | `docs/ROHAN.md`; `src/voice/pushToTalk.ts` | "A custom wake-word model." |
| fal makes each part: text to image, then image to 3D. Defaults: `fal-ai/flux/schnell`, then `fal-ai/hunyuan3d/v2/turbo`, textured. | `server/lib/fal.ts` | Model names in the VO, unless Kash confirms the MacBook run used the defaults. |
| The MacBook's twelve models were made earlier with the same pipeline, reviewed, compressed and committed. | `scripts/pregenerate.ts` (up to 4 at once, never pays twice, `--promote` compresses); 12 GLBs in `public/cache/meshes/macbook-air-m3-13/`, each under 1 MB | That the hand is a fal model (not on `main`). |
| A new object gets placeholder shapes at once; fal models replace them as they arrive, two at a time; it is marked "AI-estimated". | `generateMeshes` in `src/lib/flow.ts`; `ExplodedTitle` in `src/hud/Hud.tsx` | "Real-time 3D generation." It takes seconds to minutes per part, in the background. |
| Claude names the object from a camera crop, using the detector's hint and our list of checked objects. | `identifyLive` in `server/lib/claude.ts` | That Claude sees every frame (one crop per "analyse"). A hand skips Claude and maps straight to the checked hand list. |
| Claude writes a new object's parts list (8 to 12 parts: layer, size, position, summary, details, safety, plus repair steps) as JSON; we clamp it, check it against a zod schema and retry once with the errors. | `teardownLive` in `server/lib/claude.ts`; `TeardownSchema` in `shared/teardown.ts` | |
| Cache first: checked files, then live results, then Claude or fal. With no keys the app runs from the cache. | `server/routes/teardown.ts`, `server/routes/generate-part.ts`; `docs/CONTRACTS.md` | |
| MediaPipe Tasks Vision runs in the browser: EfficientDet-Lite0 (COCO) for objects every third frame; Hand Landmarker, 21 points, up to two hands, every frame; 30 to 50 fps in our first run. | `src/detect/mediapipe.ts`, `src/detect/engine.ts`; `docs/PROJECT.md` section 8 | "50 fps" as a fact; "it tracks the forearm" (the forearm layers are placed by extending the hand's line past the wrist); "depth sensing". |
| Key presses: each fingertip's speed relative to its own knuckle, with whole-hand motion removed and on/off thresholds. | `src/detect/handTracker.ts` | |
| Gestures: a pinch must hold before it counts and stay open before it ends; pinch-drag turns the model; two pinching hands moving apart open it. | `src/detect/gestures.ts` | |

### Figma beat

What exists today: two Figma Make files. The first prototype (dark sci-fi HUD), rejected as "too Tony Stark", and "Blowfish — concept prototype" (https://www.figma.com/make/vIDcMqov0Y85Ru6h4mlbUe/), a nine-step first-person voice story in the calm frosted-glass look. The app's frosted pills, part card and voice pill follow the same written design language (`docs/PROJECT.md` section 2). The beat above uses only these.

If they get built before 09:00:

- **UI kit in Figma:** replace the 2 s side-by-side with the kit's pill, card and voice pill next to the app.
- **"How it works" page in Figma Make:** use it as the diagram for T1 to T4, tag it "Figma Make", and change the Figma VO to: "We designed it in Figma Make, including this explainer, and threw out our first sci-fi HUD for calm frosted glass."

---

## 5. Filming plan, Sunday 08:00 to 10:00

### Tonight, before sleep

- [ ] Voice: one real run (#61, `docs/ROHAN.md` end-to-end check). Nine tools, each "wait for response".
- [ ] Gestures: try pinch-drag and two-hand open on real hands once; tune with the debug panel (`D`); the settings are saved in Chrome.
- [ ] Screen recorder with the tutor's voice: **OBS** (free) with a macOS Screen Capture source with its audio on, plus the mic. Or BlackHole: a Multi-Output Device in Audio MIDI Setup, then QuickTime with "BlackHole 2ch" as input. Record 10 s and play it back: both voices must be audible.
- [ ] Diagram slide made (section 4).
- [ ] Ask the organisers where the video goes (#59).
- [ ] Charge: head iPhone, side phone, MacBook Pro, MacBook Air. 20 GB free on the MacBook Pro.

### Setup checklist (08:00 to 08:15)

- [ ] Quiet corner, even light, no window behind the desk. MacBook Air open with a plain text editor (so typing is real).
- [ ] MacBook Pro: Do Not Disturb on; close Slack, WhatsApp, Messages, Mail; Chrome only; bookmarks bar hidden.
- [ ] `npm run dev`. Open `http://localhost:5173/?mic=iphone` (or `?mic=c920` for the cap webcam) in Chrome. Allow camera and microphone. `http://localhost:5173/api/health` shows `anthropic`, `fal` and `elevenlabs` all `true`.
- [ ] Chrome full screen (View > Enter Full Screen). Debug panel closed.
- [ ] Glasses: mirrored at 1920 x 1080. The recording shows the same picture.
- [ ] iPhone (if Continuity Camera): landscape on the cap; Video Effects off in Control Centre (Center Stage, Portrait, Studio Light).
- [ ] Voice: press `V`, wait for the first line, say "Hey Blowfish, overlay on". Push-to-talk off (`?ptt=0`) unless the room is noisy.
- [ ] OBS: 1920 x 1080, 30 fps, cursor hidden, app audio and mic on.
- [ ] Side phone: 1080p, 30 fps, landscape, focus and exposure locked, on a stack of books 1.5 to 2 m to Rio's side.
- [ ] One teammate at the MacBook Pro for hidden keys and OBS; one on the side phone and the take log (paper: take, good or bad, time of the good moment).
- [ ] Every take: clap in view of the head camera first (to sync the side phone); press `V` twice for a fresh voice session (so the gesture hint plays); end with "overlay off" or `R`.

### Order of shooting (most fragile first)

| Start | Take | What | Takes | Fallback trigger |
| --- | --- | --- | --- | --- |
| 08:15 | A | Analyse the MacBook, pinch-drag turn, two-hand open (P4, P5, P1) | up to 5 | After 3 failed gesture takes, record A-voice: "turn it around", "explode it", "put it back together" |
| 08:27 | B | Typing hand: overlay on, muscle question, presses glowing (P8) | up to 4 | Also record one take of the layers with no question |
| 08:37 | C | Full MacBook run in one go: 3 s clean view, overlay on, analyse, battery, replace, put away, overlay off (P3, P6, P7, C) | 3 | A shot that fails twice: redo just that shot with its key fallback |
| 08:52 | D | Optional live object: a mouse or a phone, "analyse this", keep recording through the wait (T2) | 1 or 2 | Costs about $5 of fal credit each; skip if the network is slow |
| 08:58 | E | Side phone only: Rio walks in and looks at the laptop; close-ups of camera and glasses; over the shoulder (P2). The side phone also runs during A to C. | 2 each | Still photos |
| 09:03 | F | Screen recordings: ElevenLabs tools list (and the conversation log if it shows tool calls; no keys on screen), mesh sheet, both Figma Make files, diagram | 1 each | |
| 09:13 | Safety | 10 s clean view of the laptop; a silent key-driven run of the whole flow (Plan B only); 10 s room tone; rig photos for Devpost | 1 each | |
| 09:18 | VO | Section 3, two takes of each paragraph | 2 | |
| 09:28 | Offload | AirDrop everything to the editing Mac, named A1, A2, B1... | | |

Mesh sheet: from the repo root run any static server (for example `python3 -m http.server 8000`) and open `http://localhost:8000/scripts/mesh-sheet.html?object=macbook-air-m3-13`.

### Edit plan, 20 minutes (09:30 to 09:50)

Use whichever of iMovie or CapCut the editor knows. CapCut can add subtitles automatically; iMovie cannot.

| Minutes | Do |
| --- | --- |
| 0-2 | New 16:9 project, 1080p, 30 fps. Import. Mark the best takes from the take log. |
| 2-4 | Lay the VO first: it sets the timing. |
| 4-11 | Product minute in shot order. Jump-cut the waits; trim Blowfish's replies. |
| 11-15 | Technical minute and Figma: diagram, dashboard, mesh sheet, Figma recordings. |
| 15-17 | Text: wordmark at 0:04, the "cached" tag in P4, speed tags, lower third in P2, end card. |
| 17-19 | Audio: VO on top; live audio about 12 dB lower under the VO; Blowfish at full level when there is no VO. No music, or very quiet. |
| 19-20 | Watch it once, start to finish, on laptop speakers. Length 1:58 to 2:00. |

### Export and upload (09:50 to 10:00)

- MP4, H.264, 1920 x 1080, 30 fps, high quality (CapCut: bitrate "Recommended"; iMovie: Share > File, 1080p, High), AAC audio. Expect 100 to 200 MB. Name it `blowfish-round1-v1.mp4`.
- Save it in two places straight away: the MacBook Pro desktop and Google Drive (anyone with the link). Bring it on a USB stick to judging as well.
- **Still to answer (#59):** is the video part of the Devpost submission (usually a YouTube or Vimeo link), a file for the organisers, or played from our own laptop in the room? Until we know: upload to YouTube as Unlisted by 10:15 (processing takes a few minutes) and put the link in Devpost.

---

## 6. Judges' Q&A

Short answers, 2 to 3 sentences. Fill the [brackets] on Sunday.

1. **What in the video was live, and what was made earlier?**
   Live: the camera, hand tracking, the hand overlay, the gestures, the whole voice conversation and every tool call, and Claude naming the laptop. Made earlier with the same pipeline and checked: the MacBook's parts list and its twelve fal 3D models, and the hand's parts list, cached so the demo loads instantly. Anything we have not prepared is generated live and shown as "AI-estimated".

2. **How does the voice agent control the app?**
   One ElevenLabs Agents session listens, decides and speaks, and calls nine client tools that run in the browser: `get_scene`, `set_overlay`, `select_object`, `explode`, `highlight_part`, `show_step`, `rotate_model`, `reset_view`, `get_pose`. Each waits for a short result, often JSON with a hint such as a three-part tour or the next step. After each explode the app sends the parts list as a contextual update, so the agent knows exactly which parts exist.

3. **Is the agent really deciding? And how does it cope with a noisy room?**
   It chooses the tools from what you say; our prompt and the tool results guide it, and its wording is generated each time, so no two takes are the same. It acts only when addressed as "Blowfish" and stays silent if unsure. If the room is too loud, push-to-talk: hold Space or a mouse side button.

4. **What happens with an object you have not prepared?**
   The detector finds everyday things (phone, cup, bottle, book, mouse, keyboard, remote, screen). Claude names it from a camera crop and writes a parts list as JSON, which we validate and retry once if it is wrong; placeholder shapes appear at once and fal models replace them, two at a time. It is all marked "AI-estimated", and the tutor says so.

5. **Why fal, and not hand-made 3D models?**
   Modelling twelve laptop parts by hand takes days for one object; with fal each part is a text prompt to an image, then to a 3D model, for under 50 cents. That is what lets the same pipeline open an object we have never seen. For demo objects we keep a person in the loop: we review every model and regenerate the bad ones.

6. **How accurate are the AI-made internals?**
   The models are representative shapes, not CAD: what a part looks like and roughly where it sits. On the first run fal drew consumer products for seven of the twelve parts (a Wi-Fi router for "antennas"), so we rewrote the prompt to ask for the bare internal component and rejected and regenerated until they were right. The facts come from the parts list, which is checked for demo objects [true once #22 is closed]; live lists are marked "AI-estimated".

7. **And the anatomy? What did Kash do?**
   Kash, a fourth-year medic, checked the hand content against a list: which muscle bends which joint, nerve supply, the nine tendons in the carpal tunnel, the layer order [true once #21 is closed]. The overlay is drawn from 21 tracked points on the hand, so the forearm muscles are placed along the line of the hand: a teaching diagram, not a scan. It is educational, not medical advice, and the tutor says so if you ask about pain or injury.

8. **How fast is it?**
   Hand tracking and the overlay run on every camera frame on the laptop, 30 to 50 fps in our first test. A cached object is on screen [__ s] after you ask; the voice round trip is [__ s]. A brand-new object's parts list is designed to take 10 to 20 s [measured: __ s], with placeholders shown first, then the fal models arrive part by part [__ s each]; we cut the waits in the video and say so on the end card.

9. **Why passthrough glasses and not real AR?**
   The XREAL Air 2 Pro is a display with no camera or tracking, so we mirror the laptop screen into it and use our own head camera: video passthrough. That let us build on hardware we have, with all the vision running in a browser. The app does not depend on these glasses; the next step is a headset that gives apps its passthrough camera, so the model can sit in the room.

10. **Who is it for?**
    People who need to understand or fix a thing while looking at it: students learning anatomy or engineering, people repairing their own devices, technicians on unfamiliar kit. Hands-free matters because their hands are busy with the object. [Rio: pick the one to lead with.]

11. **What is next?**
    Put the 3D hand and forearm on stage (Kash's arm models are made but not yet wired in). Then more checked objects, a review flow so technicians and teachers can check an AI-estimated parts list and mark it checked, and world-locked models on a headset with camera access.

12. **How did you use Figma?**
    We designed the experience in Figma Make: a first prototype in a dark sci-fi HUD style, which we rejected as "too Tony Stark", then "Blowfish — concept prototype", a nine-step first-person voice story in calm frosted glass. The app and the prototype share one written design language: frosted pills, one card per part, a voice pill with captions, one blue accent, warm orange only for muscles and safety. [If built: the UI kit and the "how it works" page.]

13. **What did each of you do?**
    Rio: the idea, the hardware rig, the design direction, and running the build. Rohan: the ElevenLabs agent (prompt, the nine tools, wake word and push-to-talk) and the Claude endpoints. Kash: the fal pipeline and the 3D models, and the parts and anatomy content, checked as a medic.

14. **How did three people build this in a day?**
    Every task was a GitHub issue with one owner and a list of files it may touch; Claude Code agents worked from those issues, and nothing reached `main` without CI (typecheck and build) and a review. By Saturday night that was over 40 issues and over 20 merged pull requests [check the numbers on Sunday]. All the code was written during the hackathon; the APIs, models and libraries are not ours.

15. **What was hardest?**
    Getting fal to draw a bare internal part rather than a product: "antennas from a MacBook Air" gave us a router until we changed the prompt. And telling a pinch from typing: the gesture and key-press detectors use thresholds with hold times so a typing or resting hand does not turn or open the model. [Add whatever broke on Sunday morning.]

Spare, if asked about privacy: the video stays on the laptop and detection runs in the browser; only when you ask to analyse something is one crop of that object sent to Claude, and your voice goes to ElevenLabs. Our server listens on this machine only, and no key reaches the browser.

---

## 7. Decisions for Rio

1. **Cold open:** the MacBook pulled apart by hands (recommended, if take A works), or the typing hand lit up (the most reliable).
2. **P5, gestures or voice:** gestures if they work within three takes, otherwise voice. Do not mix the two in one shot.
3. **Whose typing hand in P8:** Rio's own (recommended: first person, and "my finger" matches the agent's prompt), or a teammate's.
4. **Who reads the voice-over:** recommended Rohan or Kash, not the wearer, so narration and live commands sound different.
5. **The live object in T2:** in or out, and which object (a mouse or a phone). About $5 of fal credit a try, and it needs the network.
6. **Plan B cut-off:** if voice has not worked by 08:35, film key-driven with the honest lines, or spend up to 20 more minutes fixing it.
7. **Show the ElevenLabs dashboard in T1:** yes if no key or private detail is on screen.
8. **Subtitles for the voice-over:** CapCut can add them in two minutes; they help in a noisy room but add clutter.
9. **Who edits, and in what:** iMovie or CapCut.
10. **The last line:** "Blowfish. X-ray vision you can talk to." or "Blowfish. Look at something, and ask what is inside."
