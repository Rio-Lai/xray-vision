/**
 * Voice UI stylesheet (PROJECT.md section 2): one small frosted pill at the bottom centre that shows
 * off / listening / thinking / speaking, subtitle-style captions above it, and the hidden typed box.
 * Same glass, font and accent as the HUD (src/hud/styles.ts). Rendered once by VoiceBar.
 */
import { ACCENT, FONT } from '../hud/styles';
import { LOOK } from '../hud/look';
import { KIT_VOICE_CSS } from '../hud/kit/voice';

/** The look before #86 (`?look=classic`). */
export const CLASSIC_VOICE_CSS = `
.bf-voice { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 50;
  display: flex; flex-direction: column; align-items: center; gap: 12px; width: min(760px, 92vw);
  pointer-events: none; font-family: ${FONT}; -webkit-font-smoothing: antialiased; color: #fff; }

.bf-vglass { background: rgba(255, 255, 255, 0.14); border: 1px solid rgba(255, 255, 255, 0.24);
  -webkit-backdrop-filter: blur(18px) saturate(160%) brightness(0.84); backdrop-filter: blur(18px) saturate(160%) brightness(0.84);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.16); }

/* ---- the pill ---- */
.bf-vpill { pointer-events: auto; display: inline-flex; align-items: center; gap: 10px; box-sizing: border-box;
  height: 36px; padding: 0 16px 0 14px; border-radius: 999px; color: #fff; font: inherit; font-size: 16px; font-weight: 500;
  letter-spacing: -0.005em; white-space: nowrap; cursor: pointer; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.28);
  transition: background 250ms ease-out, border-color 250ms ease-out, opacity 250ms ease-out; }
.bf-vpill:focus { outline: none; }
.bf-vpill:focus-visible { box-shadow: 0 0 0 3px rgba(77, 163, 255, 0.45); }
.bf-vpill.off { opacity: 0.72; }
.bf-vpill.speaking { background: rgba(255, 255, 255, 0.22); border-color: rgba(255, 255, 255, 0.4); }

.bf-vicon { position: relative; display: inline-flex; align-items: center; justify-content: center; gap: 3px; width: 22px; height: 18px; }
.bf-vdot { width: 8px; height: 8px; border-radius: 50%; background: rgba(255, 255, 255, 0.55); transition: background 250ms ease-out; }
.bf-vpill.listening .bf-vdot { background: ${ACCENT}; box-shadow: 0 0 0 4px rgba(77, 163, 255, 0.2);
  animation: bf-vbreathe 2.6s ease-in-out infinite; }
.bf-vpill.connecting .bf-vdot { animation: bf-vbreathe 1.6s ease-in-out infinite; }

/* thinking: three small dots easing up and down in turn */
.bf-vthink { width: 5px; height: 5px; border-radius: 50%; background: #fff; opacity: 0.8;
  animation: bf-vthink 1.2s ease-in-out infinite; }
.bf-vthink:nth-child(2) { animation-delay: 0.15s; }
.bf-vthink:nth-child(3) { animation-delay: 0.3s; }

/* speaking: a gentle five-bar waveform */
.bf-vbar { width: 3px; height: 16px; border-radius: 2px; background: #fff; transform-origin: 50% 50%;
  transform: scaleY(0.3); animation: bf-vwave 1.1s ease-in-out infinite; }
.bf-vbar:nth-child(1) { animation-delay: -0.9s; }
.bf-vbar:nth-child(2) { animation-delay: -0.45s; }
.bf-vbar:nth-child(3) { animation-delay: -0.15s; }
.bf-vbar:nth-child(4) { animation-delay: -0.6s; }
.bf-vbar:nth-child(5) { animation-delay: -0.3s; }

/* ---- captions ---- */
.bf-vcaps { display: flex; flex-direction: column; align-items: center; gap: 6px; max-width: 100%; }
.bf-vcap { box-sizing: border-box; max-width: 100%; padding: 6px 14px; border-radius: 14px; background: rgba(0, 0, 0, 0.38);
  -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); font-size: 19px; line-height: 1.35; text-align: center;
  color: #fff; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.35); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
  overflow: hidden; opacity: 1; transform: translateY(0); transition: opacity 600ms ease-out, transform 600ms ease-out;
  animation: bf-vcap-in 250ms ease-out both; }
.bf-vcap.user { color: rgba(255, 255, 255, 0.78); font-size: 18px; }
.bf-vcap.fading { opacity: 0; transform: translateY(-4px); }

/* ---- hidden typed box (developer fallback, "/" to open, Esc to close) ---- */
.bf-vtype { pointer-events: auto; box-sizing: border-box; width: min(520px, 92vw); height: 44px; padding: 0 18px; border-radius: 999px;
  color: #fff; font: inherit; font-size: 18px; outline: none; }
.bf-vtype::placeholder { color: rgba(255, 255, 255, 0.6); }

@keyframes bf-vbreathe { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
@keyframes bf-vthink { 0%, 100% { transform: translateY(2px); opacity: 0.45; } 50% { transform: translateY(-2px); opacity: 1; } }
@keyframes bf-vwave { 0%, 100% { transform: scaleY(0.3); } 50% { transform: scaleY(1); } }
@keyframes bf-vcap-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }

@media (prefers-reduced-motion: reduce) {
  .bf-vdot, .bf-vthink, .bf-vbar { animation: none !important; }
  .bf-vbar { transform: scaleY(0.6); }
}
`;

/** #86: the Figma Make interface kit look by default (src/hud/kit/voice.ts, CSS only); ?look=classic keeps the one above. */
export const VOICE_CSS = LOOK === 'classic' ? CLASSIC_VOICE_CSS : KIT_VOICE_CSS;
