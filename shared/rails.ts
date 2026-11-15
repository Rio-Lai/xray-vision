/**
 * "Rails" detail views (behind `?detail=1`): a flat, front-on comparison of two things that do the same job,
 * one rail each (top and bottom), with the same stage of the job in each column. Unlike a DetailScene
 * (shared/detail.ts, made by Claude and shown as an "AI sketch"), a rails view is written and checked by
 * hand, bundled into the app (shared/checked/), and opens at once with no server call, no key and no network.
 *
 * src/lib/detail.ts opens one when matchRails finds it for the topic, before asking the server;
 * src/overlay/RailsView.tsx draws it. Pure (no I/O, no zod), so a script can check it on its own.
 */
import { IPHONE_EYE } from './checked/iphone-eye';

/** One part on one rail: the model's part id (null when the part does not exist, e.g. the iPhone has no iris) and its label. */
export interface RailsPart {
  part_id: string | null;
  label: string;
  /** Other part ids that light up with it (the eye's lens with the ciliary body). */
  also?: string[];
}

/** One stage of the job: the iPhone's part (top rail) and the eye's part (bottom rail). */
export interface RailsColumn {
  id: string;
  iphone: RailsPart;
  eye: RailsPart;
}

export interface RailsRail {
  id: 'iphone' | 'eye';
  label: string;
  /** The model this rail's parts belong to (public/cache/<object_id>.json). */
  object_id: string;
}

export interface RailsStep {
  /** The column this step is about (a RailsColumn id). */
  column: string;
  /** The sentence to say, word for word. */
  say: string;
}

export interface RailsScene {
  id: string;
  kind: 'rails';
  title: string;
  summary: string;
  /** Always "checked": a person reviewed every word. */
  source: 'checked';
  /** Topics that open it exactly (compared without case or punctuation). */
  triggers: string[];
  /** Top rail first, then the bottom rail. */
  rails: [RailsRail, RailsRail];
  columns: RailsColumn[];
  steps: RailsStep[];
}

/** Every checked rails view, in the order they are tried. */
export const CHECKED_RAILS: readonly RailsScene[] = [IPHONE_EYE];

/** Lower case, every run of punctuation or spaces one space, trimmed: "Compare the camera with my eye!" -> "compare the camera with my eye". */
export function normaliseTopic(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const CAMERA_WORDS = new Set(['camera', 'cameras', 'iphone', 'phone']);
const EYE_WORDS = new Set(['eye', 'eyes']);

/**
 * True when the topic asks to compare a camera with the eye: it is one of the triggers, or it has a camera
 * word (camera, cameras, iphone, phone, or lens) and an eye word (eye, eyes). "lens" straight after an eye
 * word is the eye's own lens ("how the eye lens focuses light" is the eye's pre-made 3D model, not this).
 */
export function isCameraEyeTopic(topic: string, triggers: readonly string[]): boolean {
  const t = normaliseTopic(topic);
  if (!t) return false;
  if (triggers.some((x) => normaliseTopic(x) === t)) return true;
  const words = t.split(' ');
  const camera = words.some((w, i) => CAMERA_WORDS.has(w) || (w === 'lens' && !EYE_WORDS.has(words[i - 1] ?? '')));
  const eye = words.some((w) => EYE_WORDS.has(w));
  return camera && eye;
}

/** The checked rails view for this topic, or null (then the server builds or finds a 3D model as before). */
export function matchRails(topic: string): RailsScene | null {
  for (const sc of CHECKED_RAILS) if (isCameraEyeTopic(topic, sc.triggers)) return sc;
  return null;
}

/** Step n (1-based) of a rails view with its column and the column's index, or null if there is no such step. */
export function railsStep(sc: RailsScene, n: number): { step: RailsStep; column: RailsColumn; index: number } | null {
  if (!Number.isInteger(n) || n < 1 || n > sc.steps.length) return null;
  const step = sc.steps[n - 1];
  const index = sc.columns.findIndex((c) => c.id === step.column);
  if (index < 0) return null;
  return { step, column: sc.columns[index], index };
}
