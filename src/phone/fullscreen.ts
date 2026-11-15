/**
 * Phone mode: full screen, held sideways.
 *  - Where the browser has the Fullscreen API for pages (Android, iPad, computers): a "Full screen" button
 *    (start screen and the settings sheet) asks for full screen without the browser's bars, then locks the
 *    screen sideways where the browser allows it. The button hides while the page is full screen and comes
 *    back if the user leaves it.
 *  - iPhone browsers (Safari and Chrome, same engine) have neither element full screen nor
 *    screen.orientation.lock: no button there. The start screen says how to get the same instead (Add to
 *    Home Screen; Portrait Orientation Lock with AssistiveTouch's Rotate Screen), without the full-screen line
 *    once it runs from the Home Screen icon.
 * The page is never turned with CSS: the glasses mirror the phone's real screen, so a turned page would show
 * sideways in them.
 */
import { useEffect, useState } from 'react';
import { showToast } from '../hud/hudStore';

/** The Fullscreen API for the page (missing on iPhone). */
export function fullscreenSupported(): boolean {
  return typeof document !== 'undefined' && typeof document.documentElement.requestFullscreen === 'function';
}

function fullscreenOn(): boolean {
  return typeof document !== 'undefined' && Boolean(document.fullscreenElement);
}

/** Opened from the Home Screen icon (iOS) or as an installed app: already without the browser's bars. */
export function isStandalone(): boolean {
  try {
    if ((navigator as unknown as { standalone?: boolean }).standalone === true) return true;
    return window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(display-mode: fullscreen)').matches;
  } catch {
    return false;
  }
}

/** Full screen, then sideways (both only where the browser allows; call from a tap). */
export async function enterFullscreen(): Promise<void> {
  if (!fullscreenSupported()) return;
  try {
    await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  } catch {
    showToast('Full screen was not allowed here.', 'warn', 4000);
    return;
  }
  try {
    const orientation = (screen as unknown as { orientation?: { lock?: (o: string) => Promise<void> } }).orientation;
    await orientation?.lock?.('landscape');
  } catch {
    /* not every browser locks the orientation (computers never do): full screen still holds */
  }
}

/** Whether the Full screen button should show: the API is there and the page is not full screen right now. */
export function useFullscreenButton(): boolean {
  const supported = fullscreenSupported();
  const [on, setOn] = useState(fullscreenOn);
  useEffect(() => {
    if (!supported) return;
    const update = () => setOn(fullscreenOn());
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, [supported]);
  return supported && !on;
}
