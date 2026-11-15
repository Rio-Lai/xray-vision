/**
 * The voice pill and captions in the Figma Make interface kit look (#86), as CSS for the existing
 * markup of src/voice/VoiceBar.tsx (person2's): no markup change. Source: the kit's .bf-voice-zone,
 * .bf-voice-pill, .bf-spinner, .bf-thinking, .bf-waveform, .bf-mic and .bf-captions rules in
 * docs/design/make-interface-kit/hud.css, mapped onto the app's .bf-voice / .bf-vpill / .bf-vcap
 * classes. Differences from Make's rules are listed in ./README.md. Selected in
 * src/voice/voiceStyles.ts (VOICE_CSS); `?look=classic` keeps the previous voice stylesheet.
 */
import { KIT_KEYFRAMES_CSS, KIT_TOKENS_CSS } from './tokens';

/** The kit's microphone glyph (VoiceIcon "hold"), as a mask so the markup stays the same. */
const MIC_MASK =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='none' stroke='black' stroke-width='1.5' stroke-linecap='round'%3E%3Crect x='7' y='2.5' width='6' height='10' rx='3'/%3E%3Cpath d='M4.8 9.8a5.2 5.2 0 0 0 10.4 0M10 15v2.5M7.2 17.5h5.6'/%3E%3C/svg%3E\") center / contain no-repeat";

