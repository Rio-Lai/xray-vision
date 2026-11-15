# Blowfish interface kit (Figma Make)

Everything the wearer sees on top of the camera image, designed and built as a component kit in Figma Make. Issue #85. The code is moved into the app in issue #86; until that merges, the app still uses its own stylesheets (`src/hud/styles.ts`, `src/voice/voiceStyles.ts`).

- **Make file:** "Blowfish — interface kit", https://www.figma.com/make/ELqI9Zkp1eBvkYn7hOwlIR/ (Rio's Figma account; not published or shared).
- **Made:** Saturday 14 November 2026, evening, about 22:20 to 22:47 GMT. Five prompts: a first build (checkpoint 22:27), two design review rounds (22:34, 22:38), a fix to the object label positions in the page data (22:45) and a fix that untangles crossing leader lines (22:46). Each round was reviewed from screenshots of every state, including crops at true 1080p size.
- **This folder is docs only.** Nothing in the app imports it, so CI is unaffected.

## Files

| File | What it is |
| --- | --- |
| `tokens.css` | Every colour, type size, weight, spacing, radius, blur, shadow, size and timing as a `--bf-` CSS variable (108 tokens). |
| `hud.css` | All component styles. Class names start with `bf-`; values come from the tokens. |
| `components.tsx` | The components: plain React and TypeScript, inline SVG only. Imports `tokens.css` and `hud.css`. |
| `layout.ts` | `layoutPartLabels(anchors)`: puts part labels in two columns, sorted by height, then swaps label slots until no two leader lines in a column cross. |
| `index.ts` | Re-exports the components, types and layout helper. |
| `screenshots/` | Three states at true 1080p, captured from the Make preview (each image is two halves of the 1920 x 1080 view, scaled to 1600 x 900): overlay on, step card, hand and arm. |
| `page/App.tsx` | The showcase page around the kit (glasses frame, state switcher, components sheet, tokens sheet). Reference only: it shows how each state is composed and where the labels sit. Its own stylesheet (`src/index.css` in Make, 847 lines of frame, switcher and sheet styles) is not copied. |

In Make the kit lives at `src/kit/` and the page at `src/App.tsx`. The six code files here are **exactly as Make produced them**: they were read from the Make preview's dev server and checked byte for byte with SHA-256 against the source in Make. **No hand edits.**

Checked: no Tailwind classes, no icon or font packages, no `@import` and no external URLs inside the kit. The only external URL is the backdrop photo in `page/App.tsx` (`BACKDROP_SRC`, a stock photo from Unsplash by Jakub Żerdzicki: a desk with an open laptop, a phone, a pen and a notebook, no people and no visible logos). Rio will replace it with his own photo.

## Components

| Component | Props | Notes |
| --- | --- | --- |
| `LabelPill` | `state`: `quiet`, `focused`, `highlight`, `active` | The one label anatomy used everywhere: 40 px pill, 17 px text. |
| `ObjectLabel` | `name`, `point`, `state` (`quiet` or `focused`), `pillPosition` (`above` or `below`) | Dot on the object, 28 px stem, pill. |
| `FocusGlow` | `x`, `y`, `width`, `height` | Very soft accent glow around the focused object. No outline. |
| `PartLabel` | `name`, `anchor`, `label`, `side`, `state` (`quiet`, `highlight`, `active`) | Leader line: anchor dot, elbow 32 px before the pill, stops 6 px short of the pill. `active` is the warm muscle state. |
| `layoutPartLabels` | list of `{ name, anchor, state? }` | Left column right-aligned at x 600, right column left-aligned at x 1320, 64 px pitch, sorted by anchor height, then an untangle pass (at most 50 swaps) so lines do not cross. |
| `TitlePill` | `aiEstimated` | Top centre. The "AI-estimated" chip is neutral grey. |
| `PartCard` | `kicker`, `name`, `summary`, `safety` | Bottom left, 460 px wide. Safety note in warm with an inline SVG warning glyph. |
| `StepCard` | `kicker`, `step`, `total`, children | Bottom right, 430 px wide, segmented progress line. |
| `GestureHint` | children | One quiet line under the model. |
| `StatusPill` | `variant`: `looking`, `info`, `error` | Above the voice zone. Looking has a static accent dot; error a coral dot. |
| `VoicePill` | `state`: `off`, `connecting`, `listening`, `thinking`, `speaking`, `hold` | Bottom centre. |
| `Captions` | `wearer`, `blowfish` | Both lines on one shared soft backing, above the voice pill. |
| `StageScrim` | | Dims (brightness 0.5), blurs (16 px) and desaturates the camera image behind the model. |
| `ModelPlaceholder` | `batteryHighlighted` | Stand-in for the 3D model in the Make page: an exploded stack of glass layers. The app has the real three.js model. |
| `HandPlaceholder` | | Stand-in for the hand and forearm model, with the warm extensor band. |

