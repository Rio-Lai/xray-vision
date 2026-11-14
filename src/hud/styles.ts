/** HUD stylesheet, injected with a <style> tag by Hud (no CSS module imports needed). */
export const HUD_CSS = `
.xr-hud { position: absolute; inset: 0; pointer-events: none; overflow: hidden;
  font-family: 'JetBrains Mono', 'SF Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  color: #7de3ff; font-size: 17px; line-height: 1.35; }
.xr-card { background: rgba(4, 12, 20, 0.62); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
  border: 1px solid rgba(125, 227, 255, 0.55); border-radius: 6px;
  box-shadow: inset 0 0 18px rgba(125, 227, 255, 0.12), 0 0 12px rgba(0, 0, 0, 0.35); }
.xr-badge { position: absolute; padding: 6px 14px; letter-spacing: 0.14em; text-transform: uppercase; font-weight: 700; font-size: 18px; }
.xr-tl { top: 16px; left: 18px; }
.xr-tr { top: 16px; right: 18px; display: flex; gap: 10px; align-items: center; }
.xr-tr .xr-pill { position: static; }
.xr-pill { padding: 5px 12px; letter-spacing: 0.12em; text-transform: uppercase; font-size: 15px; font-weight: 600; }
.xr-frozen { color: #ffd27a; border-color: rgba(255, 210, 122, 0.85); box-shadow: 0 0 14px rgba(255, 190, 90, 0.35); }
.xr-tc { position: absolute; top: 16px; left: 50%; transform: translateX(-50%); display: flex; gap: 10px; align-items: center; white-space: nowrap; }
.xr-chip-ai { color: #ffd27a; border-color: rgba(255, 210, 122, 0.85); }

.xr-obj { position: absolute; left: 0; top: 0; transition: transform 70ms linear, width 70ms linear, height 70ms linear; }
.xr-obj i { position: absolute; width: 18px; height: 18px; border: 0 solid rgba(125, 227, 255, 0.85); }
.xr-obj i.tl { left: 0; top: 0; border-left-width: 2px; border-top-width: 2px; }
.xr-obj i.tr { right: 0; top: 0; border-right-width: 2px; border-top-width: 2px; }
.xr-obj i.bl { left: 0; bottom: 0; border-left-width: 2px; border-bottom-width: 2px; }
.xr-obj i.br { right: 0; bottom: 0; border-right-width: 2px; border-bottom-width: 2px; }
.xr-obj.focused i { width: 26px; height: 26px; border-color: #c9f5ff; border-width: 0; }
.xr-obj.focused i.tl { border-left-width: 3px; border-top-width: 3px; }
.xr-obj.focused i.tr { border-right-width: 3px; border-top-width: 3px; }
.xr-obj.focused i.bl { border-left-width: 3px; border-bottom-width: 3px; }
.xr-obj.focused i.br { border-right-width: 3px; border-bottom-width: 3px; }
.xr-obj-tag { position: absolute; left: 0; top: -30px; padding: 2px 8px; font-size: 15px; letter-spacing: 0.08em;
  white-space: nowrap; background: rgba(4, 12, 20, 0.7); border: 1px solid rgba(125, 227, 255, 0.5); border-radius: 3px; }
.xr-obj.focused .xr-obj-tag { color: #04121c; background: #7de3ff; font-weight: 700; }
.xr-obj-tag span { opacity: 0.7; margin-left: 8px; }

.xr-reticle { position: absolute; left: 50%; top: 50%; width: 76px; height: 76px; transform: translate(-50%, -50%); }
.xr-reticle svg { width: 100%; height: 100%; overflow: visible; }
.xr-reticle .ring { transition: stroke 150ms, stroke-width 150ms; }
.xr-reticle.locked .spin { animation: xr-spin 2.4s linear infinite; transform-origin: 38px 38px; }
@keyframes xr-spin { to { transform: rotate(360deg); } }
.xr-lock { position: absolute; left: 50%; top: calc(50% - 64px); transform: translateX(-50%); font-size: 15px;
  letter-spacing: 0.16em; color: #c9f5ff; white-space: nowrap; text-shadow: 0 0 8px rgba(0, 0, 0, 0.9); }

.xr-status { position: absolute; left: 50%; top: calc(50% + 52px); transform: translateX(-50%); display: flex;
  flex-direction: column; align-items: center; gap: 6px; max-width: min(78vw, 980px); }
.xr-line { padding: 5px 12px; font-size: 17px; text-align: center; }
.xr-line.info { color: #7de3ff; }
.xr-line.warn { color: #ffd27a; border-color: rgba(255, 210, 122, 0.7); }
.xr-line.error { color: #ff6b6b; border-color: rgba(255, 107, 107, 0.85); font-weight: 700; }
.xr-dots::after { content: ''; animation: xr-dots 1.2s steps(4, end) infinite; }
@keyframes xr-dots { 0% { content: ''; } 25% { content: '.'; } 50% { content: '..'; } 75% { content: '...'; } }

.xr-part { position: absolute; left: 20px; bottom: 24px; width: min(31vw, 520px); padding: 14px 18px; }
.xr-step { position: absolute; right: 20px; bottom: 24px; width: min(31vw, 520px); padding: 14px 18px; }
.xr-kicker { font-size: 13px; letter-spacing: 0.2em; opacity: 0.75; text-transform: uppercase; margin-bottom: 4px; }
.xr-title { font-size: 23px; font-weight: 700; color: #e9fbff; margin-bottom: 6px; }
.xr-body { font-size: 17px; color: #cfefff; }
.xr-safety { margin-top: 10px; padding-top: 8px; border-top: 1px solid rgba(255, 210, 122, 0.4); color: #ffd27a; font-size: 16px; }
.xr-safety b { letter-spacing: 0.14em; margin-right: 8px; }

.xr-legend { position: absolute; right: 20px; top: 50%; transform: translateY(-50%); padding: 10px 14px; font-size: 14px; }
.xr-legend div { white-space: nowrap; }
.xr-legend b { display: inline-block; min-width: 46px; color: #e9fbff; }

.xr-debug { position: absolute; left: 18px; top: 104px; max-height: calc(100vh - 300px); overflow: hidden; padding: 10px 14px;
  font-size: 13px; line-height: 1.3; white-space: pre; color: #bdefff; }

.xr-toast { position: absolute; left: 50%; bottom: 140px; transform: translateX(-50%); padding: 8px 16px; font-size: 17px; white-space: nowrap; }
.xr-toast.warn { color: #ffd27a; }
.xr-toast.error { color: #ff6b6b; }
`;