const KIT_VOICE_RULES = `
/* The voice zone: bottom centre, the pill at the bottom, captions above it. */
.bf-voice { position: fixed; left: 50%; bottom: var(--bf-size-voice-bottom); transform: translateX(-50%); z-index: 50;
  display: flex; flex-direction: column; align-items: center; gap: var(--bf-space-2); width: min(var(--bf-size-voice-zone-width), 92vw);
  pointer-events: none; font-family: var(--bf-font-family); -webkit-font-smoothing: antialiased; color: var(--bf-color-text); }

.bf-vglass { background: var(--bf-color-glass); border: var(--bf-border-width) solid var(--bf-color-border); box-shadow: var(--bf-shadow-1);
  -webkit-backdrop-filter: blur(var(--bf-blur-glass)) saturate(var(--bf-saturate-glass));
  backdrop-filter: blur(var(--bf-blur-glass)) saturate(var(--bf-saturate-glass)); }

/* ---- the pill (.bf-voice-pill) ---- */
.bf-vpill { pointer-events: auto; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: var(--bf-space-3);
  min-height: var(--bf-size-pill-height); min-width: var(--bf-size-voice-pill-min); padding: var(--bf-space-2) var(--bf-space-4);
  border-radius: var(--bf-radius-pill); color: var(--bf-color-text); font: inherit; font-size: var(--bf-font-size-label);
  font-weight: var(--bf-font-weight-regular); line-height: var(--bf-line-height-tight); white-space: nowrap; cursor: pointer;
  transition: color var(--bf-duration-fast) var(--bf-easing-out); }
.bf-vpill:focus { outline: none; }
.bf-vpill:focus-visible { box-shadow: var(--bf-shadow-1), 0 0 0 3px var(--bf-color-accent-soft); }
.bf-vpill.off { color: var(--bf-color-text-muted); }

.bf-vicon { position: relative; display: inline-flex; align-items: center; justify-content: center; gap: var(--bf-space-1);
  min-width: var(--bf-size-icon); height: var(--bf-size-icon); }

/* off: hollow dot; listening: static accent dot with a halo (nothing pulses) */
.bf-vdot { box-sizing: border-box; width: var(--bf-size-dot); height: var(--bf-size-dot); flex: 0 0 var(--bf-size-dot);
  border-radius: var(--bf-radius-pill); background: var(--bf-color-white); }
.bf-vpill.off .bf-vdot { background: var(--bf-color-transparent); border: var(--bf-border-width) solid var(--bf-color-text-muted); }
.bf-vpill.listening .bf-vdot { background: var(--bf-color-accent); box-shadow: var(--bf-shadow-dot-accent); }
/* connecting: the kit's small spinner (.bf-spinner) */
.bf-vpill.connecting .bf-vdot { width: var(--bf-size-icon); height: var(--bf-size-icon); flex-basis: var(--bf-size-icon);
  background: var(--bf-color-transparent); border: var(--bf-border-width-focus) solid var(--bf-color-border); border-top-color: var(--bf-color-text);
  animation: bf-spin var(--bf-duration-slow) linear infinite; }
/* hold to talk: the kit's mic glyph (.bf-mic) */
.bf-vpill.hold .bf-vdot { width: var(--bf-size-icon); height: var(--bf-size-icon); flex-basis: var(--bf-size-icon); border-radius: 0;
  background: currentColor; -webkit-mask: ${MIC_MASK}; mask: ${MIC_MASK}; }

/* thinking: three small dots (.bf-thinking) */
.bf-vthink { width: var(--bf-space-1); height: var(--bf-space-1); border-radius: var(--bf-radius-pill); background: var(--bf-color-text);
  animation: bf-breathe var(--bf-duration-slow) var(--bf-easing-gentle) infinite; }
.bf-vthink:nth-child(2) { animation-delay: var(--bf-duration-fast); }
.bf-vthink:nth-child(3) { animation-delay: var(--bf-duration-normal); }

/* speaking: five-bar waveform (.bf-waveform), 8 to 18 px, scaled rather than resized */
.bf-vbar { width: var(--bf-size-wave); height: var(--bf-size-icon); border-radius: var(--bf-radius-pill); background: var(--bf-color-text);
  transform: scaleY(0.444); animation: bf-wave var(--bf-duration-slow) var(--bf-easing-gentle) infinite; }
.bf-vbar:nth-child(2), .bf-vbar:nth-child(4) { animation-delay: var(--bf-duration-fast); }
.bf-vbar:nth-child(3) { animation-delay: var(--bf-duration-normal); }

/* ---- captions (.bf-captions): both lines on one shared soft backing. They wrap (up to three lines
   each), as before; Make's captions are one line each (nowrap). ---- */
.bf-vcaps { box-sizing: border-box; display: flex; flex-direction: column; align-items: center; gap: var(--bf-space-0);
  width: fit-content; max-width: min(var(--bf-size-caption-max), 100%); padding: var(--bf-space-2) var(--bf-space-4);
  border-radius: var(--bf-radius-caption); background-color: var(--bf-color-caption-backing);
  -webkit-backdrop-filter: blur(var(--bf-blur-caption)); backdrop-filter: blur(var(--bf-blur-caption));
  text-align: center; line-height: var(--bf-line-height-tight); text-shadow: var(--bf-shadow-1);
  transition: background-color var(--bf-duration-caption-fade) ease-out, backdrop-filter var(--bf-duration-caption-fade) ease-out; }
/* a part card (bottom left) or step card (bottom right) is up: the captions stay between them */
body:has(.bf-part-card, .bf-step-card) .bf-vcaps {
  max-width: min(var(--bf-size-caption-max), 100%, calc(100vw - 2 * (max(min(var(--bf-size-card-width), var(--bf-size-card-max-vw)), min(var(--bf-size-step-width), var(--bf-size-step-max-vw))) + var(--bf-edge) + var(--bf-space-4)))); }
/* the backing fades out with the last caption */
.bf-vcaps:not(:has(.bf-vcap:not(.fading))) { background-color: var(--bf-color-transparent); -webkit-backdrop-filter: none; backdrop-filter: none; }
.bf-vcap { box-sizing: border-box; max-width: 100%; margin: var(--bf-space-0); color: var(--bf-color-text);
  font-size: var(--bf-font-size-caption-reply); font-weight: var(--bf-font-weight-medium); line-height: var(--bf-line-height-tight);
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
  opacity: 1; transform: translateY(var(--bf-space-0));
  transition: opacity var(--bf-duration-caption-fade) ease-out, transform var(--bf-duration-caption-fade) ease-out;
  animation: bf-vcap-rise var(--bf-duration-normal) var(--bf-easing-out) backwards; }
.bf-vcap.user { color: var(--bf-color-caption-user); font-size: var(--bf-font-size-caption); font-weight: var(--bf-font-weight-regular); }
.bf-vcap.fading { opacity: 0; transform: translateY(calc(var(--bf-rise-distance) * -1)); }
@keyframes bf-vcap-rise { from { opacity: 0; transform: translateY(var(--bf-rise-distance)); } }

/* ---- hidden typed box (developer fallback, "/" to open, Esc to close) ---- */
.bf-vtype { pointer-events: auto; box-sizing: border-box; width: min(520px, 92vw); height: 44px; padding: 0 18px;
  border-radius: var(--bf-radius-pill); color: var(--bf-color-text); font: inherit; font-size: var(--bf-font-size-caption); outline: none; }
.bf-vtype::placeholder { color: var(--bf-color-text-muted); }

@media (prefers-reduced-motion: reduce) {
  .bf-vdot, .bf-vthink, .bf-vbar, .bf-vcap { animation: none !important; }
}
`;

/** Tokens and keyframes are repeated here (identical values), so the voice bar works on its own. */
export const KIT_VOICE_CSS = `${KIT_TOKENS_CSS}${KIT_KEYFRAMES_CSS}${KIT_VOICE_RULES}`;
