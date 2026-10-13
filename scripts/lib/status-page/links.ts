/** Links the status page and the reply footer share: Obsidian URIs and tracker URLs. Pure; the settings are passed in. */
import { existsSync, realpathSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { PODIUM_FILE } from './seen.ts';

/** `obsidian://open?vault=<vault>&file=<vault-relative path without .md>`. */
export const obsidianUri = (vaultName: string, file: string): string =>
  `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(file)}`;

/** The URI of the Podium note in `<statusDir>`: an explicit `explicit` wins, else it is derived from the vault root. Empty when neither works. */
export function statusPageUri({ explicit, statusDir, vaultRoot, vaultName }: { explicit: string; statusDir: string; vaultRoot: string; vaultName: string }): string {
  if (explicit) return explicit;
  if (!statusDir || !vaultRoot || !vaultName) return '';
  const rel = relative(vaultRoot, statusDir);
  if (!rel || rel.startsWith('..') || rel.startsWith(sep)) return '';
  return obsidianUri(vaultName, `${rel.split(sep).join('/')}/${PODIUM_FILE.replace(/\.md$/, '')}`);
}

/** The Podium web link inside `uri` (the footer value): the uri itself when it is http(s), else empty (an `obsidian://` note link is not a server). */
export const podiumWebUrl = (uri: string): string => (/^https?:\/\//i.test(uri) ? uri : '');

/** The reply-footer line, or none. */
export const statusPageFooter = (uri: string): string[] => (uri ? [`**Podium:** ${uri}`] : []);

/** The vault-relative note path of a ticket id from a template with `{id}` and `{prefix}` (the id minus its trailing number). */
export const ticketNotePath = (template: string, id: string): string => template.replace(/\{id\}/g, id).replace(/\{prefix\}/g, id.replace(/-\d+$/, ''));

/** What `linkNotePaths` needs: the vault name, the projects a bare path may belong to (most likely first), and whether a vault-relative `.md` path exists. */
export interface NoteLinkEnv { vaultName: string; projects: string[]; exists: (vaultPath: string) => boolean }

const NOTE_PATH = /(?<![\w./:@-])(?:[\w.-]+\/)*[\w.-]+\.md(?![\w/])/g;
/** Files that hold secrets, whatever the extension, are never linked. */
const secretName = (path: string): boolean => path.split('/').some((seg) => /^\.env/i.test(seg) || /^ssm-.*\.json/i.test(seg));

/** Folders a project's notes live in: a path that names the wrong one of them is looked for in the others. */
const NOTE_DIRS = ['Plans', 'Research', 'Reviews', 'Runbooks', 'Knowledge', 'Archive'];

/**
 * The vault-relative `.md` path `raw` names, as given or under `Projects/<project>/`, when it exists; else null.
 * A path that names a folder (`Research/x.md`) but whose note sits in a sibling folder of the same project (`Plans/x.md`) resolves to
 * that note, so a writer's wrong folder does not leave a dead link. A bare file name is never searched for.
 */
function resolveNote(raw: string, env: NoteLinkEnv): string | null {
  if (raw.startsWith('/') || raw.includes('\\') || raw.split('/').some((seg) => seg === '..' || seg === '.') || secretName(raw)) return null;
  const projects = raw.startsWith('Projects/') ? [raw.split('/')[1] ?? ''] : env.projects.filter(Boolean);
  const candidates = raw.startsWith('Projects/') ? [raw] : [raw, ...projects.map((p) => `Projects/${p}/${raw}`)];
  const hit = candidates.find((c) => env.exists(c));
  if (hit || !raw.includes('/')) return hit ?? null;
  const base = raw.slice(raw.lastIndexOf('/') + 1);
  const siblings = projects.flatMap((p) => NOTE_DIRS.map((d) => `Projects/${p}/${d}/${base}`));
  return siblings.find((c) => c !== raw && env.exists(c)) ?? null;
}

/** An `obsidian://open` URI in free text: up to whitespace, an angle bracket or a quote. Trailing sentence punctuation is trimmed by `trimUri`. */
const OBSIDIAN_URI = /obsidian:\/\/open\?[^\s<>"'`]+/g;
const trimUri = (raw: string): string => raw.replace(/[.,;:!?)\]}]+$/, '');

/** The vault-relative `.md` path an `obsidian://open?vault=<this vault>&file=<path>` URI names, when that note exists (see `resolveNote`); else null. Encoded slashes (`%2F`) are decoded by the URL parser. */
export function noteOfUri(uri: string, env: NoteLinkEnv): string | null {
  let u: URL;
  try { u = new URL(uri); } catch { return null; }
  if (u.protocol !== 'obsidian:' || u.host !== 'open' || u.searchParams.get('vault') !== env.vaultName) return null;
  const file = u.searchParams.get('file');
  return file ? resolveNote(file.endsWith('.md') ? file : `${file}.md`, env) : null;
}

