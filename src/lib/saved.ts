/**
 * Saved models (#97, step 3 of the journey in docs/PROJECT.md section 1): "put it away" keeps what
 * was open so it can be brought back later, even when the object is no longer in view.
 *
 *  - One entry per parts-list object_id, newest first, at most SAVED_MAX. Re-saving moves it to the top.
 *  - thumb: a small JPEG data URL (about THUMB_PX) of the object's crop, taken when it was analysed
 *    (flow.ts calls noteAnalysedShot), never at put-away time. Never for an eye, a hand / the arm, or
 *    anything that looks like a person: those show a glyph instead.
 *  - A live (AI-estimated) parts list is kept whole for the session and, if it fits, in localStorage
 *    (oldest live lists are dropped first when the quota is hit), so reopening needs no Claude.
 *  - The in-memory list is the source of truth; localStorage is best effort (private mode, quota).
 *  - `?saved=clear` forgets everything (developer only; there is no UI for it).
 *
 * Bringing a saved model back is flow.ts (bringBack, resolveSavedObjectId): it pins a scene object
 * the way src/detect/centre.ts and src/stage/eyeTeardown.ts do.
 */
import { create } from 'zustand';
import { TeardownSchema } from '../../shared/teardown';
import type { AnchorKind, Lens, Teardown } from '../../shared/teardown';
import type { Box } from '../state/store';
import { shortName } from '../hud/names';
import { DEMO_IDENTIFY } from '../../shared/demo';

/** object_id of Kash's stored eye. */
const EYE_ID = DEMO_IDENTIFY.eye.object_id;

export const SAVED_MAX = 12;
/** Longest side of a thumbnail, in pixels. */
export const THUMB_PX = 96;

const LIST_KEY = 'blowfish.saved.v1';
const PARTS_KEY = 'blowfish.saved.parts.v1.';

/** What is drawn when there is no picture. */
export type SavedGlyph = 'eye' | 'hand' | 'object';

export interface SavedItem {
  /** Parts-list object_id ("macbook-air-m3-13", "arm-hand", "eye", or a live id). */
  id: string;
  name: string;
  /** stored = a checked parts list from public/cache/; live = AI-estimated. */
  kind: 'stored' | 'live';
  savedAt: number;
  /** data:image/jpeg;base64,... (about THUMB_PX), or null (eye, hand / arm, person, or no frame). */
  thumb: string | null;
  glyph: SavedGlyph;
  /** For bringing it back: the parts list's anchor and lens, and the scene object's label and box when it was open. */
  anchor: AnchorKind;
  lens: Lens;
  label: string;
  box: Box;
}

/** Never keep a picture of a person (the eye and the hand / arm are excluded by anchor and lens too). */
const PERSON = /\b(person|people|man|woman|men|women|boy|girl|child|baby|face|head|human|selfie)\b/i;

const isBox = (b: unknown): b is Box =>
  !!b && typeof b === 'object' && ['x', 'y', 'w', 'h'].every((k) => Number.isFinite((b as Record<string, unknown>)[k]));

function isItem(v: unknown): v is SavedItem {
  const o = v as Partial<SavedItem> | null;
  return (
    !!o &&
    typeof o.id === 'string' &&
    o.id !== '' &&
    typeof o.name === 'string' &&
    (o.kind === 'stored' || o.kind === 'live') &&
    typeof o.savedAt === 'number' &&
    (o.thumb === null || (typeof o.thumb === 'string' && o.thumb.startsWith('data:image/'))) &&
    (o.glyph === 'eye' || o.glyph === 'hand' || o.glyph === 'object') &&
    typeof o.anchor === 'string' &&
    (o.lens === 'engineering' || o.lens === 'biology') &&
    typeof o.label === 'string' &&
    isBox(o.box)
  );
}

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

function wantsClear(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('saved') === 'clear';
  } catch {
    return false;
  }
}

