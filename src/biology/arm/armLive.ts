/**
 * Live link: feeds the app's tracked right hand into the arm's typing detector, so get_pose can say
 * "typing" from the real camera. Pose (shoulder / elbow / wrist) is not tracked by the app yet:
 * when it is, call setArmPose() with the 33 MediaPipe Pose landmarks each frame and the arm overlay
 * can be drawn live too (until then it draws from a replayed trace in /arm-demo).
 */
import { useStore } from '../../state/store';
import { feedArmLandmarks } from './trace';
import type { Landmark } from './types';

let pose: Landmark[] | null = null;

/** For the detection loop (Rio): latest MediaPipe Pose landmarks, or null when no person is tracked. */
export function setArmPose(p: Landmark[] | null) {
  pose = p;
}

let started = false;
export function startArmLive() {
  if (started) return;
  started = true;
  useStore.subscribe((s, prev) => {
    if (s.hands === prev.hands) return;
    const right = s.hands.find((h) => h.handedness === 'right') ?? s.hands[0];
    if (!right || right.landmarks.length < 21) return;
    feedArmLandmarks(pose, right.landmarks, right.handedness);
  });
}
