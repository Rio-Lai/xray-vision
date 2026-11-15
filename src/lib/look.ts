/**
 * #124, live objects in seconds: the client side of POST /api/sketch (one Claude look at the crop -> its
 * name and a solid parts list) and POST /api/enrich (the details afterwards). flow.ts decides when; this
 * file makes the calls and reads the answers. `?sketch=0` turns it off (the old identify-then-teardown path).
 * `?mock=1`: the fake bottle (src/detect/mock.ts) is sketched from a built-in answer, with no camera and no key.
 */
import { TeardownSchema, type IdentifyResponse, type Lens, type Teardown } from '../../shared/teardown';
import { SKETCH_EXAMPLES, expandSketch, type EnrichResponse } from '../../shared/sketch';
import { MOCK_MODE, urlParam } from '../camera/frame';
import type { SceneObject } from '../state/store';
import { api, isServerDown } from './api';

/** One look is on unless `?sketch=0`. */
export const SKETCH_ON = urlParam('sketch') !== '0';
/**
 * How long "analyse this" waits for the sketch before it goes the old way. The server gives up at 12 s
 * (SKETCH_TIMEOUT_MS in server/lib/claude.ts) and answers `fallback`; this is the backstop.
 */
export const SKETCH_TIMEOUT_MS = 14_000;
/** The ?mock=1 bottle's scene id (src/detect/mock.ts). */
export const MOCK_BOTTLE_ID = 'bottle-1';
/** The object_id of the ?mock=1 bottle's built-in sketch (shared/sketch.ts SKETCH_EXAMPLES.bottle). */
const MOCK_BOTTLE_OBJECT_ID = 'plastic-water-bottle-500ml';
/** The built-in sketch "takes" this long, so the loading state can be seen. */
const MOCK_SKETCH_MS = 900;
const MOCK_ENRICH_MS = 2500;

export type LookResult =
  /** a solid parts list to show now */
  | { kind: 'solid'; td: Teardown; ident: IdentifyResponse }
  /** a stored, checked object: open its list */
  | { kind: 'checked'; ident: IdentifyResponse }
  /** nothing clear in the crop */
  | { kind: 'unknown'; ident: IdentifyResponse }
  /** no key (mock mode on the server) */
  | { kind: 'mock' }
  /** our server is not running */
  | { kind: 'down' }
  /** failed, timed out or nothing usable: go the old way */
  | { kind: 'none' };

export const isMockBottle = (o: Pick<SceneObject, 'id'>): boolean => MOCK_MODE && o.id === MOCK_BOTTLE_ID;

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The built-in sketch of the ?mock=1 bottle (the prompt's own worked example, expanded as the server does). */
function mockBottleSketch(): LookResult {
  const out = expandSketch(JSON.parse(SKETCH_EXAMPLES.bottle));
  if (out.kind !== 'solid') return { kind: 'none' };
  return { kind: 'solid', td: out.td, ident: { object_id: out.td.object_id, name: out.td.name, confidence: out.confidence, summary: out.summary } };
}

/**
 * One look. `hint`: the detector's label or a name Claude already gave it; `objectId`: that name's id
 * (the server then answers from its kept sketch at once, with no Claude call).
 */
export async function sketchLook(
  crop: string | null,
  opts: { hint?: string; objectId?: string; lens?: Lens; mockBottle?: boolean },
): Promise<LookResult> {
  if (opts.mockBottle) {
    await wait(MOCK_SKETCH_MS);
    return mockBottleSketch();
  }
  if (!crop) return { kind: 'none' };
  const started = performance.now();
  try {
    const a = await api.sketch({ image: crop, hint: opts.hint, object_id: opts.objectId, lens: opts.lens }, { timeoutMs: SKETCH_TIMEOUT_MS });
    const secs = ((performance.now() - started) / 1000).toFixed(1);
    if (a.mock) return { kind: 'mock' };
    if (a.shortcut || a.fallback) {
      console.warn(`[look] sketch gave nothing usable after ${secs} s (${a.error ?? 'shortcut'}): the old way`);
      return { kind: 'none' };
    }
    const ident: IdentifyResponse = {
      object_id: String(a.object_id ?? 'object'),
      name: String(a.name ?? opts.hint ?? 'Unknown object'),
      confidence: typeof a.confidence === 'number' ? a.confidence : 0.7,
      summary: typeof a.summary === 'string' ? a.summary : '',
    };
    if (a.checked) return { kind: 'checked', ident };
    if (a.unknown) return { kind: 'unknown', ident };
    const parsed = TeardownSchema.safeParse(a);
    if (!parsed.success || parsed.data.layout !== 'solid') {
      console.warn('[look] sketch answer did not parse: the old way', parsed.success ? 'not solid' : parsed.error.issues.slice(0, 3));
      return { kind: 'none' };
    }
    console.info(`[look] ${parsed.data.object_id}: ${parsed.data.parts.length} solids in ${secs} s${a.cached ? ' (kept from before)' : ''}`);
    return { kind: 'solid', td: parsed.data, ident };
  } catch (err) {
    if (isServerDown(err)) return { kind: 'down' };
    console.warn('[look] sketch failed or timed out: the old way', err);
    return { kind: 'none' };
  }
}

/** Built-in details for the ?mock=1 bottle. */
const MOCK_DETAILS: Record<string, string> = {
  body: 'Blow-moulded from a heated PET preform, the wall is only a few tenths of a millimetre thick. Ribs or a petaloid base often stiffen it.',
  shoulder: 'The shoulder is the same piece of PET as the body, stretched less during moulding so it is a little thicker. It guides the flow into the neck.',
  neck: 'The neck keeps the shape of the original preform: it is not stretched, so its threads stay accurate enough for the cap to seal.',
  cap: 'Usually polypropylene or HDPE, with a tamper ring that breaks on first opening. A liner or a moulded lip presses on the neck to seal it.',
  label: 'A printed plastic film, wrapped and glued or shrunk on. It is often a different plastic from the bottle and is removed for recycling.',
  water: 'The contents. In a sealed bottle the pressure from the cap and the liquid helps the thin wall keep its shape.',
};

/** The details afterwards: POST /api/enrich (the ?mock=1 bottle: built in). Rejects on failure. */
export async function fetchDetails(td: Teardown): Promise<EnrichResponse> {
  if (MOCK_MODE && td.object_id === MOCK_BOTTLE_OBJECT_ID) {
    await wait(MOCK_ENRICH_MS);
    return {
      parts: td.parts.filter((p) => MOCK_DETAILS[p.id]).map((p) => ({ id: p.id, details: MOCK_DETAILS[p.id], safety: null })),
      steps: [
        { n: 1, text: 'Unscrew the cap and pour out the water.', part_ids: ['cap', 'water'] },
        { n: 2, text: 'Peel the label off from its glued seam.', part_ids: ['label'] },
        { n: 3, text: 'Squash the body flat and put the cap back on for recycling.', part_ids: ['body', 'cap'] },
      ],
    };
  }
  return api.enrich({
    object_id: td.object_id,
    name: td.name,
    parts: td.parts.map((p) => ({ id: p.id, name: p.name, summary: p.summary })),
  });
}