function readList(): SavedItem[] {
  const ls = storage();
  if (!ls) return [];
  try {
    const raw = JSON.parse(ls.getItem(LIST_KEY) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.filter(isItem).slice(0, SAVED_MAX) : [];
  } catch {
    return [];
  }
}

function writeList(items: SavedItem[]): void {
  const ls = storage();
  if (!ls) return;
  try {
    ls.setItem(LIST_KEY, JSON.stringify(items));
  } catch {
    // Quota: keep the list without pictures rather than nothing.
    try {
      ls.setItem(LIST_KEY, JSON.stringify(items.map((i) => ({ ...i, thumb: null }))));
    } catch {
      /* memory only this session */
    }
  }
}

function removeParts(id: string): void {
  try {
    storage()?.removeItem(PARTS_KEY + id);
  } catch {
    /* ignore */
  }
}

/** Forget everything, in memory and in the browser. */
export function clearSaved(): void {
  const ls = storage();
  if (ls) {
    try {
      for (let i = ls.length - 1; i >= 0; i--) {
        const k = ls.key(i);
        if (k && (k === LIST_KEY || k.startsWith(PARTS_KEY))) ls.removeItem(k);
      }
    } catch {
      /* ignore */
    }
  }
  liveLists.clear();
  useSaved.setState({ items: [] });
}

/** Live parts lists kept for this session, by object_id. */
const liveLists = new Map<string, Teardown>();

/** The saved list for React (newest first). */
export const useSaved = create<{ items: SavedItem[] }>(() => ({ items: wantsClear() ? [] : readList() }));
if (wantsClear()) clearSaved();

export const savedItems = (): SavedItem[] => useSaved.getState().items;

function setItems(items: SavedItem[]): void {
  const kept = items.slice(0, SAVED_MAX);
  for (const old of items.slice(SAVED_MAX)) {
    if (!kept.some((k) => k.id === old.id)) {
      liveLists.delete(old.id);
      removeParts(old.id);
    }
  }
  useSaved.setState({ items: kept });
  writeList(kept);
}

/** Keep a live parts list in localStorage; on a full quota drop the oldest other live lists first. */
function persistParts(td: Teardown): void {
  const ls = storage();
  if (!ls) return;
  const value = JSON.stringify(td);
  const victims = savedItems()
    .filter((i) => i.kind === 'live' && i.id !== td.object_id)
    .map((i) => i.id)
    .reverse(); // oldest first
  for (;;) {
    try {
      ls.setItem(PARTS_KEY + td.object_id, value);
      return;
    } catch {
      const v = victims.shift();
      if (v === undefined) return; // does not fit: memory only this session
      removeParts(v);
    }
  }
}

/** A kept live parts list (memory, else localStorage), or null. */
export function keptTeardown(id: string): Teardown | null {
  const mem = liveLists.get(id);
  if (mem) return mem;
  try {
    const raw = storage()?.getItem(PARTS_KEY + id);
    if (!raw) return null;
    const parsed = TeardownSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || parsed.data.object_id !== id) return null;
    liveLists.set(id, parsed.data);
    return parsed.data;
  } catch {
    return null;
  }
}

/* ---------- the picture taken when an object is analysed ---------- */

let shotSeq = 0;
/** The latest analysed object's thumbnail, by scene id. `thumb` is null until it is ready (or if it failed). */
let shot: { seq: number; sceneId: string; thumb: string | null } | null = null;

/** Scale a base64 JPEG (no data: prefix) down to THUMB_PX on its longest side. */
function shrink(base64: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => {
        try {
          const k = Math.min(1, THUMB_PX / Math.max(1, img.naturalWidth, img.naturalHeight));
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(img.naturalWidth * k));
          c.height = Math.max(1, Math.round(img.naturalHeight * k));
          const ctx = c.getContext('2d');
          if (!ctx) return resolve(null);
          ctx.drawImage(img, 0, 0, c.width, c.height);
          resolve(c.toDataURL('image/jpeg', 0.72));
        } catch {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = `data:image/jpeg;base64,${base64}`;
    } catch {
      resolve(null);
    }
  });
}

/** Whether a picture may be kept: a box object that is not biology and not named like a person. */
export function mayKeepPicture(anchor: AnchorKind, lens: Lens, ...names: (string | undefined)[]): boolean {
  return anchor === 'box' && lens !== 'biology' && !names.some((n) => !!n && PERSON.test(n));
}

/**
 * flow.ts, when an object is analysed: its crop (base64 JPEG, or null when no picture may be kept)
 * becomes the thumbnail if that object is later put away.
 */
