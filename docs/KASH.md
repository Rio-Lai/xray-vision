# Kash: fal pipeline and biology content

## fal pipeline

- Route: `server/routes/generate-part.ts` (cache checks, dedupe of repeat requests).
- fal calls: `server/lib/fal.ts`. Text to image with `FAL_IMAGE_MODEL` (default `fal-ai/flux/schnell`), then image to 3D with `FAL_3D_MODEL` (default `fal-ai/hunyuan3d/v2/turbo`). `FAL_TEXTURED=1` asks Hunyuan for a textured mesh (about 3x the price and slower).
- Prompts per part are built in `shared/prompts.ts` (`partPrompt`, also used by `npm run pregenerate`). Tune them there.
- The client asks for two parts at a time and skips quietly on failure. It never asks for hand parts: the hand overlay draws from landmarks and ignores `mesh_url`.

### Pre-generation

```bash
npm run pregenerate -- macbook-air-m3-13            # or a path: public/cache/macbook-air-m3-13.json; add --white for untextured
npm run pregenerate -- macbook-air-m3-13 --promote  # after review: compress + copy into public/cache/meshes, set mesh_url
```

- Generate: every part WITHOUT a GLB (in `public/cache/meshes/<id>/` or the review folder) goes through fal, up to 4 at once.
  A part that has a GLB is never paid for twice; to redo one, move its GLB away first. Prints OK/FAIL, seconds and both
  request ids per part, then a table; runs are logged in `.cache-live/review/<id>.runs.json`.
- Output goes to `.cache-live/review/` (gitignored) for a human to check, e.g. `scripts/mesh-sheet.html?object=<id>&review=1`
  (serve the repo root with any static server) or https://gltf-viewer.donmccurdy.com.
- Promote: compresses each GLB (1024 px JPEG textures, quantized geometry: ~3-5 MB -> ~0.8 MB) and edits only the
  `mesh_url` lines of `public/cache/<id>.json`.
- Safety: refuses `"mesh_source": "procedural"` teardowns (the eye) and hand teardowns; after "balance exhausted" it starts
  nothing new and never retries (each retry is another billable job). The `/api/generate-part` route does the same.
- Rejected meshes: `.cache-live/review/rejected/<id>/` (moved out so `--promote` skips them and a re-run regenerates them).

MacBook Air status: all 12 meshes committed. The first prompt ("isolated X from a MacBook Air") drew consumer products
for 7 parts (router, hi-fi speaker, charger...); the "bare internal component" prompt fixed 5 of them, and per-part
visual hints (`LOOKS_LIKE` in `shared/prompts.ts`) fixed the last two. `speakers` is passable (a slim module with a
driver, but hollow); to redo it, move its GLB out of public/cache/meshes and the review folder and re-run (~$0.45).

### The eye (procedural, not fal 3D)

```bash
npm run build-eye
```

`scripts/build-eye.ts` builds each eye part from code with real adult proportions (right eye; +z anterior, +y superior,
+x nasal; eyeball = 1.0 across) into `public/cache/meshes/eye/<part>.glb`. fal makes only the 2D textures
(`scripts/eye/textures.ts`: iris with flux/dev, retinal fundus with flux-pro), cached in `public/cache/eye/textures/`
and never regenerated unless deleted. `scripts/eye/texture-prep.ts` maps them onto the meshes (iris rubber-sheet
unwrap, fundus mirrored to a right eye and re-projected with the fovea at the posterior pole and the disc 15 degrees nasal).
If a raw texture is regenerated, re-measure the pixel positions at the top of that file.
Previews: `public/cache/eye/preview/*.png`; interactive: `scripts/eye/preview.html` (E explode, C cut).

## Cache layout

```
public/cache/<object_id>.json                   checked teardowns (committed)
public/cache/meshes/<object_id>/<part_id>.glb   checked meshes (committed)
public/cache/eye/                               eye textures (fal) and preview renders
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
