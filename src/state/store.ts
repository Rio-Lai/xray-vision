/**
 * The single app store. Every module talks through this:
 *  - detect/   writes `objects`, `focusedObjectId`, `hands`
 *  - overlay/  reads `teardown`, `explodeAmount`, `highlightedPartId`, `activeStep`, `frozen`
 *  - voice/    calls the actions (via src/voice/clientTools.ts)
 *  - lib/flow  loads teardowns and meshes
 * Do not change a field's meaning without telling the team.
 */
import { create } from 'zustand';
import type { AnchorKind, Lens, Teardown } from '../../shared/teardown';

/** Normalised to the video frame: 0..1, origin top-left. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SceneObject {
  /** Stable while the object stays in view, e.g. "laptop-1", "hand-right". */
  id: string;
  /** Detector label: "laptop", "cell phone", "hand", ... */
  label: string;
  /** Specific name once /api/identify has answered, e.g. "MacBook Air M3". */
  name?: string;
  confidence: number;
  box: Box;
  lens: Lens;
  anchor: AnchorKind;
}

export type FingerName = 'thumb' | 'index' | 'middle' | 'ring' | 'pinky';

export interface FingerState {
  /** 0 = straight, 1 = fully curled. */
  curl: number;
  /** true while the fingertip is moving down / pressing (e.g. a key press). */
  pressing: boolean;
}

export interface HandState {
  handedness: 'left' | 'right';
  /** 21 MediaPipe hand landmarks, normalised to the frame (x, y in 0..1; z relative). */
  landmarks: { x: number; y: number; z: number }[];
  fingers: Record<FingerName, FingerState>;
  /** The finger that most recently pressed, if any. */
  activeFinger: FingerName | null;
}

/**
 * Where a model is drawn.
 * stage  = floating in the middle of the view over the live camera feed (the product's main mode).
 * freeze = the frame freezes and the parts sit over the frozen object (fallback).
 * follow = the parts follow the object's box live (fallback; hands always follow).
 */
export type TrackingMode = 'stage' | 'freeze' | 'follow';
export type TeardownStatus = 'idle' | 'loading' | 'ready' | 'error';
export type VoiceStatus = 'disconnected' | 'connecting' | 'connected';

export interface TranscriptLine {
  role: 'user' | 'agent';
  text: string;
}

/** Registered by the camera module so other modules can grab pixels. */
export interface CameraApi {
  /** base64 JPEG (no data: prefix) of the given box from the current (or frozen) frame; null if no frame. */
  captureCrop: (box: Box) => string | null;
}

export interface AppState {
  /**
   * false = clean passthrough: the camera view with nothing drawn on it (the default).
   * true  = Blowfish is "on": detected things get labels and can be exploded.
   * Toggled by voice ("Hey Blowfish, overlay on") through the set_overlay tool.
   */
  overlayOn: boolean;
  objects: SceneObject[];
  /** Object under the centre gaze reticle. This is what "this" means in "explode this". */
  focusedObjectId: string | null;
  selectedObjectId: string | null;
  hands: HandState[];

  teardown: Teardown | null;
  teardownStatus: TeardownStatus;
  teardownError: string | null;

  /** 0 = assembled, 1 = fully exploded. The overlay animates towards this. */
  explodeAmount: number;
  highlightedPartId: string | null;
  activeStep: number | null;

  frozen: boolean;
  trackingMode: TrackingMode;
  /**
   * Target orientation of the model on stage, in radians (yaw = turn left/right, pitch = tip up/down).
   * Hand gestures and the rotate_model voice tool write it; the overlay eases towards it.
   */
  modelYaw: number;
  modelPitch: number;
  /**
   * How big the model on stage is drawn: 1 = the normal stage size, MODEL_ZOOM_MIN..MODEL_ZOOM_MAX.
   * Hand gestures, the mouse and the zoom_model voice tool write it; every stage renderer
   * (box rig, arm, eye) multiplies its size by it and eases towards it.
   */
  modelZoom: number;

  voiceStatus: VoiceStatus;
  agentSpeaking: boolean;
  transcript: TranscriptLine[];

  camera: CameraApi | null;

  // ---- actions ----
  setOverlayOn: (on: boolean) => void;
  setObjects: (objects: SceneObject[]) => void;
  setFocusedObject: (id: string | null) => void;
  setHands: (hands: HandState[]) => void;
  patchObject: (id: string, patch: Partial<SceneObject>) => void;

  selectObject: (id: string | null) => void;
  setTeardown: (teardown: Teardown | null) => void;
  setTeardownStatus: (status: TeardownStatus, error?: string | null) => void;
  /** Used when a fal mesh finishes: swaps the placeholder for the GLB. */
  setPartMesh: (partId: string, meshUrl: string) => void;

