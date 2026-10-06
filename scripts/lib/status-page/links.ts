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

/** The reply-footer line, or none. */
export const statusPageFooter = (uri: string): string[] => (uri ? [`**Podium:** ${uri}`] : []);

/** The vault-relative note path of a ticket id from a template with `{id}` and `{prefix}` (the id minus its trailing number). */
export const ticketNotePath = (template: string, id: string): string => template.replace(/\{id\}/g, id).replace(/\{prefix\}/g, id.replace(/-\d+$/, ''));

/** What `linkNotePaths` needs: the vault name, the projects a bare path may belong to (most likely first), and whether a vault-relative `.md` path exists. */
export interface NoteLinkEnv { vaultName: string; projects: string[]; exists: (vaultPath: string) => boolean }

const NOTE_PATH = /(?<![\w./:@-])(?:[\w.-]+\/)*[\w.-]+\.md(?![\w/])/g;
/** Files that hold secrets, whatever the extension, are never linked. */
const secretName = (path: string): boolean => path.split('/').some((seg) => /^\.env/i.test(seg) || /^ssm-.*\.json/i.test(seg));

/** The vault-relative `.md` path `raw` names, as given or under `Projects/<project>/`, when it exists; else null. */
function resolveNote(raw: string, env: NoteLinkEnv): string | null {
  if (raw.startsWith('/') || raw.split('/').some((seg) => seg === '..' || seg === '.') || secretName(raw)) return null;
  const candidates = raw.startsWith('Projects/') ? [raw] : [raw, ...env.projects.filter(Boolean).map((p) => `Projects/${p}/${raw}`)];
  return candidates.find((c) => env.exists(c)) ?? null;
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
