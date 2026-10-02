/**
 * pr-review: review activity on the user's open PRs, by wrapping pr-watch.mjs rather than copying it. Target is ignored
 * (use `open-prs`). Each check runs `pr-watch.mjs --once` against its own state file under the loop's directory; pr-watch
 * already diffs against that file, so the lines it reports as changes are this type's events. Standing conditions
 * (an approved, unmerged PR) are reported once per appearance. pr-watch's own side effects (Copilot requests on drafts) still apply.
 *
 * Ordering caveat: pr-watch saves its state file before the loop saves the digest, so a crash between the two drops
 * that tick's events (the next tick sees no change). The loop cannot undo pr-watch's write; the cost is one missed report.
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Scheduling: default seconds between checks, and whether a check calls the network (decides the floor).
export const interval = 180;
export const network = true;

const PR_WATCH = fileURLToPath(new URL('../pr-watch.mjs', import.meta.url));
const CHANGE = /^(THREAD|REPLY|COMMENT|REVIEW|DECISION|LEFT-OPEN-SET) /;
const STANDING = /^APPROVED-UNMERGED /;

/** Splits pr-watch --once output into the change lines and the standing-condition lines. */
export function parseReport(stdout) {
  const lines = stdout.split('\n').map((l) => l.trim());
  return { changes: lines.filter((l) => CHANGE.test(l)), standing: lines.filter((l) => STANDING.test(l)) };
}

const stateFile = (dir, watch) => join(dir, `pr-review-${watch.id}.json`);

/** The loop calls this when the watch retires or is removed: drop its pr-watch state file. */
export const retired = (watch, ctx) => rmSync(stateFile(ctx.dir, watch), { force: true });

export function check(_target, ctx) {
  const state = stateFile(ctx.dir, ctx.watch);
  const r = ctx.run(process.execPath, [PR_WATCH, '--once', '--state', state]);
  if (r.status !== 0) throw new Error(`pr-watch failed: ${(r.stderr || '').split('\n')[0]}`);
  return parseReport(r.stdout);
}

export function diff(prev, next) {
  const known = new Set(prev?.standing ?? []);
  return [...next.changes, ...next.standing.filter((l) => !known.has(l))].map((summary) => ({ summary }));
}
