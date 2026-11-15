/**
 * Phone mode (`?phone=1`): the page is laid out PHONE_VW CSS px wide (default 1400, `?vw=`, src/camera/frame.ts)
 * and the phone scales it to its screen, so it shows the laptop's layout, only smaller: about 1400 x 646 on an
 * iPhone 16 held sideways (0.61 real points per CSS px). index.html sets the viewport tag before anything is
 * drawn; applyPhoneViewport() sets it again (the same) and keeps --bf-pt up to date.
 *  - --bf-pt on <html>: one real screen point in CSS px (1.64px sideways, about 3.6px upright). The phone's own
 *    controls (start screen, gear, settings sheet, the "turn sideways" hint) are sized with it, so they stay the
 *    same size on the glass and easy to tap whatever the page width.
 *  - phoneSafeArea(): the safe area (the Dynamic Island's side, the home bar) in CSS px, as PhoneApp's CSS works
 *    it out (--bf-phone-left etc.), for the parts drawn from code (labels, the detail model).
 *  - isShortWide(): phone mode only (the view is short and wide there): the detail model gets the right 45
 *    percent of the view and a compact card (src/overlay/DetailStage.tsx, src/lib/detail.ts). Never on the
 *    laptop, whatever its window shape, so the laptop's detail layout stays as it was.
 *  - phoneGearBottom(): where the settings gear ends (PhoneApp.tsx), so the right label column starts below it.
 * Off the phone everything here returns the laptop's values and changes nothing.
 */
import { PHONE_MODE, PHONE_VW, screenPointsPerPx } from '../camera/frame';

/** No initial-scale: the phone fits PHONE_VW to its width, sideways and upright. */
export const PHONE_VIEWPORT = `width=${PHONE_VW}, viewport-fit=cover, user-scalable=no`;

/** Phone mode: the main model keeps the left 55 percent of the view beside a detail model, which has the rest. */
export const WIDE_DETAIL_SPLIT = 0.55;

/** The short wide layout for the detail view: phone mode only (the view size is not looked at). */
export function isShortWide(_vw: number, _vh: number): boolean {
  return PHONE_MODE;
}

let applied = false;

function updatePointSize(): void {
  const pt = 1 / screenPointsPerPx();
  document.documentElement.style.setProperty('--bf-pt', `${pt.toFixed(4)}px`);
}

/** Phone mode only: the viewport tag, html.bf-phone, and --bf-pt (kept up to date on resize and rotation). */
export function applyPhoneViewport(): void {
  if (!PHONE_MODE || applied || typeof document === 'undefined') return;
  applied = true;
  const meta = document.querySelector('meta[name="viewport"]');
  if (meta && meta.getAttribute('content') !== PHONE_VIEWPORT) meta.setAttribute('content', PHONE_VIEWPORT);
  document.documentElement.classList.add('bf-phone');
  updatePointSize();
  window.addEventListener('resize', updatePointSize);
  window.addEventListener('orientationchange', () => window.setTimeout(updatePointSize, 250));
  window.visualViewport?.addEventListener('resize', updatePointSize);
  // the phone may apply a changed viewport tag a moment later, without a resize event
  for (const ms of [100, 500, 1500]) window.setTimeout(updatePointSize, ms);
}

export interface SafeArea {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const NONE: SafeArea = { left: 0, right: 0, top: 0, bottom: 0 };
/** Phone mode: the bottom of the settings gear (CSS px; --bf-safe-top + --bf-phone-gear); 0 off the phone. */
let gearBottom = 0;
/** Measured again after this long (ms) or when the view changes size. */
const SAFE_REFRESH_MS = 1000;
let probe: HTMLDivElement | null = null;
let safe: SafeArea = NONE;
let safeKey = '';
let safeAt = -Infinity;

/**
 * Phone mode: how far from each edge content must stay (CSS px; PhoneApp's --bf-phone-left / right / top /
 * bottom: the safe area, at least a small margin). All 0 off the phone. Cheap to call every frame.
 */
export function phoneSafeArea(): SafeArea {
  if (!PHONE_MODE || typeof document === 'undefined' || !document.body) return NONE;
  const key = `${window.innerWidth}x${window.innerHeight}`;
  const now = performance.now();
  if (key === safeKey && now - safeAt < SAFE_REFRESH_MS) return safe;
  if (!probe) {
    probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    Object.assign(probe.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: '0',
      height: '0',
      boxSizing: 'content-box',
      visibility: 'hidden',
      pointerEvents: 'none',
      paddingLeft: 'var(--bf-phone-left, 0px)',
      paddingRight: 'var(--bf-phone-right, 0px)',
      paddingTop: 'var(--bf-phone-top, 0px)',
      paddingBottom: 'var(--bf-phone-bottom, 0px)',
      marginTop: 'var(--bf-safe-top, 0px)',
      marginLeft: 'var(--bf-phone-gear, 0px)',
    });
    document.body.appendChild(probe);
  }
  const cs = getComputedStyle(probe);
  safe = {
    left: parseFloat(cs.paddingLeft) || 0,
    right: parseFloat(cs.paddingRight) || 0,
    top: parseFloat(cs.paddingTop) || 0,
    bottom: parseFloat(cs.paddingBottom) || 0,
  };
  gearBottom = (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginLeft) || 0);
  safeKey = key;
  safeAt = now;
  return safe;
}

/** Phone mode: the wider of the left and right safe margins (sideways the Dynamic Island can be on either side). */
export function phoneSafeX(): number {
  const s = phoneSafeArea();
  return Math.max(s.left, s.right);
}

/** Phone mode: the bottom edge of the settings gear at the top right (CSS px, about 72 sideways); 0 off the phone. */
export function phoneGearBottom(): number {
  phoneSafeArea();
  return PHONE_MODE ? gearBottom : 0;
}
