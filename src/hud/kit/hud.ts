/**
 * Component styles of the Figma Make interface kit (#85, #86), adapted to the app's DOM.
 * Source: docs/design/make-interface-kit/hud.css (unchanged there). Values come from the kit's
 * --bf-* tokens (./tokens.ts). Every difference from Make's hud.css is listed in ./README.md.
 *
 * Two kinds of rules:
 *  - the kit's own classes, rendered by Hud.tsx in the kit look: .bf-glass, .bf-enter,
 *    .bf-title-pill, .bf-card, .bf-part-card, .bf-step-card, .bf-progress, .bf-status-pill,
 *    .bf-pill-dot, and .bf-label-pill (also added to the pills of the label layers);
 *  - the app's own classes for what src/overlay/ draws imperatively every frame (object labels,
 *    part labels and leader lines, focus glow, hand markers), styled to the kit's anatomy. Their
 *    positioning rules are the same as in the classic stylesheet, so the layers behave the same.
 * Assembled with the tokens, keyframes and the debug panel styles in ../styles.ts.
 */
export const KIT_HUD_CSS = `
.bf-hud, .bf-olayer, .bf-player { position: absolute; inset: var(--bf-space-0); pointer-events: none; overflow: hidden; }
.bf-hud, .bf-olayer, .bf-player, .bf-hud * { font-family: var(--bf-font-family); -webkit-font-smoothing: antialiased; }
.bf-hud { color: var(--bf-color-text); font-size: var(--bf-font-size-body); line-height: var(--bf-line-height-body); }

/* Enter: fade and a 4 px rise. margin-top, because transform positions things. */
.bf-enter { animation: bf-rise var(--bf-duration-normal) var(--bf-easing-out) both; }

/* Smoke glass */
.bf-glass { background: var(--bf-color-glass); border: var(--bf-border-width) solid var(--bf-color-border); box-shadow: var(--bf-shadow-1);
  -webkit-backdrop-filter: blur(var(--bf-blur-glass)) saturate(var(--bf-saturate-glass));
  backdrop-filter: blur(var(--bf-blur-glass)) saturate(var(--bf-saturate-glass)); }

/* One pill anatomy: 40 px, radius 999 */
.bf-label-pill, .bf-title-pill, .bf-status-pill { box-sizing: border-box; min-height: var(--bf-size-pill-height);
  border-radius: var(--bf-radius-pill); display: inline-flex; align-items: center; gap: var(--bf-space-3); white-space: nowrap; }

/* Label pill: quiet (default), focused, highlight, active. Quiet is denser than Make's (README). */
.bf-label-pill { padding: var(--bf-space-2) var(--bf-space-4); font-size: var(--bf-font-size-label); line-height: var(--bf-line-height-tight);
  font-weight: var(--bf-font-weight-label-quiet); color: var(--bf-color-text-label-quiet); background: var(--bf-color-glass-quiet);
  border: var(--bf-border-width) solid var(--bf-color-border-quiet); box-shadow: var(--bf-shadow-1);
  -webkit-backdrop-filter: blur(var(--bf-blur-glass)) saturate(var(--bf-saturate-glass));
  backdrop-filter: blur(var(--bf-blur-glass)) saturate(var(--bf-saturate-glass)); }
.bf-label-pill--focused, .bf-label-pill--highlight { color: var(--bf-color-text); background: var(--bf-color-glass-strong);
  border-color: var(--bf-color-accent); font-weight: var(--bf-font-weight-semibold); }
.bf-label-pill--active { border-color: var(--bf-color-warm); background: var(--bf-color-glass-strong);
  font-weight: var(--bf-font-weight-semibold); }

.bf-pill-dot { width: var(--bf-size-dot); height: var(--bf-size-dot); flex: 0 0 var(--bf-size-dot); border-radius: var(--bf-radius-pill);
  background: var(--bf-color-white); }
.bf-pill-dot--accent { background: var(--bf-color-accent); box-shadow: var(--bf-shadow-dot-accent); }

/* ---- object labels (overlay on): dot on the object, stem, pill. Drawn by src/overlay/objectLabels.ts. ---- */
.bf-olabel { position: absolute; left: 0; top: 0; width: 0; height: 0; will-change: transform; }
.bf-olabel-in { position: absolute; left: 0; top: 0; opacity: 0; transform: translateY(var(--bf-rise-distance));
  transition: opacity var(--bf-duration-normal) var(--bf-easing-out), transform var(--bf-duration-normal) var(--bf-easing-out); }
.bf-olabel-in.on { opacity: 1; transform: translateY(var(--bf-space-0)); }
.bf-olabel-dot { position: absolute; left: calc(var(--bf-size-dot) / -2); top: calc(var(--bf-size-dot) / -2);
  width: var(--bf-size-dot); height: var(--bf-size-dot); border-radius: var(--bf-radius-pill);
  background: var(--bf-color-white); box-shadow: var(--bf-shadow-dot-ring); }
.bf-olabel-in.focus .bf-olabel-dot { background: var(--bf-color-accent); box-shadow: var(--bf-shadow-dot-accent); }
.bf-olabel-stem { position: absolute; left: -0.5px; bottom: calc(var(--bf-size-dot) / 2); width: var(--bf-border-width);
  background: var(--bf-color-line); box-shadow: var(--bf-shadow-line); }
.bf-olabel-in.below .bf-olabel-stem { bottom: auto; top: calc(var(--bf-size-dot) / 2); }
.bf-olabel-pill { position: absolute; left: 0; }

/* Focus glow: a very soft accent glow on the focused thing, no outline. Make blurs it with filter: blur();
   here the same softness comes from a box-shadow, because its box moves and resizes every frame. */
.bf-focusglow { position: absolute; left: 0; top: 0; border-radius: var(--bf-radius-focus); opacity: 0;
  background: var(--bf-color-focus-glow);
  box-shadow: 0 0 var(--bf-blur-focus-outer) var(--bf-blur-focus-inner) var(--bf-color-focus-glow);
  transition: opacity var(--bf-duration-normal) var(--bf-easing-out); }
.bf-focusglow.on { opacity: 1; }

/* ---- the hand cue (#121, src/overlay/pinchDots.ts; not in the kit): a small ring at each free raised
   hand's palm, filled while it does something ---- */
.bf-hand-mark { position: absolute; left: 0; top: 0; width: 14px; height: 14px; margin: -7px 0 0 -7px; box-sizing: border-box;
  border-radius: var(--bf-radius-pill); border: var(--bf-border-width-focus) solid var(--bf-color-line-strong); background: transparent;
  box-shadow: var(--bf-shadow-dot-ring); opacity: 0; will-change: transform, opacity;
  transition: opacity var(--bf-duration-fast) var(--bf-easing-out), background-color var(--bf-duration-fast) var(--bf-easing-out); }
.bf-hand-mark.on { opacity: 0.8; }
.bf-hand-mark.active { background: var(--bf-color-white); }
/* the word under the ring (pinchDots.ts): what that hand is doing */
.bf-hand-label { position: absolute; left: 50%; top: 22px; transform: translateX(-50%); padding: 2px 8px; white-space: nowrap;
  border-radius: var(--bf-radius-pill); background: var(--bf-color-glass-strong); color: var(--bf-color-text);
  font-size: 12px; font-weight: var(--bf-font-weight-medium); line-height: 1.3; text-shadow: var(--bf-shadow-1);
  opacity: 0; transition: opacity var(--bf-duration-fast) var(--bf-easing-out); pointer-events: none; }
.bf-hand-label.on { opacity: 1; }

/* ---- part labels (model on stage): pill, elbow leader line, dot. Drawn by src/overlay/labels.ts. ---- */
.bf-plabel { position: absolute; left: 0; top: 0; will-change: transform, opacity; }
.bf-plabel-line { fill: none; stroke: var(--bf-color-line-strong); stroke-width: var(--bf-border-width-focus); }
.bf-plabel-line.hl { stroke: var(--bf-color-accent); }
.bf-plabel-dot { fill: var(--bf-color-white); stroke: var(--bf-color-dot-ring); stroke-width: 1; }
/* highlighted dot: accent with a soft accent ring (the kit's --bf-shadow-dot-accent, drawn as a stroke under the fill) */
.bf-plabel-dot.hl { fill: var(--bf-color-accent); stroke: var(--bf-color-accent-soft); stroke-width: 10; paint-order: stroke; }

/* ---- title pill (top centre), with the neutral "AI-estimated" chip ---- */
.bf-title-pill { position: absolute; top: var(--bf-edge); left: 50%; transform: translateX(-50%);
  padding: var(--bf-space-2) var(--bf-space-4); font-size: var(--bf-font-size-title); line-height: var(--bf-line-height-tight);
  font-weight: var(--bf-font-weight-medium); }
.bf-title-pill__chip { padding: var(--bf-space-1) var(--bf-space-2); color: var(--bf-color-text-muted); background: var(--bf-color-glass-soft);
  border-radius: var(--bf-radius-pill); font-size: var(--bf-font-size-kicker); font-weight: var(--bf-font-weight-regular); }

/* ---- cards ---- */
.bf-card { position: absolute; box-sizing: border-box; padding: var(--bf-space-6); border-radius: var(--bf-radius-card);
  background: var(--bf-color-glass-strong); border: var(--bf-border-width) solid var(--bf-color-border); box-shadow: var(--bf-shadow-2);
  -webkit-backdrop-filter: blur(var(--bf-blur-glass)) saturate(var(--bf-saturate-glass));
  backdrop-filter: blur(var(--bf-blur-glass)) saturate(var(--bf-saturate-glass)); }
.bf-part-card { left: var(--bf-edge); bottom: var(--bf-edge); width: min(var(--bf-size-card-width), var(--bf-size-card-max-vw));
  min-width: var(--bf-size-card-min); }
.bf-step-card { right: var(--bf-edge); bottom: var(--bf-edge); width: min(var(--bf-size-step-width), var(--bf-size-step-max-vw));
  min-width: var(--bf-size-card-min); }
.bf-card__kicker { margin: var(--bf-space-0) var(--bf-space-0) var(--bf-space-2); color: var(--bf-color-text-muted);
  font-size: var(--bf-font-size-kicker); line-height: var(--bf-line-height-tight); font-weight: var(--bf-font-weight-medium); }
.bf-card__name { margin: var(--bf-space-0) var(--bf-space-0) var(--bf-space-3); font-size: var(--bf-font-size-card-name);
  line-height: var(--bf-line-height-tight); font-weight: var(--bf-font-weight-semibold); }
.bf-card__body { margin: var(--bf-space-0); color: var(--bf-color-text-quiet); font-size: var(--bf-font-size-body); line-height: var(--bf-line-height-body); }
.bf-card__safety { display: flex; gap: var(--bf-space-3); margin: var(--bf-space-4) var(--bf-space-0) var(--bf-space-0);
  padding-top: var(--bf-space-4); border-top: var(--bf-border-width) solid var(--bf-color-border-quiet); color: var(--bf-color-warm);
  font-size: var(--bf-font-size-safety); line-height: var(--bf-line-height-body); }
.bf-card__safety svg { width: var(--bf-size-icon); height: var(--bf-size-icon); flex: 0 0 var(--bf-size-icon); margin-top: var(--bf-space-1); }
.bf-progress { display: flex; gap: var(--bf-space-1); margin: var(--bf-space-3) var(--bf-space-0) var(--bf-space-4); }
.bf-progress__segment { height: var(--bf-space-1); flex: 1; border-radius: var(--bf-radius-pill); background: var(--bf-color-glass-soft); }
.bf-progress__segment--active { background: var(--bf-color-accent); }

/* ---- gesture hint (the kit's GestureHint). The app shows it while a hand gesture does something (#121,
   .bf-cue-hint, src/overlay/pinchDots.ts): just above the voice zone instead of at 76%, fading. ---- */
.bf-gesture-hint { position: absolute; left: 50%; top: 76%; transform: translateX(-50%); margin: var(--bf-space-0);
  color: var(--bf-color-text-quiet); font-size: var(--bf-font-size-body); white-space: nowrap; text-shadow: var(--bf-shadow-1); }
.bf-gesture-hint.bf-cue-hint { top: auto; opacity: 0;
  transition: opacity var(--bf-duration-fast) var(--bf-easing-out), bottom var(--bf-duration-fast) var(--bf-easing-out); }
.bf-gesture-hint.bf-cue-hint.on { opacity: 1; }

/* ---- the one status pill, above the voice zone. Wraps long errors (Make: one line). ---- */
.bf-status-pill { position: absolute; left: 50%; bottom: var(--bf-size-status-offset); transform: translateX(-50%);
  width: max-content; max-width: min(80vw, var(--bf-size-error-max)); padding: var(--bf-space-2) var(--bf-space-4);
  font-size: var(--bf-font-size-label); line-height: var(--bf-line-height-tight); white-space: normal; text-align: center; }
.bf-status-pill--looking .bf-pill-dot { background: var(--bf-color-accent); box-shadow: var(--bf-shadow-dot-accent); }
.bf-status-pill--error .bf-pill-dot { background: var(--bf-color-coral); }
.bf-status-pill--error { font-size: var(--bf-font-size-error); }
/* app addition: developer warnings keep their warm dot */
.bf-status-pill--warn .bf-pill-dot { background: var(--bf-color-warm); }

@media (prefers-reduced-motion: reduce) {
  .bf-enter { animation: none; }
}
`;
