/**
 * Design tokens of the Figma Make interface kit (#85, #86), as a string injected with the HUD and
 * voice stylesheets (same mechanism as before: a <style> tag, no CSS import).
 * Copied from docs/design/make-interface-kit/tokens.css (which stays exactly as Make produced it).
 * Differences from Make's file, all listed in ./README.md: --bf-color-glass-quiet is denser, and an
 * "app additions" block at the end. The scrim and stage tokens are kept but unused: the dim and
 * blur behind the model stay the app's own (src/camera/Camera.tsx).
 */
export const KIT_TOKENS_CSS = `
:root {
  --bf-color-white: #ffffff;
  --bf-color-text: rgba(255, 255, 255, 0.96);
  --bf-color-text-quiet: rgba(255, 255, 255, 0.85);
  --bf-color-text-muted: rgba(255, 255, 255, 0.62);
  --bf-color-caption-user: rgba(255, 255, 255, 0.78);
  --bf-color-glass: rgba(22, 25, 30, 0.64);
  /* #86: darker and denser than Make's rgba(36, 39, 44, 0.5), so quiet labels stay readable over a bright desk. */
  --bf-color-glass-quiet: rgba(20, 23, 28, 0.66);
  --bf-color-glass-strong: rgba(16, 19, 24, 0.78);
  --bf-color-glass-soft: rgba(255, 255, 255, 0.1);
  --bf-color-border: rgba(255, 255, 255, 0.22);
  --bf-color-border-quiet: rgba(255, 255, 255, 0.14);
  --bf-color-line: rgba(255, 255, 255, 0.68);
  --bf-color-line-strong: rgba(255, 255, 255, 0.75);
  --bf-color-dot-ring: rgba(0, 0, 0, 0.62);
  --bf-color-accent: #4da3ff;
  --bf-color-accent-soft: rgba(77, 163, 255, 0.28);
  --bf-color-focus-glow: rgba(77, 163, 255, 0.18);
  --bf-color-warm: #ff9f45;
  --bf-color-warm-soft: rgba(255, 159, 69, 0.2);
  --bf-color-coral: #ff7a6b;
  --bf-color-shadow: rgba(0, 0, 0, 0.28);
  --bf-color-shadow-strong: rgba(0, 0, 0, 0.42);
  --bf-color-scrim: rgba(8, 10, 13, 0.45);
  --bf-color-scrim-center: rgba(4, 6, 9, 0.38);
  --bf-color-scrim-edge: rgba(8, 10, 13, 0.14);
  --bf-color-caption-gradient: rgba(8, 10, 13, 0.8);
  --bf-color-caption-backing: rgba(12, 13, 15, 0.55);
  --bf-color-transparent: transparent;

  --bf-font-family: system-ui, -apple-system, "SF Pro Text", Inter, sans-serif;
  --bf-font-size-label: 17px;
  --bf-font-size-body: 19px;
  --bf-font-size-title: 20px;
  --bf-font-size-card-name: 24px;
  --bf-font-size-kicker: 16px;
  --bf-font-size-caption: 18px;
  --bf-font-size-caption-reply: 20px;
  --bf-font-size-error: 18px;
  --bf-font-weight-regular: 400;
  --bf-font-weight-medium: 500;
  --bf-font-weight-semibold: 600;
  --bf-line-height-tight: 1.2;
  --bf-line-height-body: 1.45;

  --bf-space-0: 0px;
  --bf-space-1: 4px;
  --bf-space-2: 8px;
  --bf-space-3: 12px;
  --bf-space-4: 16px;
  --bf-space-6: 24px;
  --bf-space-8: 32px;
  --bf-space-12: 48px;
  --bf-edge: 32px;

  --bf-radius-pill: 999px;
  --bf-radius-card: 22px;
  --bf-radius-small: 12px;
  --bf-radius-caption: 16px;
  --bf-radius-focus: 28px;
  --bf-border-width: 1px;
  --bf-border-width-focus: 1.5px;
  --bf-blur-glass: 22px;
  --bf-blur-stage: 16px;
  --bf-blur-caption: 16px;
  --bf-blur-focus-inner: 24px;
  --bf-blur-focus-outer: 56px;
  --bf-saturate-glass: 135%;
  --bf-stage-brightness: 0.5;
  --bf-stage-saturation: 0.8;

  --bf-shadow-1: 0 4px 16px rgba(0, 0, 0, 0.2);
  --bf-shadow-2: 0 10px 32px rgba(0, 0, 0, 0.28);
  --bf-shadow-3: 0 24px 64px rgba(0, 0, 0, 0.42);
  --bf-shadow-leader: drop-shadow(0 0 2px rgba(0, 0, 0, 0.5));
  --bf-shadow-dot-ring: 0 0 0 1px rgba(0, 0, 0, 0.62);
  --bf-shadow-dot-accent: 0 0 0 1px rgba(0, 0, 0, 0.62), 0 0 0 5px rgba(77, 163, 255, 0.28);
  --bf-shadow-dot-warm: 0 0 0 1px rgba(0, 0, 0, 0.62), 0 0 0 5px rgba(255, 159, 69, 0.2);

  --bf-size-stage-width: 1920px;
  --bf-size-stage-height: 1080px;
  --bf-size-pill-height: 40px;
  --bf-size-dot: 8px;
  --bf-size-dot-ring: 18px;
  --bf-size-stem: 28px;
  --bf-size-leader: 1920px;
  --bf-size-model-width: 720px;
  --bf-size-model-height: 550px;
  --bf-size-hand-width: 720px;
  --bf-size-hand-height: 620px;
  --bf-size-card-width: 460px;
  --bf-size-step-width: 430px;
  --bf-size-voice-zone-width: 760px;
  --bf-size-voice-zone-height: 120px;
  --bf-size-status-offset: 148px;
  --bf-size-voice-pill-min: 148px;
  --bf-size-icon: 18px;
  --bf-size-wave: 3px;
  --bf-size-error-max: 760px;
  --bf-size-leader-elbow: 32px;
  --bf-size-leader-gap: 6px;
  --bf-size-caption-max: 720px;
  --bf-size-focus-inset: 20px;

  --bf-duration-fast: 200ms;
  --bf-duration-normal: 240ms;
  --bf-duration-slow: 1200ms;
  --bf-easing-out: cubic-bezier(0.16, 1, 0.3, 1);
  --bf-easing-gentle: ease-in-out;
  --bf-rise-distance: 4px;
  --bf-rotate-full: 360deg;

  /* ---- app additions (#86), not in Make's tokens.css; see src/hud/kit/README.md ---- */
  /* quiet label text and weight: readable over a bright desk, still quieter than focused (0.96, 600) */
  --bf-color-text-label-quiet: rgba(255, 255, 255, 0.92);
  --bf-font-weight-label-quiet: 500;
  /* the safety note is body text: 18 px minimum (Make: --bf-font-size-label, 17 px) */
  --bf-font-size-safety: 18px;
  /* --bf-shadow-leader as a box-shadow, for the object label stem (no per-label filter) */
  --bf-shadow-line: 0 0 2px rgba(0, 0, 0, 0.5);
  /* the voice pill keeps the app's 24 px from the bottom edge (Make: 8 px), clear of the glasses' edge */
  --bf-size-voice-bottom: 24px;
  /* caption fade-out, must match CAPTION_FADE_MS in src/voice/VoiceBar.tsx */
  --bf-duration-caption-fade: 600ms;
  /* cards narrow on small windows (text sizes never shrink) */
  --bf-size-card-max-vw: 30vw;
  --bf-size-step-max-vw: 28vw;
  --bf-size-card-min: 280px;
}
`;

/**
 * The kit's keyframes (hud.css), shared by the HUD and voice stylesheets. One change: bf-wave
 * animates transform (scaleY 8/18 to 1) instead of height, so the speaking waveform never triggers
 * layout; it looks the same.
 */
export const KIT_KEYFRAMES_CSS = `
@keyframes bf-rise {
  from { opacity: 0; margin-top: var(--bf-rise-distance); }
  to { opacity: 1; margin-top: var(--bf-space-0); }
}
@keyframes bf-spin {
  to { transform: rotate(var(--bf-rotate-full)); }
}
@keyframes bf-breathe {
  50% { opacity: 0.35; transform: translateY(calc(var(--bf-space-1) * -1)); }
}
@keyframes bf-wave {
  0%, 100% { transform: scaleY(0.444); }
  50% { transform: scaleY(1); }
}
`;
