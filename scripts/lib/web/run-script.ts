/**
 * The catalog as a run source: a script name and its args become an argv, its hash and a verdict, read from the catalog file on every request.
 * Nothing the page sends is ever part of a command except an arg value that passed its schema, and it goes in as its own argv element: the child is
 * spawned with no shell. The cwd is this repo's root, so a catalog path such as `scripts/journal.ts` means the copy that is running.
 */
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { secretFileRefs } from '../run/command-guard.ts';
import type { Refusal } from '../run/command-guard.ts';
import { buildArgv, displayArgv, loadCatalog, publicEntry } from '../run/catalog.ts';
import type { Catalog, Context } from '../run/catalog.ts';
import { secretShaped } from '../withhold.ts';
import type { WebConfig } from './api.ts';
import { sha256, shownVerbatim } from './run-source.ts';
import type { Lookup } from './run-source.ts';

export const CATALOG_FILE = fileURLToPath(new URL('../../../podium/scripts.json', import.meta.url));
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** The placeholders' values: the server's own settings. */
export const contextFor = (web: WebConfig): Context => ({ node: process.execPath, home: homedir(), ledger: web.vault, vault: web.vaultRoot ?? web.vault, project: web.project });

/** What the Scripts tab shows: every entry without its command, and what failed to load. */
export function listCatalog(file: string = CATALOG_FILE): { scripts: object[]; problems: string[] } {
  const c = loadCatalog(file);
  return { scripts: c.entries.map(publicEntry), problems: c.problems };
}

/** Resolves `{source:'script', name, args}` to the exact argv that would run. A bad name or bad args answer as data, never a run. */
export function resolveScript(web: WebConfig, body: Record<string, unknown>, file: string = CATALOG_FILE, catalog?: Catalog): Lookup | null {
  if (body.source !== 'script' || typeof body.name !== 'string') return null;
  const entry = (catalog ?? loadCatalog(file)).entries.find((e) => e.id === body.name);
  if (!entry) return { ok: false, status: 404, error: 'unknown', message: 'No such script in the catalog.' };
  const built = buildArgv(entry, body.args, contextFor(web));
  if (!built.ok) return { ok: false, status: 422, error: 'invalid', message: built.message };
  const command = displayArgv(built.argv);
  const refusals: Refusal[] = [];
  if (secretFileRefs(built.argv.join(' ')).length) refusals.push({ rule: 'secret-file', message: 'The command names a secret file.' });
  if (built.argv.some((t) => secretShaped(t))) refusals.push({ rule: 'secret-shaped', message: 'The command holds something that looks like a secret.' });
  if (!shownVerbatim(command)) refusals.push({ rule: 'not-verbatim', message: 'The page cannot show this command exactly as it is, so it will not run it.' });
  const hash = sha256(JSON.stringify({ argv: built.argv, cwd: REPO_ROOT }));
  return { ok: true, item: { key: `script:${entry.id}`, source: 'script', target: entry.id, title: entry.name, command, sha256: hash, readOnly: entry.readOnly, tier: entry.tier, spec: { kind: 'argv', argv: built.argv, cwd: REPO_ROOT }, timeoutMs: entry.timeoutSeconds * 1000, refusals } };
}
