/**
 * Saved models (#97): a quiet row of small pills at the top left (the bottom centre is the voice
 * pill's, the middle is the model's), one per saved model with its picture (or a glyph for an eye,
 * a hand / the arm, or no picture) and its short name. Only while the overlay is on and nothing is
 * open or loading. A click brings it back (developer convenience: the wearer uses voice).
 * Each pill notes where its picture is (liftOut.ts, #109): a model brought back while its object is
 * not in view lifts out of its pill, and one put away with its object gone settles into it.
 * Kit look: the kit's quiet label pill and tokens; classic look: the classic pill classes.
 */
import { useLayoutEffect, useRef } from 'react';
import { useStore } from '../state/store';
import { notePillBox } from '../overlay/liftOut';
import { bringBack } from '../lib/flow';
import { useSaved } from '../lib/saved';
import type { SavedGlyph, SavedItem } from '../lib/saved';
import { KIT_LOOK } from './look';
import { shortName } from './names';

/** How many pills the row shows (newest first); the rest stay saved and can be asked for by voice. */
const ROW_MAX = 6;

const SAVED_CSS = `
.bf-saved { position: absolute; top: var(--bf-edge, 18px); left: var(--bf-edge, 18px); max-width: 44vw;
  display: flex; flex-wrap: wrap; gap: var(--bf-space-2, 8px); pointer-events: auto; }
.bf-saved__pill { appearance: none; -webkit-appearance: none; margin: 0; cursor: pointer; font-family: inherit;
  padding-left: var(--bf-space-1, 4px); gap: var(--bf-space-2, 8px); }
.bf-saved__pic { width: 28px; height: 28px; flex: 0 0 28px; border-radius: 999px; object-fit: cover; display: block; }
.bf-saved__glyph { width: 28px; height: 28px; flex: 0 0 28px; display: grid; place-items: center; border-radius: 999px;
  background: var(--bf-color-glass-soft, rgba(255, 255, 255, 0.12)); }
.bf-saved__glyph svg { width: 16px; height: 16px; stroke: currentColor; fill: none; stroke-width: 1.6;
  stroke-linecap: round; stroke-linejoin: round; }
`;

function Glyph({ kind }: { kind: SavedGlyph }) {
  return (
    <span className="bf-saved__glyph" aria-hidden="true">
      {kind === 'eye' ? (
        <svg viewBox="0 0 24 24">
          <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      ) : kind === 'hand' ? (
        <svg viewBox="0 0 24 24">
          <path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11m0-6.5v-1a1.5 1.5 0 0 1 3 0V11m0-5.5a1.5 1.5 0 0 1 3 0V12m0-3.5a1.5 1.5 0 0 1 3 0V15a7 7 0 0 1-7 7h-1a7 7 0 0 1-5.6-2.8L3.6 16a1.6 1.6 0 0 1 2.4-2.1L8 16" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24">
          <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" />
          <path d="M4 7.5l8 4.5 8-4.5M12 12v9" />
        </svg>
      )}
    </span>
  );
}

function Pill({ item }: { item: SavedItem }) {
  const name = shortName(item.name);
  const ref = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    // the round picture at the pill's left (4 px in, 28 px across)
    if (r && r.width > 0) notePillBox(item.id, { cx: r.left + 4 + 14, cy: r.top + r.height / 2, w: 28, h: 28 });
  });
  return (
    <button
      ref={ref}
      type="button"
      className={`bf-saved__pill ${KIT_LOOK ? 'bf-label-pill' : 'bf-pill bf-glass'}`}
      title={item.kind === 'live' ? `${item.name} (AI-estimated)` : item.name}
      onClick={() => void bringBack(item.id)}
    >
      {item.thumb ? <img className="bf-saved__pic" src={item.thumb} alt="" draggable={false} /> : <Glyph kind={item.glyph} />}
      <span>{name}</span>
    </button>
  );
}

export function SavedRow() {
  const items = useSaved((s) => s.items);
  const overlayOn = useStore((s) => s.overlayOn);
  const nothingOpen = useStore((s) => s.teardown === null && s.teardownStatus !== 'loading');
  if (!overlayOn || !nothingOpen || items.length === 0) return null;
  return (
    <div className={`bf-saved${KIT_LOOK ? ' bf-enter' : ''}`} data-xr-ui>
      <style>{SAVED_CSS}</style>
      {items.slice(0, ROW_MAX).map((i) => (
        <Pill key={i.id} item={i} />
      ))}
    </div>
  );
}

export default SavedRow;
