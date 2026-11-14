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
4. **Your hands are the controller.** Pinch (thumb and index finger) and drag to turn the model like a globe. Pinch with both hands and move them apart to explode it into its parts; bring them together to close it. Voice does the same: "explode it", "put it back together", "turn it around".
5. **Questions.** "Tell me about the battery." "How would I replace it?" The tutor highlights the part it is talking about, says its safety note, and walks through the steps.
6. **Living things.** Look at a hand typing and ask "Which muscles move my finger?" The tendons and forearm muscles are drawn over the real hand, follow it live and light up with each key press.
7. **"Put it away." / "Overlay off."** The model drops back into its object; then back to the clean view.

What we show live:

- A **MacBook Air 13-inch (M3)** on a desk with someone typing on it: labels, analyse, turn it and explode it by hand, a tour of the parts, battery replacement steps.
- The **typing hands**: a live muscle and tendon overlay that reacts to key presses, explained by the tutor.
- A **judge's object**, identified and pulled apart live if the network allows. Live parts lists are marked "AI-estimated".

Parts lists that were made live by AI are always shown as "AI-estimated". Biology content is educational, not medical advice.

## How it works

```
Camera (getUserMedia) -> Detection in the browser (MediaPipe: objects + hands, every frame)
        -> Store (zustand)  <- Voice agent (ElevenLabs) calls client tools
        -> Overlay (three.js, transparent canvas over the video) + labels, cards, captions

Browser --/api--> Local server (Express, 127.0.0.1)
   POST /api/identify       Claude vision: camera crop -> exact product name
   POST /api/teardown       Claude: name -> parts list JSON (cache first)
   POST /api/generate-part  fal: part prompt -> image -> 3D model (GLB)
   GET  /api/agent-token    ElevenLabs signed URL for the voice session
```

- **Fast things run on the laptop:** camera, detection, gestures and drawing, every frame. **Slow things run in the background and are cached:** Claude and fal. Turning and exploding the model is three.js moving meshes; nothing is generated per frame.
- **Voice:** one ElevenLabs Agents session listens to the microphone, decides what to say and which tool to call, and speaks the answer. The agent drives the app through nine client tools that run in the browser: `get_scene`, `set_overlay`, `select_object`, `explode`, `highlight_part`, `show_step`, `reset_view`, `rotate_model`, `get_pose`. After each explode the app sends the agent the parts list as a contextual update, so it knows exactly which parts exist.
- **Analyse:** the object in the centre of view is cropped and sent to Claude, which names it exactly. Its parts list (parts, layers, sizes, positions, one-line explanations, safety notes, repair steps) comes from the cache or, for a new object, from Claude. The model is shown in **stage mode** (the default): it glides to the middle of the view over the live video and turns slowly when idle. Placeholder glass shapes appear at once and are replaced by 3D models as they arrive.
- **Gestures:** MediaPipe's Hand Landmarker gives 21 points per hand, for up to two hands, every frame. A pinch must hold briefly, with the other fingers open, before it counts, so a typing or resting hand does not move the model. One pinching hand dragging turns the model; two pinching hands moving apart or together open or close it.
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
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_EFFORT` | Claude for identify and parts lists (default model `claude-sonnet-5-5`, effort `low`). Without a key, only cached objects can be analysed. |
| `FAL_KEY`, `FAL_IMAGE_MODEL`, `FAL_3D_MODEL`, `FAL_TEXTURED` | fal for part images and 3D models. Textured by default; `FAL_TEXTURED=0` makes plain white meshes. Without a key, parts without a cached model stay as placeholder shapes. |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID` | The voice tutor. Without them, voice is off. |
| `MOCK=1` | Answer every route from the cache, even with keys set (this turns voice off too). |
| `PORT` | API server port (default 8791). |

## Demo day

The MacBook and hand demos run from the laptop, so they survive bad venue Wi-Fi. While you still have a working network:

```bash
npm install            # needs the network
npm run predemo        # downloads the vision models if they are missing, then checks everything offline needs
```

`npm run predemo` prints one ok / WARN / FAIL line per item and ends with PASS or FAIL. It checks the installed packages, the MediaPipe models and wasm in `public/models/`, every checked parts list in `public/cache/` and each of its 3D models (present, valid, no external files), that the app has no other remote URLs (no web fonts), and which keys `.env` sets (yes or no, never the values). Fix every FAIL line before the Wi-Fi goes. `node scripts/predemo.mjs --no-fetch` checks without downloading anything.

Then run `npm run dev`, open http://localhost:5173 in Chrome, and check http://localhost:5173/api/health shows the keys you expect. To prove it, turn the Wi-Fi off and reload: the debug panel (`D`) should say "wasm: local /models/wasm" and "object model: local; hand model: local".

