/**
 * Checked by hand (Rohan, issue #146): how the iPhone 17 Pro's main camera matches the eye, in five steps.
 * Keep the wording exactly; the part ids are real (public/cache/iphone-17-pro.json and public/cache/eye.json).
 * Bundled into the app, so it opens with no server, no key and no network (shared/rails.ts).
 */
import type { RailsScene } from '../rails';

export const IPHONE_EYE: RailsScene = {
  id: 'iphone-17-pro__eye',
  kind: 'rails',
  title: 'How the iPhone camera matches your eye',
  summary: 'Both bend light through a lens onto a light-sensitive surface; they focus and control light in different ways.',
  source: 'checked',
  triggers: ['how does this camera link to my eye', 'how is this camera like my eye', 'compare the camera with my eye', 'iphone camera and the eye'],
  rails: [
    { id: 'iphone', label: 'iPhone', object_id: 'iphone-17-pro' },
    { id: 'eye', label: 'Eye', object_id: 'eye' },
  ],
  columns: [
    { id: 'window', iphone: { part_id: 'cameras', label: 'Sapphire cover' }, eye: { part_id: 'cornea', label: 'Cornea' } },
    { id: 'opening', iphone: { part_id: null, label: 'Fixed opening' }, eye: { part_id: 'iris', label: 'Iris' } },
    { id: 'focus', iphone: { part_id: 'main-camera-lens', label: 'Lens and focus coil' }, eye: { part_id: 'lens', label: 'Lens and ciliary muscle', also: ['ciliary-body'] } },
    { id: 'image', iphone: { part_id: 'main-camera-sensor', label: '48 MP sensor' }, eye: { part_id: 'retina', label: 'Retina' } },
    { id: 'meaning', iphone: { part_id: 'logic-board', label: 'A19 Pro' }, eye: { part_id: 'optic-nerve', label: 'Optic nerve' } },
  ],
  steps: [
    { column: 'window', say: 'Both start with a clear, tough front window: the sapphire cover and your cornea.' },
    { column: 'opening', say: "Your iris resizes the pupil to control light; the iPhone's lens has a fixed opening, so the chip adjusts the exposure instead." },
    { column: 'focus', say: 'Both focus with a lens: the iPhone slides its lens with a magnet and coil, your eye reshapes its lens with the ciliary muscle.' },
    { column: 'image', say: 'The image lands upside down on the 48-megapixel sensor, just as it does on your retina.' },
    { column: 'meaning', say: 'Then the A19 Pro and your brain turn it into a picture, and your brain flips it the right way up.' },
  ],
};
