/**
 * THE CONTRACT. Shared by the browser app (src/) and the server (server/).
 * Do not change a field without telling the whole team (Rio, Rohan, Kash).
 */
import { z } from 'zod';

export const LensSchema = z.enum(['engineering', 'biology']);
export type Lens = z.infer<typeof LensSchema>;

/** What the overlay is pinned to. box = detector box, hand = hand landmarks, face = face landmarks. */
export const AnchorSchema = z.enum(['box', 'hand', 'face', 'pose']);
export type AnchorKind = z.infer<typeof AnchorSchema>;

export const PartShapeSchema = z.enum(['box', 'board', 'cylinder', 'sphere', 'tube']);
export type PartShape = z.infer<typeof PartShapeSchema>;

export const TeardownPartSchema = z.object({
  /** kebab-case, unique within the teardown, e.g. "battery" */
  id: z.string(),
  name: z.string(),
  /** 0 = outermost / closest to the camera. Higher = deeper inside. Sets explode order. */
  layer: z.number().int().min(0),
  /** [width, height, depth] as fractions of the anchor box (0..1). */
  size: z.tuple([z.number(), z.number(), z.number()]),
  /** [x, y] offset of the part centre from the anchor centre, as fractions of the anchor box (-0.5..0.5). */
  offset: z.tuple([z.number(), z.number()]),
  shape: PartShapeSchema,
  /** CSS hex colour for the placeholder shape. */
  color: z.string(),
  /** One sentence. Shown on the label card and read by the tutor. */
  summary: z.string(),
  /** 2-4 sentences for "tell me more". */
  details: z.string(),
  /** Safety note, or null if none. The tutor always mentions it. */
  safety: z.string().nullable().optional(),
  /** GLB from fal once generated; null until then (the app shows the placeholder shape). */
  mesh_url: z.string().nullable().optional(),
});
export type TeardownPart = z.infer<typeof TeardownPartSchema>;

export const TeardownStepSchema = z.object({
  n: z.number().int().min(1),
  text: z.string(),
  part_ids: z.array(z.string()),
});
export type TeardownStep = z.infer<typeof TeardownStepSchema>;

export const TeardownSchema = z.object({
  object_id: z.string(),
  name: z.string(),
  lens: LensSchema,
  anchor: AnchorSchema,
  explode_axis: z.enum(['x', 'y', 'z']),
  /** cached = pre-generated and checked; live = generated just now ("AI-estimated"). */
  source: z.enum(['cached', 'live']),
  parts: z.array(TeardownPartSchema).min(1),
  steps: z.array(TeardownStepSchema),
});
export type Teardown = z.infer<typeof TeardownSchema>;

/* ---------- API request / response shapes ---------- */

/** POST /api/identify */
export const IdentifyRequestSchema = z.object({
  /** base64 JPEG (no data: prefix) of the cropped object */
  image: z.string(),
  lens: LensSchema,
  /** detector's rough label, e.g. "laptop" or "hand" */
  hint: z.string().optional(),
});
export type IdentifyRequest = z.infer<typeof IdentifyRequestSchema>;

export const IdentifyResponseSchema = z.object({
  object_id: z.string(),
  name: z.string(),
  confidence: z.number().min(0).max(1),
  summary: z.string(),
});
export type IdentifyResponse = z.infer<typeof IdentifyResponseSchema>;

/** POST /api/teardown -> Teardown */
export const TeardownRequestSchema = z.object({
  object_id: z.string(),
  name: z.string(),
  lens: LensSchema,
});
export type TeardownRequest = z.infer<typeof TeardownRequestSchema>;

/** POST /api/generate-part */
export const GeneratePartRequestSchema = z.object({
  object_id: z.string(),
  part_id: z.string(),
  /** e.g. "isolated MacBook Air battery, studio product render, white background" */
  prompt: z.string(),
});
export type GeneratePartRequest = z.infer<typeof GeneratePartRequestSchema>;

export const GeneratePartResponseSchema = z.object({
  image_url: z.string(),
  mesh_url: z.string(),
  cached: z.boolean(),
});
export type GeneratePartResponse = z.infer<typeof GeneratePartResponseSchema>;

/** GET /api/agent-token -> { signed_url } for the ElevenLabs agent */
export const AgentTokenResponseSchema = z.object({ signed_url: z.string() });
export type AgentTokenResponse = z.infer<typeof AgentTokenResponseSchema>;

/**
 * The client tools the ElevenLabs agent can call. Names must match the ElevenLabs dashboard exactly.
 * set_overlay turns the labels on or off ("Hey Blowfish, overlay on").
 * set_lens is DEPRECATED (Blowfish has no lenses) and will be removed once nothing calls it:
 * do not add it to the dashboard.
 */
export const CLIENT_TOOL_NAMES = [
  'get_scene',
  'set_overlay',
  'select_object',
  'explode',
  'highlight_part',
  'show_step',
  'reset_view',
  'get_pose',
  'set_lens',
] as const;
export type ClientToolName = (typeof CLIENT_TOOL_NAMES)[number];
