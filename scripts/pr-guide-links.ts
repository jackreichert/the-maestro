#!/usr/bin/env node
/**
 * PR GUIDE LINKS: expands `{{file:<path>}}` tokens in an existing PR's body into links to that file in the PR's
 * Files changed tab (the same expansion pr-open.ts runs after creating a PR), so already-open PRs can be backfilled.
 *
 *   node scripts/pr-guide-links.ts <repo-path> <pr-number>
 *   node scripts/pr-guide-links.ts --hunks <repo-path> <pr-number> [path]
 *
 * `--hunks` writes nothing: it prints a `{{file:path#R25-R31}}` token for each run of added lines in the PR's diff
 * (new-side ranges), so a guide links lines that are inside a changed hunk.
 *
 * Idempotent: a body with no tokens is left alone. A token whose path is not in the diff is an error and nothing is
 * written. Exit 0 done or nothing to do, 1 a token or anchor is bad or names a path outside the diff or gh failed, 2 bad usage.
 * The gh binary is `gh`, or MAESTRO_GH_BIN.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { linkPr } from './pr-links.ts';
import { changedRanges, hunkTokens, prDiff } from './pr-hunks.ts';

function main(): void {
  const args = process.argv.slice(2);
  const hunks = args[0] === '--hunks';
  const [repo, num, only] = hunks ? args.slice(1) : args;
  if (!repo || !/^\d+$/.test(num ?? '') || (!hunks && only !== undefined) || args.length > (hunks ? 4 : 2)) {
    console.error('usage: node scripts/pr-guide-links.ts <repo-path> <pr-number>\n       node scripts/pr-guide-links.ts --hunks <repo-path> <pr-number> [path]');
    process.exit(2);
  }
  if (hunks) {
    const d = prDiff(repo, Number(num));
    if ('error' in d) { console.error(`pr-guide-links: ${d.error}`); process.exit(1); }
    const tokens = hunkTokens(changedRanges(d.diff), only);
    if (!tokens.length) { console.error(`pr-guide-links: no added lines${only ? ` in ${only}` : ''} in PR ${num}'s diff`); process.exit(1); }
    console.log(tokens.join('\n'));
    return;
  }
  const err = linkPr(repo, Number(num));
  if (err) { console.error(`pr-guide-links: ${err}`); process.exit(1); }
}

const isMain = () => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };

if (process.argv[1] && isMain()) main();
