# Blowfish

**Voice-controlled X-ray vision for the physical world.**

You wear a camera and AR glasses, look at a real thing and say "Hey Blowfish, analyse this". A 3D model of it lifts out of the real object and floats in the middle of your view, over the live camera picture. You turn it and pull it apart into its parts with your hands, or by asking, and a voice tutor explains each part and answers your questions. It works on machines and on living things with the same pipeline.

Built at Imperial AI Hack (14 to 15 November 2026), Voice, Vision & Generative Media track. The repository is still called `xray-vision`; the product is Blowfish.

- Round 1 video plan, script and judges' Q&A: [`docs/pitch/video.md`](docs/pitch/video.md)
- Figma Make concept prototype: https://www.figma.com/make/vIDcMqov0Y85Ru6h4mlbUe/

## The problem

What makes a thing work is usually hidden inside it. To learn what is inside a laptop, how to replace its battery, or which muscles move your finger, you leave the object and go to a teardown video, a repair guide or an anatomy atlas, then map a flat picture back onto the real thing in front of you. Nothing explains the object while you are looking at it, in your own words, with your hands free.

## What it does

There are no modes, tabs or menus. One flow, driven by voice:

1. **Clean view.** You see exactly what the camera sees, with only a small voice pill at the bottom.
2. **"Hey Blowfish, overlay on."** Each thing Blowfish recognises (laptop, phone, hand, mug...) gets a small, quiet label on the object.
3. **"Analyse this."** "This" is whatever is in the centre of your view. A 3D model of it lifts out of the real object and floats in the middle of the view, assembled, with its parts just separated. The camera view keeps playing behind it, slightly dimmed and blurred. Nothing freezes.
4. **Your hands are the controller.** Pinch (thumb and index finger) and drag to turn the model; two open hands turn it like a globe. Hold an open hand over it and make a fist to grab it and move it. Pinch with both hands and pull apart to zoom in, together to zoom out. Snap your fingers to explode it (snap again to close it), and sweep a flat hand down from the top of the view to put it away. Voice does the same: "explode it", "put it back together", "turn it around", "move it left", "recentre it", "put it away".
5. **Questions.** "Tell me about the battery." "How would I replace it?" The tutor highlights the part it is talking about, says its safety note, and walks through the steps.
6. **Living things.** Look at a hand typing and ask "Which muscles move my finger?" The tendons and forearm muscles are drawn over the real hand, follow it live and light up with each key press.
7. **"Put it away." / "Overlay off."** The model drops back into its object; then back to the clean view.

What we show live:

- A **MacBook Air 13-inch (M3)** on a desk with someone typing on it: labels, analyse, turn it and explode it by hand, a tour of the parts, battery replacement steps.
- The **typing hands**: a live muscle and tendon overlay that reacts to key presses, explained by the tutor.
- The **eye**: look at someone's face and say "analyse the eye". The stored eye model (cornea to optic nerve) floats up; its steps follow the path of light. No picture of a face is sent anywhere for this.
- A **judge's object**, identified and pulled apart live if the network allows. Live parts lists are marked "AI-estimated".

Parts lists that were made live by AI are always shown as "AI-estimated". Biology content is educational, not medical advice.

## How it works

```
Camera (getUserMedia) -> Detection in the browser (MediaPipe: objects + hands, every frame)
        -> Store (zustand)  <- Voice agent (ElevenLabs) calls client tools
        -> Overlay (three.js, transparent canvas over the video) + labels, cards, captions

Browser --/api--> Local server (Express, 127.0.0.1)
   POST /api/identify       Claude vision: camera crop -> exact product name
   POST /api/scan           Claude vision: the whole view -> up to 10 named things
   POST /api/teardown       Claude: name -> parts list JSON (cache first)
   POST /api/generate-part  fal: part prompt -> image -> 3D model (GLB)
   GET  /api/agent-token    ElevenLabs signed URL for the voice session
```