  setExplode: (amount: number) => void;
  highlightPart: (partId: string | null) => void;
  showStep: (n: number | null) => void;
  setFrozen: (frozen: boolean) => void;
  setTrackingMode: (mode: TrackingMode) => void;
  /** Add to the model's target orientation (radians). Pitch is clamped to about +-70 degrees. */
  rotateModel: (dYaw: number, dPitch: number) => void;
  /** Multiply the model's zoom by `factor` (clamped to MODEL_ZOOM_MIN..MODEL_ZOOM_MAX). */
  zoomModel: (factor: number) => void;
  /** Set the model's zoom (clamped). 1 = the normal stage size. */
  setModelZoom: (zoom: number) => void;
  /** Collapse, clear the selection, unfreeze. */
  resetView: () => void;

  setVoiceStatus: (status: VoiceStatus) => void;
  setAgentSpeaking: (speaking: boolean) => void;
  addTranscript: (line: TranscriptLine) => void;

  registerCamera: (api: CameraApi | null) => void;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Limits for `modelZoom`: half the normal stage size up to four times it. */
export const MODEL_ZOOM_MIN = 0.5;
export const MODEL_ZOOM_MAX = 4;
const clampZoom = (n: number) => (Number.isFinite(n) ? Math.min(MODEL_ZOOM_MAX, Math.max(MODEL_ZOOM_MIN, n)) : 1);

export const useStore = create<AppState>((set) => ({
  overlayOn: false,
  objects: [],
  focusedObjectId: null,
  selectedObjectId: null,
  hands: [],

  teardown: null,
  teardownStatus: 'idle',
  teardownError: null,

  explodeAmount: 0,
  highlightedPartId: null,
  activeStep: null,

  frozen: false,
  trackingMode: 'stage',
  modelYaw: 0,
  modelPitch: 0,
  modelZoom: 1,

  voiceStatus: 'disconnected',
  agentSpeaking: false,
  transcript: [],

  camera: null,

  setOverlayOn: (overlayOn) => set({ overlayOn }),
  setObjects: (objects) => set({ objects }),
  setFocusedObject: (focusedObjectId) => set({ focusedObjectId }),
  setHands: (hands) => set({ hands }),
  patchObject: (id, patch) =>
    set((s) => ({ objects: s.objects.map((o) => (o.id === id ? { ...o, ...patch } : o)) })),

  selectObject: (selectedObjectId) => set({ selectedObjectId }),
  setTeardown: (teardown) =>
    set({ teardown, teardownStatus: teardown ? 'ready' : 'idle', teardownError: null }),
  setTeardownStatus: (teardownStatus, error = null) => set({ teardownStatus, teardownError: error }),
  setPartMesh: (partId, meshUrl) =>
    set((s) =>
      s.teardown
        ? {
            teardown: {
              ...s.teardown,
              parts: s.teardown.parts.map((p) => (p.id === partId ? { ...p, mesh_url: meshUrl } : p)),
            },
          }
        : {},
    ),

  setExplode: (amount) => set({ explodeAmount: clamp01(amount) }),
  highlightPart: (highlightedPartId) => set({ highlightedPartId }),
  showStep: (activeStep) => set({ activeStep }),
  setFrozen: (frozen) => set({ frozen }),
  setTrackingMode: (trackingMode) => set({ trackingMode }),
  rotateModel: (dYaw, dPitch) =>
    set((s) => ({
      modelYaw: s.modelYaw + dYaw,
      modelPitch: Math.min(1.2, Math.max(-1.2, s.modelPitch + dPitch)),
    })),
  zoomModel: (factor) => set((s) => ({ modelZoom: clampZoom(s.modelZoom * (Number.isFinite(factor) && factor > 0 ? factor : 1)) })),
  setModelZoom: (zoom) => set({ modelZoom: clampZoom(zoom) }),
  resetView: () =>
    set({
      selectedObjectId: null,
      teardown: null,
      teardownStatus: 'idle',
      teardownError: null,
      explodeAmount: 0,
      highlightedPartId: null,
      activeStep: null,
      frozen: false,
      modelYaw: 0,
      modelPitch: 0,
      modelZoom: 1,
    }),

  setVoiceStatus: (voiceStatus) => set({ voiceStatus }),
  setAgentSpeaking: (agentSpeaking) => set({ agentSpeaking }),
  addTranscript: (line) => set((s) => ({ transcript: [...s.transcript.slice(-19), line] })),

  registerCamera: (camera) => set({ camera }),
}));
