# X-Ray Vision

AR x-ray vision for the Imperial AI Hack. A webcam on your cap feeds a web app, and the screen is mirrored into XREAL glasses. Look at an object, say "explode this", and a 3D exploded view of its parts floats over it. A voice tutor then walks you through the parts and drives the view.

Two lenses:

- **Engineering**: the live demo object is a MacBook Air 13-inch (M3).
- **Biology**: the live demo is the finger muscles of the hands typing on it ("which muscle is working when I press this key?").

## Quick start

Needs Node 20 or newer and Chrome.

```bash
git clone https://github.com/Rio-Lai/xray-vision.git
cd xray-vision
npm install
npm run fetch-models   # once: downloads the vision models into public/models/ so the demo works offline
cp .env.example .env   # add keys; any missing key means that route runs in mock mode
npm run dev
```

Open http://localhost:5173 in Chrome and allow the camera and microphone. Both servers listen on this machine only (localhost); that is deliberate, so nobody on the venue Wi-Fi can spend the API credits.

With no keys at all the app still runs: identify and teardown answer from `public/cache/`, meshes stay as placeholder shapes, and the voice bar says "Voice not configured yet". You can type commands into the voice bar instead ("explode this", "step 2", "what is the battery", "reset").

Check which keys the server sees: http://localhost:5173/api/health (booleans only)

## How it works

1. MediaPipe detects a laptop or a hand in the camera frame.
2. `POST /api/identify`: Claude vision names the object from a crop.
3. `POST /api/teardown`: Claude returns the parts as JSON (checked files in `public/cache/` win).
4. The overlay draws placeholder shapes at once.
5. `POST /api/generate-part`: fal makes an image, then a GLB mesh, per part. Meshes swap in as they arrive.
6. The ElevenLabs voice tutor explains the parts and calls client tools to drive the view.

## Who owns what

| Area | Paths | Owner |
| --- | --- | --- |
| Contracts | `shared/teardown.ts`, `src/state/store.ts` | orchestrator (ask before changing) |
| Camera, detection, overlay, HUD | `src/stage/`, `src/camera/`, `src/detect/`, `src/overlay/`, `src/hud/`, `public/models/`, `scripts/fetch-models.*` | vision |
| Server, API client, flow, voice, cache, docs | `server/`, `src/lib/`, `src/voice/`, `public/cache/`, `scripts/pregenerate.ts`, `docs/` | repo |
| Voice agent prompt and Claude routes | see `docs/ROHAN.md` | Rohan |
| fal pipeline and biology content check | see `docs/KASH.md` | Kash |

Contracts and rules: `docs/CONTRACTS.md`.

## Scripts

- `npm run dev`: server (port 8787) and Vite (port 5173) together
- `npm run dev:server`, `npm run dev:web`: one at a time
- `npm run typecheck`
- `npm run fetch-models`: download the MediaPipe models into `public/models/` (run once)
- `npm run pregenerate -- <object_id>`: make every part mesh for a cached teardown (needs `FAL_KEY`)

## Keyboard shortcuts

| Key | Does |
| --- | --- |
| `E` | Explode the object under the reticle |
| `R` | Reset |
| `F` | Freeze / unfreeze the frame |
| `L` | Switch lens (also resets) |
| `Left` / `Right` or `[` / `]` | Previous / next part |
| `S` | Next step |
| `M` | Tracking mode (freeze -> follow -> mat) |
| `H` | Legend |
| `D` | Debug panel |

Click a part, or hold the reticle on it for 1.2 s, to pick it.

URL options:

- `?mock=1`: no camera or models needed
- `?hands=raw`: use if left and right hands look swapped
- `?press=0.6&release=0.15&extend=1.2`: finger-press tuning

## APIs and models used (for Devpost)

- Anthropic Claude (`ANTHROPIC_MODEL`, default `claude-sonnet-5-5`): object identification from a camera crop, teardown JSON
- fal: `fal-ai/flux/schnell` (text to image), `fal-ai/hunyuan3d/v2/turbo` (image to 3D GLB)
- ElevenLabs Agents: voice tutor with client tools
- MediaPipe Tasks Vision: object and hand detection in the browser
- three.js: 3D overlay
- XREAL glasses: display (screen mirroring)