- **Fast things run on the laptop:** camera, detection, gestures and drawing, every frame. **Slow things run in the background and are cached:** Claude and fal. Turning and exploding the model is three.js moving meshes; nothing is generated per frame.
- **Voice:** one ElevenLabs Agents session listens to the microphone, decides what to say and which tool to call, and speaks the answer. The agent drives the app through ten client tools that run in the browser: `get_scene`, `set_overlay`, `select_object`, `explode`, `highlight_part`, `show_step`, `reset_view`, `rotate_model`, `get_pose`. After each explode the app sends the agent the parts list as a contextual update, so it knows exactly which parts exist.
- **Analyse:** "this" is the thing in the middle of the view. The stored MacBook and the hand open at once from the on-device label, and Claude checks the name in the background; if Claude is confident it is something else, the app says so and switches to that object's parts. Any other detected thing is cropped and sent to Claude, which names it (at most 6 s, then the on-device label is used). If nothing is detected in the middle, the middle of the view itself is sent to Claude, so "analyse this" works on things the detector does not know. Its parts list (parts, layers, sizes, positions, one-line explanations, safety notes, repair steps) comes from the cache or, for a new object, from Claude. The model is shown in **stage mode** (the default): it glides to the middle of the view over the live video and turns slowly when idle. Placeholder glass shapes appear at once and are replaced by 3D models as they arrive.
- **See everything (the overlay sends frames to Claude):** while the overlay is on, every few seconds when the view is steady and has changed, the app sends Claude a small copy of the view (longest side 768 px, JPEG, every face the face tracker has found blacked out; the prompt also tells Claude never to list or describe people). Claude names up to ten things in it, and the overlay shows the ten most interesting; the thing in the middle of the view always gets a name, so "analyse this" opens it straight away. Nothing is sent while the overlay is off, or without a Claude key. **`?scan=0`** in the URL turns it off completely (the labels are then the on-device ones, as before).
- **Gestures:** MediaPipe's Hand Landmarker gives 21 points per hand, for up to two hands, every frame. The app smooths them, follows each hand through dropped frames, and reads coarse shapes (fist, open hand, pinch) and whole-hand motion, which survive a head camera better than fingertips; a typing or resting hand is ignored. What each gesture does is in "Controls" below.
- **Hands as the subject:** the same 21 landmarks drive the muscle and tendon overlay live on the real hand, and each fingertip's movement relative to its knuckle decides which muscles light up on a key press. The 3D hand and forearm model for the stage is still being made; until it lands, the hand's layers stay on the real hand.
- **Cache first:** `public/cache/<object_id>.json` holds the demo parts lists and `public/cache/meshes/<object_id>/` their 3D models. Anything generated live goes to `.cache-live/` (gitignored) and is shown as "AI-estimated". With no API keys the server answers from the cache, so the app runs from a fresh clone.
- **The rig:** a camera on the wearer's head (USB webcam on a cap, or an iPhone as a Continuity Camera) -> MacBook Pro running the app in Chrome -> XREAL Air 2 Pro glasses mirroring the screen, and the same screen on the projector. The wearer touches nothing.

## Quick start

Needs Node 20 or newer and Chrome (not Safari).

```bash
git clone https://github.com/Rio-Lai/xray-vision.git
cd xray-vision
npm install
npm run fetch-models   # once: downloads the vision models into public/models/
cp .env.example .env   # add keys; any missing key means that route runs from the cache
npm run dev
```

`npm run dev` prints two URLs. Open the app, http://localhost:5173, in **Chrome, not Safari** (the app is built and tested for Chrome only), and allow the camera and microphone. Both servers listen on this machine only (localhost), so nobody on the venue Wi-Fi can spend the API credits.

If the app says "Blowfish server is not running", look at the terminal where you ran `npm run dev`. If a port is taken, `npm run dev` stops and says which one: the API server uses port 8791 (change it with `PORT=` in `.env`; the Vite proxy follows automatically), the app uses 5173. Do not use port 8787: other dev tools listen there.

Check which keys the server sees (booleans only): http://localhost:5173/api/health

