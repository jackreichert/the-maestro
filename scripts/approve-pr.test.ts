// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/approve-pr.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test } from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { approvePr } from './approve-pr.ts';
import type { ApproveArgs } from './approve-pr.ts';
import type { GhOut } from './lib/approve-guard.ts';

const HEAD = 'a'.repeat(40);
const base: ApproveArgs = { repo: 'acme/widgets', pr: 7, head: HEAD, body: 'Careful validation before anything goes into a URL. Looks good.', triage: [], asComment: false, dryRun: false };
interface Rig { posts: { args: string[]; input?: string }[]; run: (a: string[], i?: string) => GhOut }
const rig = (threads: number[] = [], head = HEAD): Rig => {
  const out: Rig = { posts: [], run: (a, input) => {
    if (a.includes('graphql')) return { status: 0, stderr: '', stdout: JSON.stringify({ data: { repository: { pullRequest: { state: 'OPEN', author: { login: 'robin-r' }, reviewThreads: { pageInfo: { hasNextPage: false }, nodes: threads.map((id) => ({ id: `T${id}`, isResolved: false, isOutdated: false, path: 'src/a.ts', line: id, comments: { pageInfo: { hasNextPage: false }, nodes: [{ databaseId: id, body: 'x', author: { login: 'copilot-pull-request-reviewer', __typename: 'Bot' } }] } })) } } } } }) };
    if (a.includes('--jq')) return { status: 0, stderr: '', stdout: `${a.at(-1) === '.head.ref' ? 'feat/x' : head}\n` };
    out.posts.push({ args: a, ...(input === undefined ? {} : { input }) });
    return { status: 0, stderr: '', stdout: '{"html_url":"https://github.com/acme/widgets/pull/7#pullrequestreview-1"}' };
  } };
  return out;
};
const sent = (r: Rig): { commit_id: string; event: string; body: string } => JSON.parse(r.posts[0]?.input ?? '{}');

test('a clean PR is approved as one review pinned to the reviewed head', () => {
  const g = rig();
  const out = approvePr(base, g.run);
  assert.equal(out.code, 0);
  assert.match(out.message, /posted a APPROVE review: https:\/\/github\.com/);
  assert.deepEqual(g.posts[0]?.args, ['api', '-X', 'POST', 'repos/acme/widgets/pulls/7/reviews', '--input', '-']);
  assert.deepEqual([sent(g).commit_id, sent(g).event, sent(g).body], [HEAD, 'APPROVE', base.body]);
});

test('an untriaged bot thread refuses, lists the thread and posts nothing', () => {
  const g = rig([5]);
  const out = approvePr(base, g.run);
  assert.equal(out.code, 1);
  assert.match(out.message, /1 open bot thread has not been triaged.*thread 5.*--as-comment/s);
  assert.equal(g.posts.length, 0);
});

test('triaged threads: not worth leaves the body alone, worth adds the list, blocking posts a COMMENT', () => {
  const t = (over: object) => ({ threadId: '5', worthAddressing: false, reason: 'A nit.', ...over });
  const a = rig([5]); approvePr({ ...base, triage: [t({})] }, a.run);
  assert.deepEqual([sent(a).event, sent(a).body], ['APPROVE', base.body]);
  const b = rig([5]); approvePr({ ...base, triage: [t({ worthAddressing: true, reason: 'Empty cart.' })] }, b.run);
  assert.equal(sent(b).event, 'APPROVE');
  assert.match(sent(b).body, /\*\*Worth addressing before merge\*\*\n- \[src\/a\.ts:5\]\(https:\/\/github\.com\/acme\/widgets\/pull\/7#discussion_r5\): Empty cart\.$/);
  const c = rig([5]); approvePr({ ...base, triage: [t({ worthAddressing: true, severity: 'blocking', reason: 'Drops rows.' })] }, c.run);
  assert.equal(sent(c).event, 'COMMENT');
});

test('a head that moved refuses, even with --as-comment unused; --as-comment posts a COMMENT without the thread rules, pinned to the head', () => {
  const moved = rig([], 'b'.repeat(40));
  assert.equal(approvePr(base, moved.run).code, 1);
  assert.equal(moved.posts.length, 0);
  const g = rig([5]);
  assert.equal(approvePr({ ...base, asComment: true }, g.run).code, 0);
  assert.deepEqual([sent(g).event, sent(g).commit_id], ['COMMENT', HEAD]);
});

test('bad input is refused before gh is touched, and --dry-run posts nothing', () => {
  const g = rig();
  for (const bad of [{ head: 'abc' }, { repo: 'nope' }, { pr: 0 }, { body: '  ' }, { triage: [{ threadId: '', worthAddressing: true, reason: 'x' }] }]) assert.equal(approvePr({ ...base, ...bad } as ApproveArgs, g.run).code, 2);
  assert.equal(approvePr({ ...base, dryRun: true }, g.run).code, 0);
  assert.equal(g.posts.length, 0);
});

test('a gh failure while posting is reported, not claimed as posted', () => {
  const g = rig();
  const run = (a: string[], i?: string): GhOut => (a.includes('--input') ? { status: 1, stdout: '', stderr: 'gh: Unprocessable Entity (HTTP 422)' } : g.run(a, i));
  const out = approvePr(base, run);
  assert.equal(out.code, 2);
  assert.match(out.message, /did not accept it.*422/);
});

test('only two sources can post a review, and each runs the guard: the Podium poster and this script', () => {
  const root = import.meta.dirname;
  const sources: string[] = [];
  const walk = (dir: string): void => { for (const n of readdirSync(dir)) { if (n === 'node_modules') continue; const p = join(dir, n); statSync(p).isDirectory() ? walk(p) : /\.ts$/.test(n) && !/\.test\.ts$/.test(n) && sources.push(p); } };
  walk(root);
  const has = (re: RegExp): string[] => sources.filter((p) => re.test(readFileSync(p, 'utf8'))).map((p) => p.slice(root.length + 1)).sort();
  assert.deepEqual(has(/'POST',[^\n]*pulls\/\$\{[^}]+\}\/reviews/), ['approve-pr.ts', 'lib/drafts/post.ts']);
  assert.deepEqual(has(/\bcheckApprove\(/), ['approve-pr.ts', 'lib/approve-guard.ts', 'lib/drafts/post.ts', 'teammate-review.ts']);
});