export function noteAnalysedShot(sceneId: string, base64: string | null): void {
  const seq = ++shotSeq;
  shot = { seq, sceneId, thumb: null };
  if (!base64) return;
  void shrink(base64).then((thumb) => {
    if (!thumb) return;
    if (shot && shot.seq === seq) shot.thumb = thumb;
    // Put away before the picture was ready: fill it in now.
    patchThumb(sceneId, thumb);
  });
}

/** Entries saved before their picture was ready, by scene id. */
const awaitingThumb = new Map<string, string>();

function patchThumb(sceneId: string, thumb: string): void {
  const id = awaitingThumb.get(sceneId);
  if (!id) return;
  awaitingThumb.delete(sceneId);
  setItems(savedItems().map((i) => (i.id === id ? { ...i, thumb } : i)));
}

/* ---------- saving ---------- */

/**
 * Save the open parts list (flow.ts resetAll, before the view is reset). `sceneId` / `label` / `box`:
 * the scene object it came out of. Returns the entry, now first in the list.
 */
export function saveOpened(td: Teardown, scene: { id: string | null; label?: string; name?: string; box?: Box }): SavedItem {
  const prev = savedItems().find((i) => i.id === td.object_id);
  const glyph: SavedGlyph = td.object_id === EYE_ID || td.anchor === 'face' ? 'eye' : td.anchor === 'hand' ? 'hand' : 'object';
  const allowed = glyph === 'object' && mayKeepPicture(td.anchor, td.lens, td.name, scene.label, scene.name);
  const fresh = allowed && shot && scene.id && shot.sceneId === scene.id ? shot : null;
  const thumb = allowed ? fresh?.thumb ?? prev?.thumb ?? null : null;
  if (allowed && fresh && !fresh.thumb && scene.id) awaitingThumb.set(scene.id, td.object_id);
  const item: SavedItem = {
    id: td.object_id,
    name: td.name,
    kind: td.source === 'live' ? 'live' : 'stored',
    savedAt: Date.now(),
    thumb,
    glyph,
    anchor: td.anchor,
    lens: td.lens,
    label: scene.label ?? prev?.label ?? td.name,
    box: scene.box ? { ...scene.box } : prev?.box ?? { x: 0.35, y: 0.3, w: 0.3, h: 0.4 },
  };
  if (item.kind === 'live') {
    liveLists.set(item.id, td);
    persistParts(td);
  }
  setItems([item, ...savedItems().filter((i) => i.id !== item.id)]);
  return item;
}

/* ---------- finding one ---------- */

const STOP = new Set([
  'the', 'this', 'that', 'my', 'me', 'it', 'its', 'again', 'back', 'bring', 'show', 'open', 'reopen', 'one', 'please',
  'saved', 'model', 'thing', 'object', 'item', 'and', 'with', 'of',
]);

/** "Bring back the Watch!" -> ["watch"]. */
export function queryWords(q: string): string[] {
  return q
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length >= 2 && !STOP.has(w));
}

const words = (s: string) => new Set(queryWords(s));

/**
 * The saved entry `query` means: an exact id or name (case-insensitive), else the newest entry whose
 * id, name or label contains every word of the query ("macbook", "the eye", "bring back the watch").
 */
export function findSaved(query: string): SavedItem | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const items = savedItems();
  const exact = items.find((i) => i.id.toLowerCase() === q || i.name.toLowerCase() === q || shortName(i.name).toLowerCase() === q);
  if (exact) return exact;
  const want = queryWords(q);
  if (want.length === 0) return null;
  return (
    items.find((i) => {
      const have = new Set([...words(i.id), ...words(i.name), ...words(i.label)]);
      // a plural asks for the same thing ("the watches", "eyes")
      return want.every((w) => have.has(w) || (w.endsWith('s') && have.has(w.slice(0, -1))) || (w.endsWith('es') && have.has(w.slice(0, -2))));
    }) ?? null
  );
}

/** "just now", "4 min ago", "2 h ago", "3 days ago". */
export function savedAgo(at: number, now = Date.now()): string {
  const s = Math.max(0, (now - at) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return d === 1 ? '1 day ago' : `${d} days ago`;
}

/** For get_scene: what the tutor can offer to bring back. */
export function describeSaved(): { id: string; name: string; saved_ago: string }[] {
  const now = Date.now();
  return savedItems().map((i) => ({ id: i.id, name: i.name, saved_ago: savedAgo(i.savedAt, now) }));
}