/**
 * `text` with each `obsidian://open` URI for this vault that names an existing note replaced by that note's vault path, so
 * `linkNotePaths` can turn it into the page's own link. Other URIs are left alone for the caller's link filter to drop.
 */
export function uriToNotePaths(text: string, env: NoteLinkEnv | undefined): string {
  if (!env?.vaultName) return text;
  return text.replace(OBSIDIAN_URI, (raw) => {
    const uri = trimUri(raw);
    const path = noteOfUri(uri, env);
    return path && new RegExp(`^${NOTE_PATH.source}$`).test(path) ? path + raw.slice(uri.length) : raw;
  });
}

/**
 * `text` with each vault-relative `*.md` path that exists in the vault turned into a Markdown link to its `obsidian://open` URI;
 * `esc` escapes every other stretch (and the link labels). Paths that do not resolve, or name a secret file, stay plain text.
 */
export function linkNotePaths(text: string, env: NoteLinkEnv | undefined, esc: (s: string) => string): string {
  if (!env?.vaultName) return esc(text);
  let out = '';
  let last = 0;
  for (const m of text.matchAll(NOTE_PATH)) {
    const found = resolveNote(m[0], env);
    if (!found) continue;
    out += `${esc(text.slice(last, m.index))}[${esc(m[0])}](${obsidianUri(env.vaultName, found.replace(/\.md$/, ''))})`;
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

/** The vault root: `configured` when set, else the part of the status directory before `/Projects/<project>/Status`; empty when neither says. */
export const vaultRootFor = (configured: string, statusDir: string): string => configured || /^(.+)\/Projects\/[^/]+\/Status\/?$/.exec(statusDir)?.[1] || '';

/** A lookup for whether `vaultPath` (vault-relative) is a regular file whose real path, symlinks followed, lies inside `root` and is not a secret file. Any filesystem error is "no". */
export const noteExistsIn = (root: string) => (vaultPath: string): boolean => {
  if (!root) return false;
  try {
    const full = resolve(root, vaultPath);
    if (!existsSync(full)) return false;
    const real = realpathSync(full);
    const inside = real.startsWith(`${realpathSync(root)}${sep}`);
    return inside && statSync(real).isFile() && !secretName(real.split(sep).join('/'));
  } catch { return false; }
};

const GITHUB_ITEM = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:pull|issues)\/(\d{1,7})(?:[/?#].*)?$/;
const TICKET_URL = /^https:\/\/[a-z0-9-]+\.atlassian\.net\/browse\/([A-Z][A-Z0-9_]*-\d+)(?:[/?#].*)?$/;
const REF = new RegExp(`${OBSIDIAN_URI.source}|https?:\\/\\/[^\\s<>"'\`]+|${NOTE_PATH.source}`, 'g');
const mdLabel = (s: string): string => s.replace(/[\\[\]]/g, '\\$&');

/** A short label for a web URL: `#590` for a GitHub pull request or issue, the key for a Jira ticket, else the host when the URL is long; null leaves the URL as written. */
export function shortUrlLabel(url: string): string | null {
  const gh = GITHUB_ITEM.exec(url);
  if (gh) return `#${Number(gh[1])}`;
  const ticket = TICKET_URL.exec(url);
  if (ticket) return ticket[1] as string;
  try {
    const u = new URL(url);
    return url.length > 48 ? `${u.hostname}/…` : null;
  } catch { return null; }
}

/**
 * Ask text for the web page: Markdown links in place of what a reader would otherwise have to copy. An `obsidian://open` URI for this
 * vault that names an existing note (see `noteOfUri`) and a vault `.md` path that exists become `[note name](obsidian URI)`, the URI rebuilt
 * from the resolved path; a GitHub pull request or Jira URL becomes `[#590](url)`. Anything that does not resolve is left as written; the
 * client still checks every target against its link policy before it makes an anchor.
 */
export function linkAskRefs(text: string, env: NoteLinkEnv | undefined): string {
  return text.replace(REF, (raw) => {
    if (raw.startsWith('obsidian:') || !/^https?:/.test(raw)) {
      const token = raw.startsWith('obsidian:') ? trimUri(raw) : raw;
      const path = !env?.vaultName ? null : raw.startsWith('obsidian:') ? noteOfUri(token, env) : resolveNote(raw, env);
      if (!path || !env) return raw;
      const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '');
      return `[${mdLabel(raw.startsWith('obsidian:') ? name : raw)}](${obsidianUri(env.vaultName, path.replace(/\.md$/, ''))})${raw.slice(token.length)}`;
    }
    const url = raw.replace(/[.,;:!?)\]}]+$/, '');
    const label = url.includes(')') ? null : shortUrlLabel(url);
    return label ? `[${mdLabel(label)}](${url})${raw.slice(url.length)}` : raw;
  });
}
