/**
 * pr-review: review activity on the user's open PRs, by wrapping pr-watch.mjs rather than copying it. Target is ignored
 * (use `open-prs`). Each check runs `pr-watch.mjs --once` against its own state file under the loop's directory; pr-watch
 * already diffs against that file, so the lines it reports as changes are this type's events. Standing conditions
 * (an approved, unmerged PR) are reported once per appearance. pr-watch's own side effects (Copilot requests on drafts) still apply.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PR_WATCH = fileURLToPath(new URL('../pr-watch.mjs', import.meta.url));
const CHANGE = /^(THREAD|REPLY|COMMENT|REVIEW|DECISION|LEFT-OPEN-SET) /;
const STANDING = /^APPROVED-UNMERGED /;

/** Splits pr-watch --once output into the change lines and the standing-condition lines. */
export function parseReport(stdout) {
  const lines = stdout.split('\n').map((l) => l.trim());
  return { changes: lines.filter((l) => CHANGE.test(l)), standing: lines.filter((l) => STANDING.test(l)) };
}

export function check(_target, ctx) {
  const state = join(ctx.dir, `pr-review-${ctx.watch.id}.json`);
  const r = ctx.run(process.execPath, [PR_WATCH, '--once', '--state', state]);
  if (r.status !== 0) throw new Error(`pr-watch failed: ${(r.stderr || '').split('\n')[0]}`);
  return parseReport(r.stdout);
}

export function diff(prev, next) {
  const known = new Set(prev?.standing ?? []);
  return [...next.changes, ...next.standing.filter((l) => !known.has(l))].map((summary) => ({ summary }));
}
