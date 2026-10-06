/** Which link targets the client will ever put in an href. Pure and DOM-free so node:test covers it. */

/** The only Obsidian action a link may use, and the only query keys it may carry. */
const OBSIDIAN_HOST = 'open';
const OBSIDIAN_KEYS = new Set(['vault', 'file']);

function isSafeObsidian(u: URL): boolean {
  if (u.host !== OBSIDIAN_HOST || (u.pathname !== '' && u.pathname !== '/') || u.username || u.password || u.hash) return false;
  const keys = [...u.searchParams.keys()];
  return keys.length > 0 && keys.every((k) => OBSIDIAN_KEYS.has(k)) && new Set(keys).size === keys.length;
}

/** `URL.parse` where the browser has it (Chrome 126+, Safari 18+), otherwise `new URL` in a try; null when unparseable either way. */
function parseUrl(raw: string): URL | null {
  if (typeof URL.parse === 'function') return URL.parse(raw);
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/**
 * True when a link target may be an href: http or https, or exactly `obsidian://open` with only `vault` and `file`.
 * Other Obsidian actions (new, daily, adv-uri, hook-get-address, ...) can write or run commands in the vault, so they never link.
 * Any whitespace or control character inside the URL is refused: URL parsing would silently drop it, a browser might too.
 */
export function isSafeUrl(url: string): boolean {
  const raw = url.trim();
  if (raw === '' || /[\s\u0000-\u001f\u007f]/.test(raw)) return false;
  const u = parseUrl(raw);
  if (u === null) return false;
  if (u.protocol === 'http:' || u.protocol === 'https:') return u.host !== '';
  return u.protocol === 'obsidian:' && isSafeObsidian(u);
}

/** The trimmed URL when it is safe to use as an href, otherwise undefined. */
export function safeHref(url: string | undefined): string | undefined {
  return url !== undefined && isSafeUrl(url) ? url.trim() : undefined;
}