Positions are in stage pixels of a 1920 x 1080 view. The page renders a fixed 1920 x 1080 stage and scales it to fit, so every size in the kit is a true 1080p size.

## States on the Make page

The page shows the glasses view at 16:9 with a state switcher (buttons, keys 1 to 9, URL hash `#1` to `#9`), a "Show safe zones" toggle (the middle 60% and the bottom-centre 760 x 120 voice zone), an "AI-estimated chip" toggle in state 4, a replay button in state 3 and a voice-state row in state 8. Below the view are a components sheet (every component and variant on a blurred camera strip) and a tokens sheet (colour swatches, radius, elevation, type, spacing, motion).

1. **Clean view:** only the voice pill ("Listening").
2. **Overlay on:** focused "MacBook Air 13-inch" with a focus glow on the laptop; quiet "Phone", "Pen", "Notebook".
3. **Looking:** "Looking…" status pill, cross-fading after 1.2 s to the laptop's focused label.
4. **Model on stage:** scrim, title pill (optional "AI-estimated" chip), the exploded model, six part labels in two columns, gesture hint "Pinch to turn it. Pull your hands apart to open it."
5. **Part selected:** "Battery" highlighted (accent line, dot and outline) and the part card: "Part 7 of 12", "Battery", two-sentence summary, two-sentence safety note.
6. **Step card:** state 5 plus "Step 4 of 7": "Disconnect the battery from the logic board before touching anything else." (The MacBook battery procedure in `public/cache/macbook-air-m3-13.json` has 7 steps.)
7. **Hand and arm:** title "Hand and finger muscles", hand placeholder, "Extensor digitorum" active in warm, quiet "Flexor digitorum superficialis (FDS)", "Flexor digitorum profundus (FDP)", "Interossei", "Thenar muscles", caption "Extensor digitorum lifts your finger off the key."
8. **Voice:** the voice pill in any of its six states, with the wearer's caption "Tell me about the battery." and Blowfish's "This is the battery. It sits under the palm rest."
9. **Error:** "Blowfish server is not running. Start it with npm run dev."

Content comes from the checked parts lists (`public/cache/macbook-air-m3-13.json`, `public/cache/hand-finger-muscles.json`). The battery card's second summary sentence ("It is held in place by stretch-release adhesive tabs.") is taken from step 5 of the same file.

## Tokens

All values are in `tokens.css`; this is the summary.

| Group | Tokens |
| --- | --- |
| Text | `--bf-color-text` white 96%, `-text-quiet` 85%, `-text-muted` 62%, `-caption-user` 78%, `-white` #fff |
| Glass | `--bf-color-glass` rgba(22,25,30,.64), `-glass-quiet` rgba(36,39,44,.5), `-glass-strong` rgba(16,19,24,.78), `-glass-soft` white 10%; `--bf-blur-glass` 22px, `--bf-saturate-glass` 135% |
| Borders and lines | `--bf-color-border` white 22%, `-border-quiet` white 14%, `-line` white 68%, `-line-strong` white 75%, `-dot-ring` black 62%; `--bf-border-width` 1px, `-focus` 1.5px |
| Accent (focus, highlight) | `--bf-color-accent` #4DA3FF, `-accent-soft` 28%, `-focus-glow` 18% |
| Warm (safety, active muscles) | `--bf-color-warm` #FF9F45, `-warm-soft` 20% |
| Error | `--bf-color-coral` #FF7A6B |
| Scrim and captions | `--bf-color-scrim` .45, `-scrim-center` .38, `-scrim-edge` .14, `-caption-backing` rgba(12,13,15,.55), `-caption-gradient` .8; `--bf-stage-brightness` 0.5, `--bf-stage-saturation` 0.8, `--bf-blur-stage` 16px, `--bf-blur-caption` 16px |
| Type | `--bf-font-family` system-ui, -apple-system, "SF Pro Text", Inter, sans-serif; sizes: kicker 16, label 17, caption 18, error 18, body 19, title 20, caption reply 20, card name 24 px; weights 400, 500, 600; line heights 1.2, 1.45 |
| Spacing (4 px grid) | `--bf-space-1` 4, `-2` 8, `-3` 12, `-4` 16, `-6` 24, `-8` 32, `-12` 48 px; `--bf-edge` 32px |
| Radius (one scale) | `--bf-radius-small` 12, `-caption` 16, `-card` 22, `-focus` 28, `-pill` 999 px |
| Elevation (one scale) | `--bf-shadow-1` 0 4px 16px .2, `-2` 0 10px 32px .28, `-3` 0 24px 64px .42; plus `-leader`, `-dot-ring`, `-dot-accent`, `-dot-warm` |
| Sizes | pill height 40, dot 8, stem 28, card 460, step card 430, voice zone 760 x 120, status pill 148 from the bottom, voice pill min width 148, icon 18, caption max 720, error max 760, leader elbow 32, leader gap 6, model 720 x 550, hand 720 x 620, stage 1920 x 1080 |
| Motion | `--bf-duration-fast` 200ms, `-normal` 240ms, `-slow` 1200ms (spinner, thinking dots, waveform); `--bf-easing-out` cubic-bezier(0.16, 1, 0.3, 1), `--bf-easing-gentle` ease-in-out; enter = fade and 4 px rise; `prefers-reduced-motion` turns animation off |

