/**
 * HUD-local UI state (status lines, toast, developer log, debug toggle).
 * This is NOT app state: the shared app state lives in src/state/store.ts.
 * Camera, detection and overlay report problems here. On screen, only errors (and warnings from
 * explicit developer actions) are shown; everything else is visible in the hidden debug panel (D).
 */
import { create } from 'zustand';

export type StatusLevel = 'info' | 'warn' | 'error';

export interface StatusLine {
  level: StatusLevel;
  text: string;
}

export interface Toast extends StatusLine {
  id: number;
}

export interface LogLine extends StatusLine {
  /** performance.now() when logged */
  t: number;
}

interface HudUiState {
  status: Record<string, StatusLine>;
  toast: Toast | null;
  debug: boolean;
  /** Last few developer messages (key presses, explode results), shown only in the debug panel. */
  log: LogLine[];
  /**
   * The overlay keeps showing the last frozen frame while it collapses an exploded object after a
   * reset (store.frozen is already false by then), so "put it back" animates over the same image.
   */
  holdFrozen: boolean;
  /**
   * Text for the quiet busy pill while a parts list loads, instead of "Looking…" (e.g. "This is a
   * ThinkPad. Getting its parts…" when Claude corrects a cached guess). Set and cleared by src/lib/flow.ts.
   */
  busy: string | null;
}

export const useHud = create<HudUiState>(() => ({
  status: {},
  toast: null,
  debug: false,
  log: [],
  holdFrozen: false,
  busy: null,
}));

/** The busy pill's text while a parts list loads (null = "Looking…"). */
export function setBusyText(text: string | null): void {
  if (useHud.getState().busy !== text) useHud.setState({ busy: text });
}

export function setHoldFrozen(on: boolean): void {
  if (useHud.getState().holdFrozen !== on) useHud.setState({ holdFrozen: on });
}

/** Set (or clear, with level null) one status line. No-op when unchanged, so it is safe to call every frame. */
export function setStatus(key: string, level: StatusLevel | null, text?: string | null): void {
  const current = useHud.getState().status;
  const cur = current[key];
  if (!level || !text) {
    if (!cur) return;
    const next = { ...current };
    delete next[key];
    useHud.setState({ status: next });
    return;
  }
  if (cur && cur.level === level && cur.text === text) return;
  useHud.setState({ status: { ...current, [key]: { level, text } } });
}

/** Add a line to the debug panel's log only (never on screen). */
export function devLog(text: string, level: StatusLevel = 'info'): void {
  const line: LogLine = { t: performance.now(), level, text };
  useHud.setState((s) => ({ log: [...s.log.slice(-11), line] }));
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
let toastSeq = 0;

/**
 * A short message for the person at the keyboard. Always logged; shown on screen only for
 * warnings and errors (info goes to the debug panel only, so nothing chatty appears in the demo).
 */
export function showToast(text: string, level: StatusLevel = 'info', ms = 3500): void {
  devLog(text, level);
  if (level === 'info') return;
  if (toastTimer) clearTimeout(toastTimer);
  toastSeq += 1;
  const id = toastSeq;
  useHud.setState({ toast: { id, level, text } });
  toastTimer = setTimeout(() => {
    if (useHud.getState().toast?.id === id) useHud.setState({ toast: null });
  }, ms);
}

export function toggleDebug(): void {
  useHud.setState((s) => ({ debug: !s.debug }));
}
