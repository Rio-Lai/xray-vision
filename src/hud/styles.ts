/**
 * Blowfish stylesheets (PROJECT.md section 2), injected once with a <style> tag by Hud.
 * Used by the HUD (React) and by the imperative label layers in src/overlay/.
 *
 * Since #86 the default look is the Figma Make interface kit: its tokens and component styles are
 * in src/hud/kit/ (an adapted copy of docs/design/make-interface-kit/; adaptations in its README).
 * `?look=classic` (src/hud/look.ts) brings back the previous stylesheet, CLASSIC_HUD_CSS below,
 * unchanged: white frosted glass, one accent (#4DA3FF) for focus and highlight, warm amber
 * (#FF9F45) only for safety and active muscles. Labels >= 16px, body >= 18px. Nothing blinks.
 */
import { LOOK } from './look';
import { KIT_KEYFRAMES_CSS, KIT_TOKENS_CSS } from './kit/tokens';
import { KIT_HUD_CSS } from './kit/hud';

export const ACCENT = '#4DA3FF';
export const WARM = '#FF9F45';
export const FONT = 'system-ui, -apple-system, "SF Pro Text", Inter, sans-serif';

/** The hidden debug panel (D) and tuning panels: the same in both looks. */
export const DEBUG_CSS = `
/* ---- hidden debug panel (D): plain and dense on purpose ---- */
.bf-debug { position: absolute; left: 18px; top: 56px; max-width: calc(100vw - 36px); max-height: calc(100vh - 200px); overflow: hidden;
  padding: 10px 14px; border-radius: 10px; background: rgba(0, 0, 0, 0.72); color: #e8e8e8;
  font: 12px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace !important; white-space: pre; }
.bf-tuning-col { position: absolute; top: 16px; right: 18px; width: 320px; max-height: calc(100vh - 32px); overflow-y: auto;
  display: flex; flex-direction: column; gap: 10px; pointer-events: auto; }
.bf-tuning { box-sizing: border-box; width: 100%; padding: 12px 14px; border-radius: 10px; pointer-events: auto;
  background: rgba(0, 0, 0, 0.78); color: #e8e8e8; font-size: 13px !important; display: flex; flex-direction: column; gap: 8px; }
.bf-tuning * { font-size: 13px; }
.bf-tuning-title { font-weight: 600; }
.bf-tuning label { display: flex; flex-direction: column; gap: 2px; }
.bf-tuning label b { color: #fff; }
.bf-tuning input[type=range] { width: 100%; accent-color: ${ACCENT}; }
.bf-tuning .bf-tuning-row { flex-direction: row; align-items: center; gap: 8px; }
.bf-tuning button { padding: 3px 10px; border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.3); background: rgba(255, 255, 255, 0.1); color: #fff; cursor: pointer; }
.bf-tuning code { font: 11px ui-monospace, SFMono-Regular, Menlo, monospace !important; color: #bbb; user-select: text; word-break: break-all; }
`;

