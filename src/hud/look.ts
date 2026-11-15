/**
 * Which look the overlay uses (#86). Default: the Figma Make interface kit (src/hud/kit/).
 * `?look=classic` brings back the previous stylesheets (src/hud/styles.ts CLASSIC_HUD_CSS and
 * src/voice/voiceStyles.ts CLASSIC_VOICE_CSS), to compare on the real rig. Read once at start.
 * The debug panel (D) says which look is active.
 */
export type Look = 'kit' | 'classic';

function readLook(): Look {
  try {
    return new URLSearchParams(window.location.search).get('look') === 'classic' ? 'classic' : 'kit';
  } catch {
    return 'kit';
  }
}

export const LOOK: Look = readLook();
/** true for the Figma Make kit look (the default). */
export const KIT_LOOK = LOOK === 'kit';
