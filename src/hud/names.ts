/**
 * Display names for things in view: sentence case, no detector jargon, no percentages.
 * Hands are always "Left hand" / "Right hand", eyes "Left eye" / "Right eye" (the person's own
 * left and right; src/detect/faceTracker.ts); an identified object shows its real name
 * (without the bracketed details), otherwise a friendly name for the detector class.
 */
import type { SceneObject } from '../state/store';

/** One per class in USEFUL_CLASSES (src/detect/mediapipe.ts), plus hands. */
const FRIENDLY: Record<string, string> = {
  laptop: 'Laptop',
  'cell phone': 'Phone',
  hand: 'Hand',
  eye: 'Eye',
  keyboard: 'Keyboard',
  mouse: 'Mouse',
  remote: 'Remote',
  tv: 'Screen',
  book: 'Book',
  clock: 'Clock',
  scissors: 'Scissors',
  cup: 'Cup',
  bottle: 'Bottle',
  bowl: 'Bowl',
  fork: 'Fork',
  knife: 'Knife',
  spoon: 'Spoon',
  banana: 'Banana',
  apple: 'Apple',
  orange: 'Orange',
  backpack: 'Backpack',
  handbag: 'Bag',
  umbrella: 'Umbrella',
  chair: 'Chair',
  'potted plant': 'Plant',
  vase: 'Vase',
  'teddy bear': 'Teddy bear',
  toothbrush: 'Toothbrush',
  'sports ball': 'Ball',
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
  if (o.anchor === 'face' && o.label === 'eye') {
    if (/^eye-left(-\d+)?$/.test(o.id)) return 'Left eye';
    if (/^eye-right(-\d+)?$/.test(o.id)) return 'Right eye';
    return 'Eye';
  }
  if (o.name && o.name.trim()) return shortName(o.name);
  return friendlyLabel(o.label);
}
