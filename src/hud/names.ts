/**
 * Display names for things in view: sentence case, no detector jargon, no percentages.
 * Hands are always "Left hand" / "Right hand"; an identified object shows its real name
 * (without the bracketed details), otherwise a friendly name for the detector class.
 */
import type { SceneObject } from '../state/store';

const FRIENDLY: Record<string, string> = {
  laptop: 'Laptop',
  'cell phone': 'Phone',
  hand: 'Hand',
  keyboard: 'Keyboard',
  mouse: 'Mouse',
  cup: 'Cup',
  bottle: 'Bottle',
  book: 'Book',
  tv: 'Screen',
  remote: 'Remote',
};

const MAX_LEN = 34;

/** "cell phone" -> "Phone"; unknown classes get a capital first letter. */
export function friendlyLabel(label: string): string {
  const l = label.trim().toLowerCase();
  if (FRIENDLY[l]) return FRIENDLY[l];
  return l ? l.charAt(0).toUpperCase() + l.slice(1) : 'Object';
}

/** "MacBook Air 13-inch (M3, 2024)" -> "MacBook Air 13-inch"; long names are cut at a word. */
export function shortName(name: string): string {
  let n = name.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  if (n.length > MAX_LEN) {
    const cut = n.slice(0, MAX_LEN);
    const sp = cut.lastIndexOf(' ');
    n = (sp > 12 ? cut.slice(0, sp) : cut).trim();
  }
  return n || name.trim();
}

export function displayName(o: Pick<SceneObject, 'id' | 'label' | 'name' | 'anchor'>): string {
  if (o.anchor === 'hand' || o.label === 'hand') {
    if (o.id === 'hand-left') return 'Left hand';
    if (o.id === 'hand-right') return 'Right hand';
    return 'Hand';
  }
  if (o.name && o.name.trim()) return shortName(o.name);
  return friendlyLabel(o.label);
}