| `.env` | What it does |
| --- | --- |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_EFFORT`, `ANTHROPIC_IDENTIFY_EFFORT` | Claude for identify and parts lists (default model `claude-opus-5-5`). `ANTHROPIC_EFFORT` is the parts-list effort (default `medium`), `ANTHROPIC_IDENTIFY_EFFORT` the effort for naming an object (default `low`, so it answers within the 6 s limit); each is `low`, `medium`, `high`, `xhigh`, `max`, or `none` for older models that reject effort. Without a key, only cached objects can be analysed. |
| `FAL_KEY`, `FAL_IMAGE_MODEL`, `FAL_3D_MODEL`, `FAL_TEXTURED` | fal for part images and 3D models. Textured by default; `FAL_TEXTURED=0` makes plain white meshes. Without a key, parts without a cached model stay as placeholder shapes. |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID` | The voice tutor. Without them, voice is off. |
| `MOCK=1` | Answer every route from the cache, even with keys set (this turns voice off too). |
| `PORT` | API server port (default 8791). |

## Demo day

The MacBook and hand demos run from the laptop, so they survive bad venue Wi-Fi. While you still have a working network:

```bash
npm install            # needs the network
npm run check          # do the keys and the voice agent really work? (online, no credit spent)
npm run predemo        # downloads the vision models if they are missing, then checks everything offline needs
```

`npm run check` asks each provider with a free call whether its key works (Claude and `ANTHROPIC_MODEL`, the ElevenLabs key, agent and signed URL, fal), compares the agent's client tools with the ten the app answers (missing, extra, or not set to "Wait for response"), and checks `PORT`, ports 8791 and 5173, the local vision models and the cached objects. It never prints key values, and exits 0 only when the MacBook-and-hand demo with voice would work.

`npm run predemo` prints one ok / WARN / FAIL line per item and ends with PASS or FAIL. It checks the installed packages, the MediaPipe models and wasm in `public/models/`, every checked parts list in `public/cache/` and each of its 3D models (present, valid, no external files), that the app has no other remote URLs (no web fonts), and which keys `.env` sets (yes or no, never the values). Fix every FAIL line before the Wi-Fi goes. `node scripts/predemo.mjs --no-fetch` checks without downloading anything.

Then run `npm run dev`, open http://localhost:5173 in Chrome, and check http://localhost:5173/api/health shows the keys you expect. To prove it, turn the Wi-Fi off and reload: the debug panel (`D`) should say "wasm: local /models/wasm" and "object model: local; hand model: local".

Works with the Wi-Fi off:

- the camera, object detection and labels, hand tracking
- the cached MacBook Air and hand: parts lists, all twelve MacBook models, the muscle and tendon overlay with key presses
- gestures (pinch-drag, two hands apart), the hidden keys and the mouse
- part cards, safety notes and steps (`Left` / `Right`, `S`)

Needs the network:

- the voice session: ElevenLabs listens and speaks in the cloud. Without it the pill says "Voice off"; use the hidden keys.
- Claude: naming an object exactly, and the parts list for an object that is not cached. The MacBook and the hand never wait for it: they open at once from the detector's label ("laptop", "hand"), and Claude's exact name is filled in if it answers.
- live fal models for a new object's parts (cached parts never ask fal; hands never do).

If the Wi-Fi is slow rather than off, leave the keys in: the MacBook and the hand still open at once, and for any other object "analyse this" waits at most 6 seconds for Claude to name it before it goes on with the detector's label. Only a new object's parts list and its fal models are slow on a slow network. Do not use `MOCK=1`: it turns voice off too.

## On an iPhone

Blowfish can also run on an iPhone (built for the iPhone 16) with the XREAL glasses plugged into the phone's USB-C port, using the phone's camera and microphone. The Mac stays somewhere else as the server; the phone reaches it over the internet.

On the Mac, paste this one line into Terminal (it stops anything still on ports 5173 and 8791, updates, installs and starts):

```bash
cd ~/xray-vision && { lsof -t -iTCP:5173 -iTCP:8791 -sTCP:LISTEN | xargs kill 2>/dev/null; sleep 1; git pull && npm install && npm run phone; }
```

`npm run phone` checks the ports like `npm run dev`, downloads the vision models if they are missing, builds the app, starts the server (the built app and `/api` on port 8791), opens a free Cloudflare quick tunnel to it and prints a link and its QR code, for example `https://some-random-words.trycloudflare.com/?phone=1&overlay=1&code=k7xq2mnp4r`. The tunnel gives the phone the https it needs for the camera and microphone. `cloudflared` (the tunnel program) is only fetched when `npm run phone` runs, never by `npm install`: one already installed (brew or the PATH) is used, else the official release is downloaded once into `.bin/`; if that fails too, it says to paste `brew install cloudflared`.