Works with the Wi-Fi off:

- the camera, object detection and labels, hand tracking
- the cached MacBook Air and hand: parts lists, all twelve MacBook models, the muscle and tendon overlay with key presses
- gestures (pinch-drag, two hands apart), the hidden keys and the mouse
- part cards, safety notes and steps (`Left` / `Right`, `S`)

Needs the network:

- the voice session: ElevenLabs listens and speaks in the cloud. Without it the pill says "Voice off"; use the hidden keys.
- Claude: naming an object exactly, and the parts list for an object that is not cached. With no network the MacBook and hand still open, because identify falls back to the detector's label ("laptop", "hand").
- live fal models for a new object's parts (cached parts never ask fal; hands never do).

If the Wi-Fi is slow rather than off, comment out `ANTHROPIC_API_KEY` and `FAL_KEY` in `.env` and restart `npm run dev`: "analyse this" then never waits for Claude, and voice stays on. Do not use `MOCK=1` for this: it turns voice off too.

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

Mouse, while a model is on stage: drag turns it (with a little inertia), the wheel opens and closes it, and a click without dragging picks a part.

URL options:

- `?mock=1` (or `?mock=laptop`, `?mock=hand`): no camera or vision models needed; a fake laptop, phone and typing hand (`hand` puts the hand in the centre of view). Fake data: never film it for the product shots.
- `?mock=gesture`: the fake laptop is analysed by itself, then scripted hands turn it and pull it apart
- `?overlay=1`: start with the overlay on
- `?blur=0`: only dim the video behind the model, no blur (default 4; up to 12)
- `?dwell=1`: pick a part by looking at it for 1.2 s
- `?hands=raw`: use if left and right hands look swapped
- `?mic=<part of the name>`: pick the microphone, for example `?mic=c920` or `?mic=iphone` (remembered)
- `?ptt=1` / `?ptt=0`: push-to-talk only on / off (remembered)
- Gesture tuning: `?pinch=0.25&unpinch=0.4&hold=70&rot=1.1&spread=0.9`; `?twohand=0` turns off the two-hand spread, `?burst=1` turns on fist-then-open-hand to explode, `?gestures=0` turns all gestures off. URL values override the debug panel sliders.
- Key-press tuning: `?press=0.6&release=0.15&extend=1.2`

## Scripts

- `npm run dev`: checks both ports are free, then starts the API server and Vite together
- `npm run dev:server`, `npm run dev:web`: one at a time
- `npm run typecheck`, `npm run build`: what CI runs on every pull request
- `npm run fetch-models`: download the MediaPipe models and wasm into `public/models/` (run once)
- `npm run predemo`: fetch the models if missing, then check that everything the cached demos need is on the laptop (see "Demo day")
- `npm run pregenerate -- <object_id>`: make the part models for a cached parts list with fal, for review (needs `FAL_KEY`; see `docs/KASH.md`)
- `npm run build-eye`: build the procedural eye models

## APIs, models and datasets

- **Anthropic Claude** (Messages API, `@anthropic-ai/sdk`), model from `ANTHROPIC_MODEL`, default `claude-sonnet-5-5`: names the object from a camera crop (vision) and writes the parts list JSON, which is checked against a zod schema.
- **ElevenLabs Agents** (`@elevenlabs/react`, signed URL from `GET /v1/convai/conversation/get-signed-url`): speech to text, the tutor conversation, text to speech, and the nine client tools.
- **fal** (`@fal-ai/client`):
  - `fal-ai/flux/schnell`: text to image, one picture per part (`FAL_IMAGE_MODEL`)
  - `fal-ai/hunyuan3d/v2/turbo`: image to 3D GLB, one model per part, textured by default (`FAL_3D_MODEL`, `FAL_TEXTURED`)
  - `fal-ai/flux/dev`: iris texture for the procedural eye
  - `fal-ai/flux-pro/v1.1`: retina (fundus) texture for the procedural eye
  - All twelve MacBook Air parts have a fal model, made ahead with `npm run pregenerate`, reviewed, compressed (each under 1 MB) and committed in `public/cache/meshes/macbook-air-m3-13/`.
- **Google MediaPipe Tasks Vision** 0.10.14, in the browser:
  - Object Detector with **EfficientDet-Lite0** (float16), trained on **COCO**: finds laptops, phones, cups, bottles, books and other everyday objects (every third frame)
  - **Hand Landmarker** (float16): 21 landmarks per hand, up to two hands, every frame, for the gestures, the muscle overlay and key-press detection
- **Dataset:** COCO, through the pre-trained EfficientDet-Lite0 object classes. We trained no models.
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
