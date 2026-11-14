# Blowfish

**Voice-controlled X-ray vision for the physical world.**

You wear a camera and AR glasses, look at a real thing and say "Hey Blowfish, explode this". Blowfish freezes the view, pulls the object apart into its parts as floating 3D pieces placed over the real object, and a voice tutor explains each part and answers your questions. It works on machines and on living things with the same pipeline.

Built at Imperial AI Hack (14 to 15 November 2026), Voice, Vision & Generative Media track. The repository is still called `xray-vision`; the product is Blowfish.

## The problem

What makes a thing work is usually hidden inside it. To learn what is inside a laptop, how to replace its battery, or which muscles move your finger, you leave the object and go to a teardown video, a repair guide or an anatomy atlas, then map a flat picture back onto the real thing in front of you. Nothing explains the object while you are looking at it, in your own words, with your hands free.

## What it does

There are no modes, tabs or menus. One flow, all by voice:

1. **Clean view.** You see exactly what the camera sees, with only a small listening dot.
2. **"Hey Blowfish, overlay on."** Each thing Blowfish recognises (laptop, phone, hand, mug...) gets a small, quiet label on the object.
3. **"What is this?" / "Explode this."** "This" is whatever is in the centre of your view. The frame freezes and the object's parts lift out into an exploded view placed over it, each with a label.
4. **Questions.** "Tell me about the battery." "How would I replace it?" The tutor highlights the part it is talking about and walks through the steps.
5. **Living things.** Look at a hand typing and ask "Which muscles move my finger?" The tendons and forearm muscles are drawn over the real hand, follow it live and light up with each key press.
6. **"Put it back." / "Overlay off."** Back to the clean view.

What we show live:

- A **MacBook Air 13-inch (M3)** on a desk with someone typing on it: labels, explode, a tour of the parts, battery replacement steps.
- The **typing hands**: a live muscle and tendon overlay that reacts to key presses, explained by the tutor.
- A **judge's object**, identified and pulled apart live. Live parts lists are marked "AI-estimated".

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

- **Fast things run on the laptop:** camera, detection and drawing, every frame. **Slow things run in the background and are cached:** Claude and fal. The explode animation is three.js moving meshes; nothing is generated per frame.
- **Voice:** one ElevenLabs Agents session listens to the microphone, decides what to say and which tool to call, and speaks the answer. The agent drives the app through eight client tools: `get_scene`, `set_overlay`, `select_object`, `explode`, `highlight_part`, `show_step`, `reset_view`, `get_pose`.
- **Explode:** the object in the centre of view is cropped and sent to Claude, which names it exactly. Its parts list (parts, layers, sizes, positions, one-line explanations, safety notes, repair steps) comes from the cache or, for a new object, from Claude. Placeholder shapes appear at once and are replaced by 3D models as they arrive.
- **Hands:** MediaPipe's 21 hand landmarks drive the muscle and tendon overlay live (no freeze), and finger movement decides which muscles light up.
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
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Claude for identify and parts lists. Without a key, only cached objects can be exploded. |
| `FAL_KEY`, `FAL_IMAGE_MODEL`, `FAL_3D_MODEL`, `FAL_TEXTURED` | fal for part images and 3D models. Without a key, parts without a cached model stay as placeholder shapes. |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID` | The voice tutor. Without them, voice is off. |
| `MOCK=1` | Answer every route from the cache, even with keys set. |
| `PORT` | API server port (default 8791). |

## Developer fallback

Never shown on screen during the demo; voice does all of this.

| Key | Does |
| --- | --- |
| `O` | Overlay on / off |
| `E` | Explode "this" |
| `R` | Reset |
| `F` | Freeze / unfreeze the frame |
| `S` | Next step |
| `M` | Tracking mode |
| `Left` / `Right` or `[` / `]` | Previous / next part |
| `D` | Debug panel |

Click a part to pick it. URL options:

- `?mock=1` (or `?mock=hand`): no camera or models needed; a fake laptop and typing hand
- `?overlay=1`: start with the overlay on
- `?dwell=1`: pick a part by looking at it for 1.2 s
- `?hands=raw`: use if left and right hands look swapped
- `?press=0.6&release=0.15&extend=1.2`: finger-press tuning

## Scripts

- `npm run dev`: checks both ports are free, then starts the API server and Vite together
- `npm run dev:server`, `npm run dev:web`: one at a time
- `npm run typecheck`, `npm run build`: what CI runs on every pull request
- `npm run fetch-models`: download the MediaPipe models and wasm into `public/models/` (run once)
- `npm run pregenerate -- <object_id>`: make the part models for a cached parts list with fal, for review (needs `FAL_KEY`; see `docs/KASH.md`)
- `npm run build-eye`: build the procedural eye models

## APIs, models and datasets

- **Anthropic Claude** (Messages API, `@anthropic-ai/sdk`), model from `ANTHROPIC_MODEL`, default `claude-sonnet-5-5`: names the object from a camera crop (vision) and writes the parts list JSON.
- **ElevenLabs Agents** (`@elevenlabs/react`, signed URL from `GET /v1/convai/conversation/get-signed-url`): speech to text, the tutor conversation, text to speech, and the eight client tools.
- **fal** (`@fal-ai/client`):
  - `fal-ai/flux/schnell`: text to image, one picture per part (`FAL_IMAGE_MODEL`)
  - `fal-ai/hunyuan3d/v2/turbo`: image to 3D GLB, one model per part (`FAL_3D_MODEL`)
  - `fal-ai/flux/dev`: iris texture for the procedural eye
  - `fal-ai/flux-pro/v1.1`: retina (fundus) texture for the procedural eye
- **Google MediaPipe Tasks Vision** 0.10.14, in the browser:
  - Object Detector with **EfficientDet-Lite0** (float16), trained on **COCO**: finds laptops, phones, cups, bottles, books and other everyday objects
  - **Hand Landmarker** (float16): 21 landmarks per hand, for the muscle overlay and key-press detection
- **Dataset:** COCO, through the pre-trained EfficientDet-Lite0 object classes. We trained no models.
- **Libraries:** three.js, React 18, Vite, TypeScript, zustand, zod, Express, glTF Transform (compressing the committed 3D models, building the eye), sharp (eye texture preparation).
- **Hardware:** XREAL Air 2 Pro glasses, a USB webcam or an iPhone as a Continuity Camera, a MacBook Pro.
- **Design:** Figma, for the prototype of the wider vision.

## Team

- **Rio**: design engineering, the hardware rig
- **Rohan**: the ElevenLabs voice agent
- **Kash**: 4th-year medic; the fal 3D models and the parts and anatomy content

## Built during the hackathon

All code in this repository was written during Imperial AI Hack, starting on 14 November 2026, much of it with Claude Code agents working from GitHub issues. The pre-trained models, APIs and open-source libraries listed above are not ours.

## For contributors

The brief, roles and workflow are in `docs/PROJECT.md`; the data contracts in `docs/CONTRACTS.md`. Voice agent setup: `docs/ROHAN.md`. fal pipeline and content checks: `docs/KASH.md`.
