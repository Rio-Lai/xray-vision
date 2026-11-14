# Kash: fal pipeline and biology content

## fal pipeline

- Route: `server/routes/generate-part.ts` (cache checks, dedupe of repeat requests).
- fal calls: `server/lib/fal.ts`. Text to image with `FAL_IMAGE_MODEL` (default `fal-ai/flux/schnell`), then image to 3D with `FAL_3D_MODEL` (default `fal-ai/hunyuan3d/v2/turbo`). `FAL_TEXTURED=1` asks Hunyuan for a textured mesh (about 3x the price and slower).
- Prompts per part are built in `shared/prompts.ts` (`partPrompt`, also used by `npm run pregenerate`). Tune them there.
- The client asks for two parts at a time and skips quietly on failure. It never asks for hand parts: the hand overlay draws from landmarks and ignores `mesh_url`.

### Pre-generation

```bash
npm run pregenerate -- macbook-air-m3-13
npm run pregenerate -- hand-finger-muscles
```

For every part without a mesh it runs the fal pipeline, downloads the GLB to `.cache-live/review/meshes/<object_id>/<part_id>.glb`, and writes `.cache-live/review/<object_id>.json` with `mesh_url` set to `/cache/meshes/<object_id>/<part_id>.glb`. Look at the meshes (for example drag them into https://gltf-viewer.donmccurdy.com). Then promote the good ones:

```bash
mkdir -p public/cache/meshes/<object_id>
cp .cache-live/review/meshes/<object_id>/<part_id>.glb public/cache/meshes/<object_id>/
```

and set that part's `mesh_url` in `public/cache/<object_id>.json`. The server also serves any GLB in `public/cache/meshes/` straight away, even without a key.

## Cache layout

```
public/cache/<object_id>.json                   checked teardowns (committed)
public/cache/meshes/<object_id>/<part_id>.glb   checked meshes (committed)
.cache-live/                                    unreviewed AI output (gitignored)
```

## Checklist: verify `public/cache/hand-finger-muscles.json`

This file was written by an AI and needs a medic's check before the demo. The part ids are fixed (the overlay uses them); change any text freely.

- [ ] Each `summary` and `details` is correct and in plain English.
- [ ] FDS bends the middle (PIP) joint; FDP bends the fingertip (DIP) joint and is the only muscle that does.
- [ ] FDS tendons split to let FDP pass through.
- [ ] Nerve supply: FDP index and middle = median (anterior interosseous), ring and little = ulnar; FDS = median; interossei = ulnar; thenar mostly median; hypothenar ulnar.
- [ ] Lumbricals start on the FDP tendons and end on the extensor hood.
- [ ] Carpal tunnel: nine tendons (4 FDS, 4 FDP, FPL) plus the median nerve.
- [ ] Bone count: 27 (8 carpals, 5 metacarpals, 14 phalanges).
- [ ] `layer` order (camera sees the back of a typing hand): skin 0, extensor 1, bones and interossei 2, lumbricals, FDP and FPL 3, flexor tendons and FDS 4, thenar and hypothenar 5.
- [ ] The seven `steps` ("what happens when you press a key") are in a sensible order.
- [ ] The skin part carries the "Educational, not medical advice" note; the others are null.
- [ ] `get_pose` mapping in `src/voice/clientTools.ts`: index to pinky pressing -> fdp, fds, flexor-tendons; thumb -> fpl, thenar; lifting -> extensor-digitorum. Is that fair for typing?
