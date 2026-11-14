# X-ray arm (`arm-hand`)

An arm typing on a laptop, explored layer by layer **on the real arm**: skin → superficial muscles → deep
muscles → tendons → nerves and arteries → bones. The parts used in typing glow, and pulse with each keystroke.
Fallback demo (no camera needed): **`/arm-demo`**.

Educational, not medical advice. Anatomy checked by Kash (4th-year medicine).

## Files

| Path | What |
| --- | --- |
| `public/cache/arm-hand/teardown.json` | parts, layers, landmarks, explanations, `activities.typing.roles`, the 6-step tour |
| `public/cache/arm-hand/<mesh>.glb` | fal meshes, normalised (see below); `meshes.json` has their sizes |
| `public/cache/arm-hand/images/` | the fal images each mesh was made from (slide evidence), `choices.json` = which candidate |
| `public/cache/arm-hand/typing-trace.json` | ~10 s of landmarks for replay (**synthetic** until a real one is recorded) |
| `public/cache/arm-hand/preview/` | renders: assembled, exploded, steps 1-6, keystroke pulse, parts sheet |
| `src/biology/arm/` | the code (below) |
| `scripts/arm/` | fal generation, normalising, procedural fallback, synthetic trace, preview rendering |

## Landmark convention

MediaPipe **Pose** (33 landmarks; right arm = shoulder 12, elbow 14, wrist 16; left = 11/13/15) **plus** MediaPipe
**Hand Landmarker** (21 landmarks) for the same video frame, in normalised image coordinates (x, y in 0..1, z as
MediaPipe gives it). Each part spans `from` → `to` in the teardown, e.g. `pose.shoulder>elbow@0.45` = 45 % of the
way from the shoulder to the elbow, `hand.index_mcp`, `hand.wrist>middle_mcp@0.2`.

Every mesh is normalised to **y = 0 (proximal, towards the shoulder) → y = 1 (distal)**, long axis = principal axis
of its vertices, centred on that axis. `src/biology/arm/placement.ts` places each one between landmarks with offsets
in "limb radii": `a` = anterior/palm side (+) vs posterior, `l` = lateral/thumb side (+) vs medial. Forearm parts take
their elbow end from the elbow's directions and their wrist end from the hand's, so **the radius crosses the ulna by
itself when the palm turns down**. Nerves, arteries and tendons are bent along their path round the elbow and wrist.

## `ArmXray` (`src/biology/arm/ArmXrayView.tsx`)

```tsx
<ArmXrayView
  landmarks={frame}          // { t, pose: Landmark[33] | null, hand: Landmark[21] | null, handedness }
  explode={1}                // 0 = on the arm, 1 = layers apart (outer layers towards the viewer, staggered, eased)
  layerFocus={2}             // 1-6: that layer full, outer layers ~10 %, deeper layers dimmed; null = all
  highlight={{ 'forearm-flexors': 0.9 }}   // part id -> glow (typing role intensities)
  activity="typing"
  keystrokes={[{ finger: 'index', kind: 'press', t }]}   // press: flexor slip flashes, tendon slides ~5 mm and back (~150 ms); lift: extensor flash
  frozen={false}             // freeze-frame: the arm stays where it was
/>
```

A transparent canvas over the video, like `src/overlay/Overlay.tsx`; landmarks are smoothed (exponential moving
average). It is plain three.js (the repo has no react-three-fiber).

## Typing detector (`src/biology/arm/detectTyping.ts`)

Pure function over the last ~1.5 s of hand landmarks: typing = **palm facing down** (palm normal from the knuckles)
**and** fingertips tapping relative to their own knuckle at about **2-10 per second** **and** a fairly still wrist.
Returns `{ activity: 'typing' | 'none', confidence, keystrokes, debug }`. Tested on the trace (typing, conf 1.0)
and negatives (still hand, palm up, waving hand: all "none"). Tune `minDip` on the real rig if needed.

## Voice tools (`src/voice/clientTools.ts`)

- **`get_pose`** now also returns **`arm`**: `{ activity, confidence, active_parts: [{ part_id, intensity, role }],
  summary, nerves_involved, clinical_note, tracking, next }` (the existing `hands` field is unchanged).
- **`explode`** with `object_id: "arm-hand"` explodes the arm and makes it active; while active, **`show_step`**,
  **`highlight_part`** and **`reset_view`** drive the arm. Exploding any other object hands the tools back.
- **`show_step(n)`** → `layerFocus = steps[n].layer_focus`, highlights `steps[n].part_ids` + the typing roles on that
  layer, and the camera eases towards that layer (step 6 orbits round to show the radius crossing the ulna).
  Returns the step text, parts (with nerve and safety notes), typing roles, and the clinical note on step 6.
- **`reset_view`** collapses the arm back onto the real arm.

## What Rio needs to do

1. Add **MediaPipe Pose Landmarker** to the detection loop (the app tracks objects and hands only today).
2. Each frame, call `feedArmLandmarks(pose, rightHand.landmarks, 'right')` from `src/biology/arm/trace.ts`
   (or `setArmPose(pose)` from `armLive.ts`; hands already flow in from the store for typing detection).
3. Mount `<ArmXrayView … />` over the video when `useArmStore(s => s.active)` is true, with the store's values
   (see `ArmDemo.tsx` for exactly how).
4. Record a real trace once the rig works (below) so `/arm-demo` replays the real arm.

## What Rohan needs to do (agent prompt)

On "What muscles is this arm using?" (or similar): call **`get_pose`**. If `arm.activity` is `"typing"`, answer from
`arm.active_parts` (forearm flexors and extensors do most of the work; the tendons are the puppet strings), then call
**`explode`** with `object_id: "arm-hand"`, then **`show_step` 1 to 6** in order, saying each step's `text`. End on
the clinical note: tennis elbow (extensor origin, ECRB) and carpal tunnel syndrome (median nerve in the tunnel with
the flexor tendons). Always say "educational, not medical advice". If `arm.activity` is `"none"`, ask them to type
for a moment and call `get_pose` again.

## Record / replay

- **Replay**: `/arm-demo` plays `typing-trace.json` in a loop through the same detector as live tracking.
- **Record** (live feed only): `recordTrace(10)` from `trace.ts` records ~10 s and downloads `typing-trace.json`;
  put it in this folder (replacing the synthetic one) and commit it.
- Regenerate the synthetic trace: `npx tsx scripts/arm/make-trace.ts`.

## How the meshes were made (fal, "Best use of fal")

- Images: `fal-ai/flux-pro/v1.1`, 2 candidates per part, chosen by eye. Prompts describe **shape only**: with words
  like "arm" or "hand", flux drew whole limbs. Thin parts are cropped tight before 3D (fal needs the object to fill
  half the image).
- 3D: `fal-ai/hunyuan-3d/v3.1/pro/image-to-3d` (clearly better than v2 turbo in a side-by-side, and cheaper).
- One structure per mesh, never a whole arm; finger bones, tendons and interossei are generated once and reused
  per finger. Then `scripts/arm/normalise.ts` (principal axis → +Y, proximal at y = 0, simplified, < 1 MB).
- **Procedural fallback** (fal drew it wrong twice): `phalanx-distal`, built in `scripts/arm/procedural.ts`.
  The skin is a translucent sleeve built in code.
- About $13.80 of fal credit for the arm; the ledger is `.cache-live/arm-hand/ledger.json`
  (`npx tsx scripts/arm/generate.ts cost`).