/** The look before #86 (`?look=classic`). */
export const CLASSIC_HUD_CSS = `
.bf-hud, .bf-olayer, .bf-player { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
.bf-hud, .bf-olayer, .bf-player, .bf-hud * { font-family: ${FONT}; -webkit-font-smoothing: antialiased; }
.bf-hud { color: #fff; font-size: 18px; line-height: 1.4; }

/* Frosted glass: white at ~14% with a hairline border; the backdrop is blurred and slightly darkened
   so white text stays readable on a bright desk. */
.bf-glass { background: rgba(255, 255, 255, 0.14); border: 1px solid rgba(255, 255, 255, 0.24);
  -webkit-backdrop-filter: blur(18px) saturate(160%) brightness(0.84); backdrop-filter: blur(18px) saturate(160%) brightness(0.84);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.16); }

.bf-pill { display: inline-flex; align-items: center; gap: 8px; box-sizing: border-box; height: 34px; padding: 0 15px;
  border-radius: 999px; color: #fff; font-size: 16px; font-weight: 500; letter-spacing: -0.005em; white-space: nowrap;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.28); }
.bf-pill--focus { background: rgba(255, 255, 255, 0.26); border-color: rgba(255, 255, 255, 0.52);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.2), 0 0 0 4px rgba(77, 163, 255, 0.16); font-weight: 600; }

/* ---- object labels (overlay on) ---- */
.bf-olabel { position: absolute; left: 0; top: 0; width: 0; height: 0; will-change: transform; }
.bf-olabel-in { position: absolute; left: 0; top: 0; opacity: 0; transform: scale(0.9); transform-origin: 0 0;
  transition: opacity 250ms ease-out, transform 250ms cubic-bezier(0.2, 0.8, 0.2, 1); }
.bf-olabel-in.on { opacity: 1; transform: scale(1); }
.bf-olabel-dot { position: absolute; left: -4px; top: -4px; width: 8px; height: 8px; border-radius: 50%;
  background: #fff; box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.12), 0 1px 4px rgba(0, 0, 0, 0.3); }
.bf-olabel-in.focus .bf-olabel-dot { background: ${ACCENT}; box-shadow: 0 0 0 4px rgba(77, 163, 255, 0.25), 0 0 14px rgba(77, 163, 255, 0.6); }
.bf-olabel-stem { position: absolute; left: -0.5px; bottom: 4px; width: 1px; background: rgba(255, 255, 255, 0.7);
  box-shadow: 0 0 2px rgba(0, 0, 0, 0.25); }
.bf-olabel-in.below .bf-olabel-stem { bottom: auto; top: 4px; }
.bf-olabel-pill { position: absolute; left: 0; }
.bf-focusglow { position: absolute; left: 0; top: 0; border-radius: 28px; opacity: 0; transition: opacity 300ms ease-out;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.1), inset 0 0 56px rgba(77, 163, 255, 0.2), 0 0 36px rgba(77, 163, 255, 0.1); }
.bf-focusglow.on { opacity: 1; }

/* ---- the pinch cue: one tiny soft dot at an active pinch point (hand gestures) ---- */
.bf-pinch { position: absolute; left: 0; top: 0; width: 12px; height: 12px; margin: -6px 0 0 -6px; border-radius: 50%;
  background: rgba(255, 255, 255, 0.92); box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.16), 0 0 14px rgba(255, 255, 255, 0.45);
  opacity: 0; transition: opacity 140ms ease-out; will-change: transform, opacity; }
.bf-pinch.on { opacity: 0.9; }

/* ---- part labels (exploded) ---- */
.bf-plabel { position: absolute; left: 0; top: 0; will-change: transform, opacity; }
.bf-plabel.hl { background: rgba(77, 163, 255, 0.34); border-color: rgba(120, 186, 255, 0.95); font-size: 17px; font-weight: 600;
  height: 38px; box-shadow: 0 6px 24px rgba(0, 0, 0, 0.2), 0 0 18px rgba(77, 163, 255, 0.35); }
.bf-plabel-line { stroke: rgba(255, 255, 255, 0.62); stroke-width: 1; }
.bf-plabel-line.hl { stroke: ${ACCENT}; stroke-width: 1.5; }
.bf-plabel-dot { fill: #fff; stroke: rgba(0, 0, 0, 0.2); stroke-width: 1; }
.bf-plabel-dot.hl { fill: ${ACCENT}; stroke: rgba(255, 255, 255, 0.9); stroke-width: 1.5; }

/* ---- exploded object title ---- */
.bf-title { position: absolute; top: 18px; left: 50%; transform: translateX(-50%); display: flex; gap: 8px; align-items: center;
  white-space: nowrap; animation: bf-in 300ms ease-out both; }
.bf-title .bf-pill { font-size: 17px; font-weight: 600; height: 36px; }
.bf-chip-ai { color: #ffd3a6; font-size: 16px; }
.bf-chip-ai::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: ${WARM}; }

/* ---- cards ---- */
.bf-card { position: absolute; bottom: 28px; box-sizing: border-box; width: min(30vw, 420px); min-width: 300px; padding: 18px 22px 20px;
  border-radius: 20px; background: rgba(255, 255, 255, 0.12); border: 1px solid rgba(255, 255, 255, 0.2);
  -webkit-backdrop-filter: blur(28px) saturate(170%) brightness(0.7); backdrop-filter: blur(28px) saturate(170%) brightness(0.7);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.28); animation: bf-in 260ms ease-out both; }
.bf-card-part { left: 28px; }
.bf-card-step { right: 28px; }
.bf-card-kicker { font-size: 16px; font-weight: 500; color: rgba(255, 255, 255, 0.66); margin-bottom: 4px; }
.bf-card-title { font-size: 20px; font-weight: 600; letter-spacing: -0.01em; color: #fff; margin-bottom: 6px; }
.bf-card-body { font-size: 18px; color: rgba(255, 255, 255, 0.88); }
.bf-card-step .bf-card-body { font-size: 19px; color: #fff; }
.bf-card-safety { display: flex; gap: 10px; align-items: baseline; margin-top: 12px; padding-top: 12px;
  border-top: 1px solid rgba(255, 159, 69, 0.3); color: #ffc58f; font-size: 18px; }
.bf-card-safety::before { content: ''; flex: none; width: 8px; height: 8px; border-radius: 50%; background: ${WARM};
  transform: translateY(-2px); box-shadow: 0 0 8px rgba(255, 159, 69, 0.6); }

/* ---- the one status pill near the bottom (above the voice pill and captions) ---- */
.bf-status { position: absolute; left: 50%; bottom: 150px; transform: translateX(-50%); max-width: min(80vw, 760px);
  animation: bf-in 250ms ease-out both; }
.bf-status .bf-pill { height: auto; min-height: 36px; padding: 7px 16px; white-space: normal; text-align: center; font-size: 17px; }
.bf-status-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: rgba(255, 255, 255, 0.85); }
.bf-status-dot.busy { animation: bf-breathe 1.6s ease-in-out infinite; }
.bf-status-dot.warn { background: ${WARM}; }
.bf-status-dot.error { background: #ff7a6b; }

@keyframes bf-in { from { opacity: 0; transform: translate(var(--bf-tx, 0), 6px) scale(0.98); } to { opacity: 1; transform: translate(var(--bf-tx, 0), 0) scale(1); } }
@keyframes bf-breathe { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
.bf-title, .bf-status { --bf-tx: -50%; }

${DEBUG_CSS}`;

/** The Figma Make interface kit look (default). */
export const KIT_CSS = `${KIT_TOKENS_CSS}${KIT_KEYFRAMES_CSS}${KIT_HUD_CSS}${DEBUG_CSS}`;

/** The stylesheet Hud injects: the kit, or the classic look with ?look=classic. */
export const HUD_CSS = LOOK === 'classic' ? CLASSIC_HUD_CSS : KIT_CSS;