On the phone:

1. Open the link in Safari (or scan the QR code with the Camera app), tap "Tap to start", and allow the camera and the microphone.
2. Turn the phone sideways (if it is upright, the screen says so), then plug in the glasses: they mirror the phone screen.
3. Optional, for full screen without Safari's bars: Share > Add to Home Screen, then open Blowfish from the home screen. That icon only works until `npm run phone` stops: every restart makes a new link (a new tunnel address and code), so open the new link in Safari, then Add to Home Screen again (and delete the old icon).

The buttons on the right do what the hidden keys do on the laptop: Voice (V), Analyse (A), Explode (E), Put away (R) and a small D for the debug panel. Touch drag turns the model on stage; a tap picks a part. Problems show as one sentence on the screen (camera blocked, voice could not connect, the Mac cannot be reached).

- **Access code.** The tunnel link is public, and `/api` spends the API credits, so each run makes a new random code; it is the `code=` at the end of the link. The first visit with it sets a cookie on the phone; anything without the code or the cookie gets "this link needs its access code". Set `BLOWFISH_PHONE_CODE=` in `.env` to keep one code across runs; the tunnel address still changes on every run, so after a restart always open the new link. The Mac itself (http://localhost:8791) needs no code.
- **Keep the Mac awake and online.** `npm run phone` keeps it from sleeping while it runs (`caffeinate`), but keep it plugged in with the lid open, and on a network. Ctrl-C in its window stops the server and the tunnel.
- **What needs the internet:** everything in this mode goes through the tunnel, so both the Mac and the phone need a connection (the phone can use mobile data). The voice tutor, Claude and fal need it as on the laptop. The vision models come from the Mac (`npm run fetch-models` runs by itself if they are missing; otherwise the phone fetches them from Google).
- The phone runs lighter settings: the small object detector (Lite0), canvases at 1.25 device pixels per CSS pixel (`?dpr=` changes it), no noise gate (on iOS a second use of the microphone can silence the voice session) and the phone's default microphone.
- Without `?phone=1` nothing changes, and `npm run dev` on the laptop is exactly as before.

## Controls

While a model is on stage. Hands work only once a hand has been in view for a moment and is not typing or resting on the laptop; a small ring marks each hand Blowfish is following (filled while it is doing something), and one word ("Turning", "Opening", "Closing", "Zooming", "Moving") shows above the voice pill.

| | Turn | Open / close | Zoom | Move | Centre |
| --- | --- | --- | --- | --- | --- |
| **Hands** | Pinch (thumb to index) and drag; or both hands open, move them like spinning a globe (both sideways, both up or down, or one hand pushed away while the other comes closer) | Snap your fingers: explodes it, or closes it back to analysed if open (`?twoopen=1`: the two-hand pinch opens it first); a flat hand swept down from the top of the view puts it away | Pinch with both hands and pull apart / bring together | An open hand over the model, then a fist: it follows the fist until you open the hand | |
| **Mouse, trackpad** | Drag | Wheel | Trackpad pinch (wheel + Ctrl) | Shift-drag or right-drag | Double-click |
| **Keys** | | `A` analyse, `E` explode, `R` put away | `+` / `-` | Shift + arrow keys | `0` |
| **Voice** | "turn it around" | "explode it", "put it back together", "collapse it", "put it away" | "zoom in", "closer", "normal size" | "move it left / right / up / down" | "recentre it" |

Hands never open something from nothing (voice and `A` / `E` do); the sweep down puts it away (saved, as "put it away"). Sweep: start with the open hand near the top of the view (palm in the top 40 percent), then wipe it straight down past the middle, briskly (about a third of a second to a second; straight out of the bottom is fine). Snap: press the thumb on the middle fingertip for a moment, then snap; the camera sees the pose before and after, so 30 fps is enough. The pinch, the fist and the open hand are read from MediaPipe's 3D hand (its world landmarks), so they work with the hand seen from behind or pointing away from the head camera (`?world=0`: from the image, as before). The ring sits between the thumb and index fingertips (at the palm for a fist), fills as soon as a pinch counts, and shows one word under it while that hand does something ("Rotating", "Panning", "Zooming", "Exploding", "Closing"). A gesture misbehaving on the rig: `?snap=0`, `?sweep=0`, `?grab=0`, `?globe=0`, `?twohand=0`, or `?gestures=0` for all of them; `?pinchturn=0` makes the pinch move the model, `?burst=1` brings back the fist-flick open / close, `?pan=1` the two-hand move. `?mock=gesture` plays each hand gesture in turn with scripted hands.

## Developer fallback

Never shown on screen during the demo; voice does all of this. The keys show nothing on screen when they work.

| Key | Does |
| --- | --- |
| `V` | Start / stop the voice session (same as clicking the voice pill) |
| `O` | Overlay on / off |
| `A` | Analyse "this": the model floats up, assembled, parts just apart |
| `E` | Explode "this" fully |
| `R` | Reset: put the model away |
| `S` | Next step |
| `Left` / `Right` or `[` / `]` | Previous / next part (silent: the agent is told, nothing is captioned) |
| `F` | Freeze / unfreeze the frame |
| `M` | Tracking mode: stage (default), freeze, follow |
| `D` | Debug panel: status, camera picker, gesture and key-press sliders (saved in this browser) |
| `/` | Typed command box: Enter sends it (to the agent if connected), Esc closes |
| hold `Space` | Push-to-talk; holding a mouse side button (middle, back or forward) does the same |
| `P` | Push-to-talk only on / off: the microphone is muted unless you hold (remembered) |
| `\` | Next microphone (remembered) |

Mouse and keys for the model on stage: see "Controls" above. A click without dragging picks a part.

URL options:

- `?mock=1` (or `?mock=laptop`, `?mock=hand`): no camera or vision models needed; a fake laptop, phone and typing hand (`hand` puts the hand in the centre of view). Fake data: never film it for the product shots.
- `?mock=gesture`: the fake laptop is analysed by itself, then scripted hands play every hand control in turn: pinch turn, two-hand zoom, fist grab and move, globe turn, finger snap (explodes), sweep down (puts it away; analysed again for the next loop)
- `?mock=eye`: a fake face in the middle of the view, to open the eye without a camera
- `?look=classic`: the interface as it was before the Figma Make kit, to compare or fall back
- `?lift=0`: the model cross-fades in on the stage instead of lifting out of the real object (a fallback if the transition misbehaves)
- `?detector=lite0` / `?detector=lite2`: force the small or the large object detector; `?appear=0.45&keep=0.25`: the score a thing needs to get a label, and to keep it
- `?resthand=0.22&typingms=1500`: a hand smaller than this share of the frame height counts as "on the desk" and is ignored for gestures while it has typed within that many milliseconds or rests on a laptop (0 turns either rule off)
- `?facecrop=0.45`: the face tracker looks at a tighter square in the middle of the view (finds a face further away; default 0.6, `1` = the whole frame)
- `?overlay=1`: start with the overlay on
- `?blur=0`: only dim the video behind the model, no blur (default 4; up to 12)
- `?dwell=1`: pick a part by looking at it for 1.2 s
- `?hands=raw`: use if left and right hands look swapped
- `?mic=<part of the name>`: pick the microphone, for example `?mic=c920` or `?mic=iphone` (remembered)
- `?ptt=1` / `?ptt=0`: push-to-talk only on / off (remembered)
- Gesture tuning: `?pinch=0.3&unpinch=0.45&hold=90&reach=1&rot=1.1&spread=1&burstms=400&globegain=1.3&pangain=1`; `?snap=0`, `?sweep=0`, `?grab=0`, `?globe=0`, `?twohand=0` turn one gesture off, `?gestures=0` all of them; `?pinchturn=0`, `?twoopen=1`, `?burst=1`, `?pan=1`, `?world=0` as above. URL values override the debug panel sliders (saved in this browser). Voice: `?gate=0` turns the noise gate off, `?gatedb=12` sets how far above the room the wearer must be, `?lock=1` mutes the microphone from the end of a command until Blowfish has answered.
- Key-press tuning: `?press=0.6&release=0.15&extend=1.2`

## Scripts

- `npm run dev`: checks both ports are free, then starts the API server and Vite together
- `npm run dev:server`, `npm run dev:web`: one at a time
- `npm run phone`: the app on an iPhone through a Cloudflare tunnel, with a printed link and QR code (see "On an iPhone")
- `npm run typecheck`, `npm run build`: what CI runs on every pull request
- `npm run fetch-models`: download the MediaPipe models and wasm into `public/models/` (run once)
- `npm run check`: check every key against its provider, the voice agent's tools, ports, models and cache (see "Demo day")
- `npm run predemo`: fetch the models if missing, then check that everything the cached demos need is on the laptop (see "Demo day")
- `npm run pregenerate -- <object_id>`: make the part models for a cached parts list with fal, for review (needs `FAL_KEY`; see `docs/KASH.md`)
- `npm run build-eye`: build the procedural eye models

## APIs, models and datasets

- **Anthropic Claude** (Messages API, `@anthropic-ai/sdk`), model from `ANTHROPIC_MODEL`, default `claude-opus-5-5`: names the object from a camera crop (vision) and writes the parts list JSON, which is checked against a zod schema. Each live part comes with a short `visual` phrase (what it looks like on its own), which leads that part's fal image prompt.
- **ElevenLabs Agents** (`@elevenlabs/react`, signed URL from `GET /v1/convai/conversation/get-signed-url`): speech to text, the tutor conversation, text to speech, and the ten client tools.
- **fal** (`@fal-ai/client`):
  - `fal-ai/flux/schnell`: text to image, one picture per part (`FAL_IMAGE_MODEL`)
  - `fal-ai/hunyuan3d/v2/turbo`: image to 3D GLB, one model per part, textured by default (`FAL_3D_MODEL`, `FAL_TEXTURED`)
  - `fal-ai/flux/dev`: iris texture for the procedural eye
  - `fal-ai/flux-pro/v1.1`: retina (fundus) texture for the procedural eye
  - All twelve MacBook Air parts have a fal model, made ahead with `npm run pregenerate`, reviewed, compressed (each under 1 MB) and committed in `public/cache/meshes/macbook-air-m3-13/`.
- **Google MediaPipe Tasks Vision** 0.10.14, in the browser:
  - Object Detector with **EfficientDet-Lite2** (float16; **EfficientDet-Lite0** as the automatic fallback if Lite2 is missing or too slow on this machine), trained on **COCO**: finds laptops, phones, cups, bottles, books and other everyday objects (every second or third frame)
  - **Hand Landmarker** (float16): 21 landmarks per hand, up to two hands, every frame, for the gestures, the muscle overlay and key-press detection
  - **Face Landmarker** (float16): face landmarks with irises, blink and gaze values, every third frame, for the eyes as objects
- **Dataset:** COCO, through the pre-trained EfficientDet object classes. We trained no models.
- **Libraries:** three.js, React 18, Vite, TypeScript, zustand, zod, Express, glTF Transform (compressing the committed 3D models, building the eye), sharp (eye texture preparation).
- **Hardware:** XREAL Air 2 Pro glasses, a USB webcam or an iPhone as a Continuity Camera, a MacBook Pro.
- **Design:** Figma Make, for the [concept prototype](https://www.figma.com/make/vIDcMqov0Y85Ru6h4mlbUe/) of the experience and the wider vision.

## Team

- **Rio**: design engineering, the hardware rig
- **Rohan**: the ElevenLabs voice agent
- **Kash**: 4th-year medic; the fal 3D models and the parts and anatomy content

## Built during the hackathon

All code in this repository was written during Imperial AI Hack, starting on 14 November 2026, much of it with Claude Code agents working from GitHub issues. The pre-trained models, APIs and open-source libraries listed above are not ours.

## For contributors

The brief, roles and workflow are in `docs/PROJECT.md`; the data contracts in `docs/CONTRACTS.md`. Voice agent setup: `docs/ROHAN.md`. fal pipeline and content checks: `docs/KASH.md`. The round 1 video plan: `docs/pitch/video.md`.
