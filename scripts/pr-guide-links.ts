#!/usr/bin/env node
/**
 * PR GUIDE LINKS: expands `{{file:<path>}}` tokens in an existing PR's body into links to that file in the PR's
 * Files changed tab (the same expansion pr-open.ts runs after creating a PR), so already-open PRs can be backfilled.
 *
 *   node scripts/pr-guide-links.ts <repo-path> <pr-number>
 *
 * Idempotent: a body with no tokens is left alone. A token whose path is not in the diff is an error and nothing is
 * written. Exit 0 done or nothing to do, 1 a token names a path outside the diff or gh failed, 2 bad usage.
 * The gh binary is `gh`, or MAESTRO_GH_BIN.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { linkPr } from './pr-links.ts';

function main(): void {
  const [repo, num] = process.argv.slice(2);
  if (!repo || !/^\d+$/.test(num ?? '')) {
    console.error('usage: node scripts/pr-guide-links.ts <repo-path> <pr-number>');
    process.exit(2);
  }
  const err = linkPr(repo, Number(num));
  if (err) { console.error(`pr-guide-links: ${err}`); process.exit(1); }
}

const isMain = () => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };

if (process.argv[1] && isMain()) main();
