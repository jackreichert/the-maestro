#!/usr/bin/env node
/**
 * others-list.ts: the Others' PRs list by hand. A teammate PR is on the tab only if it is on this list; Slack asks, GitHub review requests and @-mentions, staging twins,
 * backmerges and P0/hotfix PRs join by themselves (lib/teammate/others.ts), and this is how you add one that did not, or take one off.
 *
 *   node scripts/others-list.ts add <owner/repo#n | PR url> [--status-dir <dir>]    put a PR on the list (idempotent; a PR dropped before is put back)
 *   node scripts/others-list.ts drop <owner/repo#n | PR url> [--status-dir <dir>]   take a PR off the list
 *   node scripts/others-list.ts list [--json] [--status-dir <dir>]                  what is listed, how it joined, and what was dropped lately
 *
 * It writes only the list file in the status directory (`.now-others-list.jsonl`); it never reaches GitHub. A PR appears on the tab at the next refresh (the loop's
 * status-refresh, or the Refresh button). A hand-added PR follows the same drop rules as the rest. Only owners in `review_queue_orgs` can be added.
 * Exit 0 done, 1 refused, 2 bad usage.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CONFIGURED_PROJECT, CONTAINER_PROJECT, REVIEW_QUEUE_ORGS, statusDirFor } from './local-config.ts';
import { addToList, dropFromList, listPath, parsePrRef, readList } from './lib/teammate/others-list.ts';

const USAGE = 'Usage: others-list.ts add|drop <owner/repo#n | PR url> | list [--json]  [--status-dir <dir>]';

export interface CliOptions { statusDir: string; owners: readonly string[]; now?: number }
export interface CliResult { code: 0 | 1 | 2; out: string }

/** One command. Pure over the list file, so tests drive it with a temp directory. */
export function run(argv: string[], o: CliOptions): CliResult {
  const [cmd, ...rest] = argv;
  const now = o.now ?? Date.now();
  if (!o.statusDir) return { code: 2, out: 'No status directory. Set status_dir or vault_root in the local config, or pass --status-dir <dir>.' };
  const file = listPath(o.statusDir);
  if (cmd === 'list') {
    const s = readList(file);
    if (rest.includes('--json')) return { code: 0, out: JSON.stringify({ active: [...s.active.values()], dropped: [...s.dropped].map(([key, d]) => ({ key, ...d })) }) };
    const lines = [...s.active.values()].map((e) => `${e.key}  ${e.source}${e.channel ? ` (${e.channel})` : ''}`);
    return { code: 0, out: lines.length ? lines.join('\n') : 'The list is empty.' };
  }
  if (cmd !== 'add' && cmd !== 'drop') return { code: 2, out: USAGE };
  const key = parsePrRef(rest[0] ?? '');
  if (!key) return { code: 2, out: `Not a PR: "${(rest[0] ?? '').slice(0, 80)}". Give owner/repo#number or the PR's GitHub URL.` };
  if (cmd === 'drop') return { code: 0, out: dropFromList(file, key, 'dropped by hand', undefined, now) ? `Dropped ${key}.` : `${key} was not on the list.` };
  if (!o.owners.some((x) => x.toLowerCase() === key.split('/')[0])) return { code: 1, out: `${key.split('/')[0]} is not one of your review owners (review_queue_orgs: ${o.owners.join(', ') || 'none'}), so ${key} would never be listed.` };
  const s = readList(file);
  if (s.active.has(key)) return { code: 0, out: `${key} is already on the list.` };
  addToList(file, { key, source: 'manual' }, now);
  return { code: 0, out: `Added ${key}${s.dropped.has(key) ? ' (it had been dropped)' : ''}. It shows on the tab at the next refresh.` };
}

function main(argv: string[]): number {
  const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { 'status-dir': { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  if (v.help) { console.log(USAGE); return 0; }
  const statusDir = v['status-dir'] || statusDirFor(CONFIGURED_PROJECT || CONTAINER_PROJECT);
  const r = run([...positionals, ...(v.json ? ['--json'] : [])], { statusDir, owners: REVIEW_QUEUE_ORGS });
  (r.code === 0 ? console.log : console.error)(r.out);
  return r.code;
}

const isMain = (): boolean => { try { return realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url); } catch { return false; } };
if (isMain()) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error(`others-list: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}`); process.exitCode = 2; }
}
