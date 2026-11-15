# Interface kit in the app (#86)

The app's overlay uses the interface kit built in Figma Make (#85). Make's output is kept exactly as produced in [`docs/design/make-interface-kit/`](../../../docs/design/make-interface-kit/) (the evidence); this folder is the adapted copy the app runs on.

| File | From the kit | Used by |
| --- | --- | --- |
| `tokens.ts` | `tokens.css`, as a string (`KIT_TOKENS_CSS`), plus the kit's keyframes (`KIT_KEYFRAMES_CSS`) | both stylesheets below |
| `hud.ts` | `hud.css`: glass, label pill, title pill, cards, progress line, gesture hint, status pill; plus kit-styled rules for the app's own label-layer classes | `src/hud/styles.ts` (`HUD_CSS`), injected by `Hud.tsx` |
| `voice.ts` | `hud.css`: voice pill, spinner, thinking dots, waveform, mic, captions, mapped onto the existing voice classes | `src/voice/voiceStyles.ts` (`VOICE_CSS`), injected by `VoiceBar.tsx` |

The stylesheets are injected with a `<style>` tag, as before (no CSS imports), so `?look=classic` (`src/hud/look.ts`) can bring back the previous stylesheets (`CLASSIC_HUD_CSS`, `CLASSIC_VOICE_CSS`, unchanged) and the previous HUD markup. The debug panel (`D`) shows which look is active.

## What moved

- **Tokens:** all of `tokens.css`, values unchanged except two (below: quiet glass and the focus glow). Every colour, size, radius, blur, shadow and timing in `hud.ts` and `voice.ts` is a `--bf-*` variable, except the hand marker's 14 px size (not in the kit) and the debug panel.
- **Markup and classes from `components.tsx`** (in `src/hud/Hud.tsx`): `TitlePill` (one pill, the neutral "AI-estimated" chip inside it), `PartCard` (kicker "Part N of M", name, summary, safety note with the inline warning glyph and hairline divider), `StepCard` (kicker, segmented progress line, sentence), `StatusPill` (looking / error variants, static dots).
- **Label pills:** the pills drawn by `src/overlay/labels.ts` and `objectLabels.ts` carry `bf-label-pill` and the kit's state classes (`--focused`, `--highlight`); dots, stems, leader lines and the focus glow are styled to the kit's anatomy.
- **Leader lines:** the kit's `PartLabel` shape: from the anchor dot to an elbow 32 px before the pill, then level, stopping 6 px short of the pill (`leaderPath` in `labels.ts`).
- **Object labels:** the kit's 28 px stem and 8 px gap to the pill (`STEM_PX`, `DOT_GAP_PX` in `objectLabels.ts`).
- **Voice pill and captions:** CSS only, no markup change in `VoiceBar.tsx`.

## Adaptations (what differs from Make's output, and why)

1. **Quiet labels are denser** (decision 3 on #86: readable over a bright desk). `--bf-color-glass-quiet` is `rgba(20, 23, 28, 0.66)` (Make: `rgba(36, 39, 44, 0.5)`); quiet label text uses the new `--bf-color-text-label-quiet` (white 92%, Make used `--bf-color-text-quiet`, 85%) at weight 500 (`--bf-font-weight-label-quiet`; Make: 400). Focused and highlighted labels stay louder: strong glass, accent outline, 600 weight, white 96%.
2. **No scrim.** The dim and blur behind the model stay the app's own light ones (`src/camera/Camera.tsx`, unchanged), not `StageScrim` (decision 2: what Rio sees should be what he normally sees). The `--bf-color-scrim*` and `--bf-stage-*` tokens are kept but unused.
3. **Sizes in window pixels, 1:1.** The kit is drawn in 1920 x 1080 stage pixels; the app uses those numbers as CSS pixels and never scales them down, so text stays at least 16 px (labels) and 18 px (body) at any window size (decision 4). Only the cards narrow on small windows: `min(460px, 30vw)` and `min(430px, 28vw)`, at least 280 px (new tokens `--bf-size-card-max-vw`, `--bf-size-step-max-vw`, `--bf-size-card-min`). The overlay is not wrapped in a scaled 1920 x 1080 stage: the label layers place things in window pixels every frame, as before.
4. **Safety note at 18 px** (`--bf-font-size-safety`), because it is body text; Make used the 17 px label size.
5. **Status pill wraps** long errors (up to `min(80vw, 760px)`, centred), as the app did before; Make's is one line. Developer warnings keep a warm dot (`bf-status-pill--warn`); the kit has no warning variant.
6. **Captions wrap** (up to three lines each, as before); Make's are `nowrap`. They sit on one shared backing as in the kit, and the backing fades out with the last caption (CSS `:has()`). The enter animation uses `backwards` fill, so the existing 600 ms fade-out (`.fading`, `CAPTION_FADE_MS`) is visible.
7. **Voice pill 24 px from the bottom** (`--bf-size-voice-bottom`), as before; the kit's voice zone puts it 8 px from the edge, which the glasses may cut off.
8. **No per-frame filters.** Make blurs the focus glow with `filter: blur()` and puts a `drop-shadow` filter on every leader line. The app moves and resizes these every frame, so: the focus glow is a soft fill with a same-coloured `box-shadow`; the object label stem gets the line shadow as a `box-shadow` (`--bf-shadow-line`); part leader lines have no shadow. The speaking waveform animates `transform: scaleY` instead of `height` (no layout per frame).
9. **Highlighted part dot:** an SVG circle with the accent ring drawn as a stroke under the fill (`paint-order: stroke`), standing in for the kit's `--bf-shadow-dot-accent` on an HTML dot.
10. **Hold-to-talk mic glyph** is the kit's SVG used as a CSS mask on the existing dot, so the voice markup stays the same; the connecting spinner is the same dot drawn as the kit's ring spinner.
11. **Enter animations:** HUD pieces use the kit's `bf-enter` (fade and 4 px rise via `margin-top`); object labels, which are shown and hidden by a class every frame, use a transition with the same timing and rise.
12. **Focus glow is fainter.** `--bf-color-focus-glow` is `rgba(77, 163, 255, 0.07)` (Make: `0.18`). At 0.18 the whole focused object takes a blue cast (visible on the laptop in the kit's "overlay on" screenshot); the brief is that the wearer sees things as they normally look, so the glow only hints at which thing is "this".

## Not taken from the kit

- `layout.ts` (`layoutPartLabels`): the app keeps its own part label layout (two columns beside the model, stacked so labels never overlap each other or the cards, bottom 150 px kept clear). Same layout rules as before.
- `ObjectLabel` / `PartLabel` / `FocusGlow` React components: the app draws these imperatively every frame (no React), with the kit's classes and anatomy.
- `GestureHint`: shown since #121 while a hand gesture does something (one word: Turning, Opening, Closing, Zooming, Moving), placed just above the voice zone (`.bf-cue-hint`) rather than at 76% of the height, so it never sits on the captions.
- `PartLabel` `active` (warm muscle) state: the label layers have only quiet and highlighted; `.bf-label-pill--active` is in `hud.ts` but nothing sets it yet.
- `StageScrim`, `ModelPlaceholder`, `HandPlaceholder`: the app has the real camera dim and the real three.js models.
- The Make page (`page/App.tsx`) and its own stylesheet.