## What changed compared with the app's current look

Compared with `src/hud/styles.ts` and `src/voice/voiceStyles.ts` on `main` at the time of writing:

| | App today | Kit |
| --- | --- | --- |
| Glass | White at 14% over a darkened blur (`brightness(0.84)`), border white 24% | A neutral smoke tint (three strengths: quiet, normal, strong), blur 22 px, border white 22% or 14%. White text holds its contrast over a bright white desk. This deliberately departs from "white at ~14%" in `docs/PROJECT.md` section 2, for legibility. |
| Pill sizes | 34 px labels, 36 px title and voice pill, 38 px highlighted part label | One pill height, 40 px, for every pill |
| Label text | 16 px (17 px highlighted) | 17 px everywhere; focused, highlighted and active labels in 600 weight |
| Quiet vs focused | Focus is brighter white glass with a 4 px blue halo | Quiet: lighter glass, 85% text, white dot. Focused: strong glass, thin accent outline, accent dot with a ring, plus `FocusGlow` on the object |
| Radius | 999, 20, 14, 10 px used ad hoc | One scale: 12, 16, 22, 28, 999 px |
| Shadows | Four different ad hoc shadows | Three elevation levels |
| Spacing | 15, 18, 22, 28 px and a 150 px status offset | 4 px grid, 32 px edge margin |
| Part labels | Leader lines from `src/overlay/labels.ts` with collision avoidance | Two-column layout (`layoutPartLabels`) with an untangle pass so lines do not cross; elbow lines that stop short of the pill; a faint dark shadow on lines for bright backgrounds |
| Part card | Name 20 px, body 18 px, up to 420 px wide, safety note with an amber dot | Name 24 px, body 19 px, 460 px wide, 24 px padding, safety note with a warning glyph and a hairline divider |
| Step card | Kicker and sentence | Kicker, segmented progress line ("Step 4 of 7"), sentence |
| "AI-estimated" chip | Warm amber | Neutral grey (warm is kept for safety and active muscles only) |
| Status pill | The busy dot pulses (`bf-breathe`) | "Looking…" has a static accent dot; nothing pulses |
| Voice pill | 36 px; the listening dot pulses | 40 px; listening is a static accent dot with a halo; a small spinner for connecting; a mic glyph for hold to talk. Thinking dots and the speaking waveform still move gently (1.2 s cycle) |
| Captions | One dark box per line (black 38%), up to 3 lines each | Both lines on one shared backing (rgba(12,13,15,.55), blur 16 px); wearer 18 px at 78%, Blowfish 20 px medium |
| Model backdrop | Dimmed in the stage code | `StageScrim`: brightness 0.5, blur 16 px, saturation 0.8, radial darkening behind the middle |

## Notes for the move into the app (#86)

- The kit works in stage pixels of a 1920 x 1080 view (`PartLabel` draws its line in an SVG with `viewBox="0 0 1920 1080"`). The app's overlay fills the window, so either wrap the overlay in a 1920 x 1080 stage scaled to the window (as `page/App.tsx` does) or pass window pixels and change the SVG viewBox.
- `Captions` sets `white-space: nowrap`, so a long tutor reply will overflow; the app's captions need wrapping or a line clamp.
- The enter animation moves `margin-top`, because `transform` is already used for positioning.
- `PartLabel` and `layout.ts` repeat the elbow (32) and gap (6) as numbers in code next to the `--bf-size-leader-elbow` and `--bf-size-leader-gap` tokens; `.bf-gesture-hint` uses `top: 76%`.
- The SVG gradient ids in the placeholders are global; render each placeholder once.
- `ModelPlaceholder` and `HandPlaceholder` are for the design page; the app has real models.
