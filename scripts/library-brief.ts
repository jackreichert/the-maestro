#!/usr/bin/env node
/**
 * LIBRARY BRIEF: prints the "Library pages for this task" block to paste into a dispatch brief: the three best library pages for the task's
 * repo and words, as absolute paths with their read-when lines. It is the step that stops an agent re-deriving what a page already says.
 *
 *   node scripts/library-brief.ts --repo <repo> [--tickets-vault <vault>] [--vault <ledger root>] [--project <name>] [--json] "<task words>"
 *
 * It asks `ledger-index.ts find` (which rebuilds its index when a page changed), so it ranks the way `journal.ts find` does. With no match it still
 * prints the block, saying none were found. Exit 2 when the words are missing or the lookup fails. `journal.ts brief` treats that as advisory: it writes one "unavailable" line in
 * place of the block and the brief still goes out, so the block is never silently absent.
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { VAULT_ROOT } from './local-config.ts';
import { briefBlock, BRIEF_PAGES } from './lib/library/brief.ts';
import type { FoundPage } from './lib/library/find.ts';

const USAGE = 'Usage: library-brief.ts --repo <repo> [--tickets-vault <vault>] [--vault <ledger root>] [--project <name>] "<task words>"';
const VALUE_FLAGS = ['--repo', '--tickets-vault', '--vault', '--project'];

function main(argv: string[]): number {
  const values = new Map<string, string>();
  const words: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (VALUE_FLAGS.includes(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) { console.error(`library-brief: ${a} needs a value\n${USAGE}`); return 2; }
      values.set(a, v);
      i += 1;
    } else if (a === '--json') values.set(a, '1');
    else if (a.startsWith('--')) { console.error(`library-brief: unknown argument ${a}\n${USAGE}`); return 2; }
    else words.push(a);
  }
  // Task text is free text, not FTS syntax: keep the words, drop the operators, and quote each word so a stray quote or NOT cannot break the lookup.
  const terms = (words.join(' ').match(/[\p{L}\p{N}_]+/gu) ?? []).filter((w) => !['AND', 'OR', 'NOT', 'NEAR'].includes(w));
  const query = terms.map((w) => `"${w}"`).join(' ');
  const repo = values.get('--repo');
  if (!query || !repo) { console.error(USAGE); return 2; }
  const vault = values.get('--tickets-vault') ?? VAULT_ROOT;
  if (!vault) { console.error('library-brief: no vault; set VAULT_ROOT or pass --tickets-vault <path>'); return 2; }
  const r = spawnSync(process.execPath, [
    fileURLToPath(new URL('./ledger-index.ts', import.meta.url)), 'find', query, '--repo', repo, '--limit', String(BRIEF_PAGES), '--json',
    '--tickets-vault', vault, ...(['--vault', '--project'] as const).flatMap((k) => (values.has(k) ? [k, values.get(k) as string] : [])),
  ], { encoding: 'utf8' });
  let hits: FoundPage[];
  try { hits = JSON.parse(r.stdout) as FoundPage[]; } catch { hits = []; }
  if (r.status !== 0 || !Array.isArray(hits)) { console.error(`library-brief: the lookup failed${r.stderr ? `: ${r.stderr.trim().split('\n')[0]}` : ''}`); return 2; }
  console.log(values.has('--json') ? JSON.stringify(hits, null, 2) : briefBlock(hits, vault, terms.join(' ')));
  return 0;
}

const isMain = (): boolean => { try { return realpathSync(process.argv[1] as string) === fileURLToPath(import.meta.url); } catch { return false; } };
if (process.argv[1] && isMain()) process.exitCode = main(process.argv.slice(2));
