/**
 * gh-run: one GitHub Actions run, until it completes. Target `owner/repo:<run id>`.
 * State { status, conclusion, name }. Actionable only on completion (any conclusion); a start is informational.
 */
const TARGET = /^([\w.-]+\/[\w.-]+):(\d+)$/;

export function check(target, ctx) {
  const m = String(target).match(TARGET);
  if (!m) throw new Error(`gh-run target must look like owner/repo:<run id>, got "${target}"`);
  const r = ctx.run('gh', ['run', 'view', m[2], '--repo', m[1], '--json', 'status,conclusion,name']);
  if (r.status !== 0) throw new Error(`gh run view failed: ${(r.stderr || '').split('\n')[0]}`);
  const { status, conclusion, name } = JSON.parse(r.stdout);
  return { status, conclusion: conclusion || '', name: name || '' };
}

export function diff(prev, next) {
  if (next.status === 'completed' && prev?.status !== 'completed') return [{ summary: `run "${next.name}" completed: ${next.conclusion || 'unknown'}` }];
  if (prev && prev.status !== next.status && next.status !== 'completed') return [{ summary: `run "${next.name}" is ${next.status}`, actionable: false }];
  return [];
}

export const done = (state) => state.status === 'completed';
