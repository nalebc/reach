// Scroll joystick tuning shared by ScrollHandle and its tests.
export const DEAD_ZONE = 6; // px of finger travel before scrolling starts
export const TRAVEL = 70; // px the thumb can move from the centre
export const TICK = 33; // ms between scroll events (~30 per second)
export const STEP = 120; // largest scroll per event, as the host accepts

// Further from the press point scrolls faster. Moving the finger down scrolls
// down the page, which is a negative dy on the host.
export function scrollSpeed(offset: number) {
  const distance = Math.abs(offset) - DEAD_ZONE;
  if (distance <= 0) return 0;
  return -Math.sign(offset) * Math.min(STEP, Math.round(distance ** 1.5 * 0.15));
}
