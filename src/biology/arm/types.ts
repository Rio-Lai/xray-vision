/**
 * Types for the X-ray arm (public/cache/arm-hand/teardown.json).
 * This teardown has fields the shared TeardownSchema does not (landmarks, from/to, activities, layer_focus),
 * so the arm reads its own file instead of going through /api/teardown (which would drop them).
 */

export interface Landmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

/** One frame of tracking: 33 MediaPipe Pose landmarks + 21 Hand Landmarker landmarks (normalised image coords). */
export interface ArmFrame {
  /** ms since the start of a trace (or performance.now() live) */
  t: number;
  pose: Landmark[] | null;
  hand: Landmark[] | null;
  handedness?: 'left' | 'right';
}

export type FingerId = 'thumb' | 'index' | 'middle' | 'ring' | 'little';
export const FINGERS: FingerId[] = ['thumb', 'index', 'middle', 'ring', 'little'];

export interface Keystroke {
  finger: FingerId;
  /** press = fingertip dipped (flexors); lift = finger rose back (extensors) */
  kind: 'press' | 'lift';
  t: number;
}

export interface ArmPart {
  id: string;
  name: string;
  layer: number;
  shape: string;
  color: string;
  from: string;
  to: string;
  side?: string;
  summary: string;
  details: string;
  active_when: string[];
  nerve: string;
  safety: string;
  mesh_url: string | null;
  /** extra meshes for this part (reused bones/tendons per finger, two pronators...) */
  mesh_urls?: string[];
  mesh_source?: string;
}

export interface ArmStep {
  n: number;
  layer_focus: number;
  text: string;
  part_ids: string[];
}

export interface ActivityRole {
  part_id: string;
  intensity: number;
  role: string;
}

export interface ArmActivity {
  how_detected: string;
  summary: string;
  roles: ActivityRole[];
  nerves_involved: string[];
  clinical_note: string;
}

export interface ArmTeardown {
  object_id: string;
  name: string;
  anchor: string;
  mesh_source: string;
  notice: string;
  landmarks: { pose: Record<string, number>; hand: Record<string, number | number[]>; note: string };
  layers_legend: Record<string, string>;
  parts: ArmPart[];
  steps: ArmStep[];
  activities: Record<string, ArmActivity>;
}

export type Activity = 'typing' | 'none';

export interface TypingResult {
  activity: Activity;
  confidence: number;
  /** keystroke events found in the window (newest last) */
  keystrokes: Keystroke[];
  /** debug numbers, useful when tuning on the real rig */
  debug: { pronation: number; tapRate: number; wristStill: number; frames: number };
}

export const ARM_TEARDOWN_URL = '/cache/arm-hand/teardown.json';
export const ARM_TRACE_URL = '/cache/arm-hand/typing-trace.json';

let cached: Promise<ArmTeardown> | null = null;
export function loadArmTeardown(): Promise<ArmTeardown> {
  cached ??= fetch(ARM_TEARDOWN_URL).then((r) => {
    if (!r.ok) throw new Error(`arm teardown: HTTP ${r.status}`);
    return r.json() as Promise<ArmTeardown>;
  });
  return cached;
}
