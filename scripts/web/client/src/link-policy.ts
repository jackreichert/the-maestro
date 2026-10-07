/**
 * How the client opens a link: which `target` and `rel` accompany an href. Pure and DOM-free so node:test covers it.
 *
 * A page cannot choose the browser window a link opens in, only a browsing-context name. `_blank` opens a fresh tab on every click.
 * A named target reuses the tab that already holds that name, so a second click on the same item refocuses its tab instead of
 * adding a duplicate. Per the HTML spec, `noopener` and `noreferrer` make the browser skip the name lookup and always create a new
 * context, so reuse needs both left off. That leaves `window.opener` open to the destination, which is why only the hosts in
 * TRUSTED_HOSTS ever get a named target. Every other web link is `_blank` with `rel="noopener noreferrer"`.
 */

import { isSafeUrl } from './url.ts';

type Attrs = Record<string, string>;

/** A web host this client trusts enough to leave `window.opener` reachable from its pages, so a named tab can be reused. */
interface TrustedHost {
  name: string;
  /** True for a hostname this entry covers. */
  matches: (hostname: string) => boolean;
}

/** One kind of item a link can point at, and the tab name that item always opens in. */
interface TabRule {
  name: string;
  /** The tab name for this URL, or null when the rule does not apply. Only called on https URLs of a trusted host. */
  tab: (u: URL) => string | null;
}

const TRUSTED_HOSTS: TrustedHost[] = [
  { name: 'github', matches: (h) => h === 'github.com' },
  { name: 'atlassian-cloud', matches: (h) => h.endsWith('.atlassian.net') && h.length > '.atlassian.net'.length },
];

const PULL = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)\/?$/;
const TICKET = /^\/browse\/([A-Z][A-Z0-9_]*-\d+)\/?$/;

/** Tab names always start `podium-` (never `_`, which the spec reserves) and use only [A-Za-z0-9_.-]. */
const TAB_RULES: TabRule[] = [
  { name: 'pull-request', tab: (u) => { const m = PULL.exec(u.pathname); return m ? `podium-pr-${m[1]}-${m[2]}-${m[3]}` : null; } },
  { name: 'ticket', tab: (u) => { const m = TICKET.exec(u.pathname); return m ? `podium-ticket-${m[1]}` : null; } },
];

const SAFE_REL = 'noopener noreferrer';

function namedTab(u: URL): string | null {
  if (u.protocol !== 'https:' || !TRUSTED_HOSTS.some((t) => t.matches(u.hostname))) return null;
  for (const r of TAB_RULES) {
    const name = r.tab(u);
    if (name !== null) return name;
  }
  return null;
}

/**
 * The attributes for an anchor to `url`, or undefined when the URL is not safe to link at all.
 * Trusted pull-request and ticket URLs get a per-item tab name and no `rel`; other web links open a new tab with `noopener noreferrer`.
 * `obsidian://` links are handed to the OS, so they get no `target`.
 */
export function linkAttrs(url: string | undefined): Attrs | undefined {
  if (url === undefined || !isSafeUrl(url)) return undefined;
  const href = url.trim();
  const u = new URL(href);
  if (u.protocol === 'obsidian:') return { href, rel: SAFE_REL };
  const tab = namedTab(u);
  return tab === null ? { href, target: '_blank', rel: SAFE_REL } : { href, target: tab };
}
