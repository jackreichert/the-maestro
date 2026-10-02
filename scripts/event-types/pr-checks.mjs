/**
 * pr-checks: CI status of one PR. Target `owner/repo#123` (or the PR URL).
 * State { overall: none|pending|passing|failing, total, failed[], settled }. Done_when: `settled` (default,
 * no check still pending) or `passing`. Actionable: a move into failing or passing. A re-run (back to pending) is informational.
 */
const TARGET = /^(?:https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+)(?:#|\/pull\/)(\d+)\/?$/;
const MAX_NAMED = 5;
// gh pr checks exits 8 while checks are pending and 1 when any failed; both still print the JSON.
const OK_STATUS = new Set([0, 1, 8]);

export const parseTarget = (target) => {
  const m = String(target).match(TARGET);
  if (!m) throw new Error(`pr-checks target must look like owner/repo#123, got "${target}"`);
  return { repo: m[1], number: m[2] };
};

/** Folds gh's `bucket` per check (pass, fail, pending, skipping, cancel) into one state. */
export function summarize(checks) {
  const by = (...buckets) => checks.filter((c) => buckets.includes(c.bucket));
  const failed = by('fail', 'cancel').map((c) => c.name).sort();
  const pending = by('pending').length;
  const overall = failed.length ? 'failing' : pending ? 'pending' : checks.length ? 'passing' : 'none';
  return { overall, total: checks.length, failed: failed.slice(0, MAX_NAMED), settled: checks.length > 0 && pending === 0 };
}

export function check(target, ctx) {
  const { repo, number } = parseTarget(target);
  const r = ctx.run('gh', ['pr', 'checks', number, '--repo', repo, '--json', 'name,bucket']);
  if (!OK_STATUS.has(r.status)) throw new Error(`gh pr checks failed: ${(r.stderr || '').split('\n')[0]}`);
  if (!r.stdout.trim()) return summarize([]);
  return summarize(JSON.parse(r.stdout));
}

export function diff(prev, next) {
  const names = next.failed.join(', ');
  const now = next.overall === 'failing' ? { summary: `CI failing: ${names}` }
    : next.overall === 'passing' ? { summary: `CI passing (${next.total} checks)` } : null;
  if (!prev) return next.overall === 'failing' || next.overall === 'passing' ? [now] : [];
  const changed = prev.overall !== next.overall || prev.failed.join() !== next.failed.join();
  if (!changed) return [];
  return now ? [now] : [{ summary: `CI is ${next.overall}`, actionable: false }];
}

export const done = (state, watch) => (watch.done_when === 'passing' ? state.overall === 'passing' : state.settled);
