/**
 * The bridge between `shared/tokens.css` and code that cannot use a class.
 *
 * The simulator paints the device on a canvas, where `var(--ch-1)` means nothing, and the
 * admin panel tints a row from a channel token. Both read the token here instead of holding
 * a second copy of the hex, so tokens.css stays the only place a brand colour is written down.
 */

/** Button 1 left, 2 centre, 3 right — the order the logo mark's three circles run in. */
export const CHANNEL_TOKENS = ['--ch-1', '--ch-2', '--ch-3'] as const;

/** The same three lenses with the LED off. */
export const CHANNEL_OFF_TOKENS = ['--ch-1-off', '--ch-2-off', '--ch-3-off'] as const;

/**
 * Resolves a custom property off the document root.
 *
 * Stylesheets are render-blocking and this module runs from a deferred module script, so the
 * values are in place by the time anything calls it. The fallback is for the case that is not
 * a timing problem at all — a token that was renamed and a caller that was not.
 */
export function readToken(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value.length > 0 ? value : fallback;
}
