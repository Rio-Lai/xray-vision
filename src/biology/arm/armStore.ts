/**
 * State for the X-ray arm. Separate from the app store because the arm teardown has its own shape
 * (see types.ts). The voice tools and the /arm-demo buttons both drive it through tour.ts.
 */
import { create } from 'zustand';
import type { Activity, ArmFrame, Keystroke } from './types';

export type ArmSource = 'live' | 'replay';

export interface ArmState {
  /** true while the arm overlay owns the voice tools (explode / show_step / reset / highlight) */
  active: boolean;
  explode: number;
  layerFocus: number | null;
  /** part id -> glow 0..1 */
  highlight: Record<string, number>;
  step: number | null;
  activity: Activity;
  confidence: number;
  keystrokes: Keystroke[];
  /** latest landmarks (live: written by the detection feed; replay: by the trace player) */
  frame: ArmFrame | null;
  source: ArmSource;
  frozen: boolean;
  recording: boolean;

  setActive: (on: boolean) => void;
  setExplode: (v: number) => void;
  setLayerFocus: (l: number | null) => void;
  setHighlight: (h: Record<string, number>) => void;
  setStep: (n: number | null) => void;
  setActivity: (a: Activity, confidence: number) => void;
  pushKeystrokes: (k: Keystroke[]) => void;
  setFrame: (f: ArmFrame | null) => void;
  setSource: (s: ArmSource) => void;
  setFrozen: (f: boolean) => void;
  setRecording: (r: boolean) => void;
  reset: () => void;
}

export const useArmStore = create<ArmState>((set) => ({
  active: false,
  explode: 0,
  layerFocus: null,
  highlight: {},
  step: null,
  activity: 'none',
  confidence: 0,
  keystrokes: [],
  frame: null,
  source: 'live',
  frozen: false,
  recording: false,

  setActive: (active) => set({ active }),
  setExplode: (explode) => set({ explode: Math.max(0, Math.min(1, explode)) }),
  setLayerFocus: (layerFocus) => set({ layerFocus }),
  setHighlight: (highlight) => set({ highlight }),
  setStep: (step) => set({ step }),
  setActivity: (activity, confidence) => set({ activity, confidence }),
  // keep the last ~2 s of keystrokes (pulses only need the newest per finger), de-duplicated
  pushKeystrokes: (k) =>
    set((s) => {
      if (k.length === 0) return s;
      const key = (x: Keystroke) => `${x.finger}:${x.kind}:${Math.round(x.t)}`;
      const seen = new Set(s.keystrokes.map(key));
      const all = [...s.keystrokes, ...k.filter((x) => !seen.has(key(x)))];
      const newest = Math.max(...all.map((x) => x.t));
      return { keystrokes: all.filter((x) => x.t > newest - 2000) };
    }),
  setFrame: (frame) => set({ frame }),
  setSource: (source) => set({ source }),
  setFrozen: (frozen) => set({ frozen }),
  setRecording: (recording) => set({ recording }),
  reset: () => set({ explode: 0, layerFocus: null, highlight: {}, step: null }),
}));
