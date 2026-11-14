/**
 * HUD-local UI state (status lines, toast, legend/debug toggles).
 * This is NOT app state: the shared app state lives in src/state/store.ts.
 * Camera, detection and overlay report failures here so they show as red HUD lines.
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

interface HudUiState {
  status: Record<string, StatusLine>;
  toast: Toast | null;
  legend: boolean;
  debug: boolean;
}

export const useHud = create<HudUiState>(() => ({
  status: {},
  toast: null,
  legend: true,
  debug: false,
}));

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

let toastTimer: ReturnType<typeof setTimeout> | null = null;
let toastSeq = 0;

export function showToast(text: string, level: StatusLevel = 'info', ms = 3500): void {
  if (toastTimer) clearTimeout(toastTimer);
  toastSeq += 1;
  const id = toastSeq;
  useHud.setState({ toast: { id, level, text } });
  toastTimer = setTimeout(() => {
    if (useHud.getState().toast?.id === id) useHud.setState({ toast: null });
  }, ms);
}

export function toggleLegend(): void {
  useHud.setState((s) => ({ legend: !s.legend }));
}

export function toggleDebug(): void {
  useHud.setState((s) => ({ debug: !s.debug }));
}
