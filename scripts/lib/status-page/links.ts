/** Links the status page and the reply footer share: Obsidian URIs and tracker URLs. Pure; the settings are passed in. */
import { relative, sep } from 'node:path';
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
