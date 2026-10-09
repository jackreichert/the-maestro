// Run: node --test scripts/pr-state.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildState, parseRef } from './pr-state.ts';

const SCRIPT = new URL('./pr-state.ts', import.meta.url).pathname;
const HEAD = 'headsha0000000000';
const OLD = 'oldsha00000000000';

const review = (login: string, state: string, at: string, commit = HEAD, type = 'User') => ({ state, submittedAt: at, author: { login, __typename: type }, commit: { oid: commit } });
const thread = (login: string, type: string, path: string, line: number, body: string, isResolved = false) =>
  ({ isResolved, path, line, comments: { nodes: [{ body, author: { login, __typename: type } }] } });
const pr = (over: Record<string, unknown> = {}) => ({
  number: 1, url: 'https://github.com/o/r/pull/1', headRefOid: HEAD, baseRefName: 'develop', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: '',
  reviews: { pageInfo: { hasPreviousPage: false }, nodes: [] }, reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: [{ __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }] } } } }] },
  ...over,
});
const state = (over: Record<string, unknown>) => buildState({ repo: 'o/r', number: 1 }, pr(over));

/** Runs the CLI against a fake gh that serves fixtures[number] (or exits 1 when absent). */
function run(fixtures: Record<number, unknown>, ...args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'pr-state-'));
  writeFileSync(join(dir, 'fixtures.json'), JSON.stringify(fixtures));
  writeFileSync(join(dir, 'gh'), `#!${process.execPath}
const f = JSON.parse(require('node:fs').readFileSync(${JSON.stringify(join(dir, 'fixtures.json'))}, 'utf8'));
const a = process.argv.slice(2);
const n = a.find((x) => x.startsWith('number=')).slice(7);
if (!f[n]) { console.error('GraphQL: Could not resolve to a PullRequest'); process.exit(1); }
console.log(JSON.stringify({ data: { repository: { pullRequest: f[n] } } }));
`);
  chmodSync(join(dir, 'gh'), 0o755);
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
}

test('parseRef takes owner/repo#N and PR URLs, rejects the rest', () => {
  assert.deepEqual(parseRef('example-org/example-repo#601'), { repo: 'example-org/example-repo', number: 601 });
  assert.deepEqual(parseRef('https://github.com/o/r/pull/7/files'), { repo: 'o/r', number: 7 });
  assert.equal(parseRef('601'), undefined);
});

test('an approval dismissed by a later push reads DISMISSED, not "nothing to lose"', () => {
  const s = state({ reviews: { pageInfo: {}, nodes: [review('acehand', 'APPROVED', '2026-10-01T10:00:00Z', OLD), review('acehand', 'DISMISSED', '2026-10-01T10:00:00Z', OLD)] } });
  assert.equal(s.reviewers[0]!.verdict, 'DISMISSED');
  assert.deepEqual(s.pushWarning, []);
});

test('an approval on an older commit is APPROVED-stale and raises no push warning', () => {
  const s = state({ reviews: { pageInfo: {}, nodes: [review('acehand', 'APPROVED', '2026-10-01T10:00:00Z', OLD)] } });
  assert.equal(s.reviewers[0]!.verdict, 'APPROVED-stale');
  assert.deepEqual(s.pushWarning, []);
});

test('the latest non-comment review wins; a later comment does not erase an approval', () => {
  const s = state({ reviews: { pageInfo: {}, nodes: [review('a', 'CHANGES_REQUESTED', '2026-10-01T09:00:00Z'), review('a', 'APPROVED', '2026-10-01T10:00:00Z'), review('a', 'COMMENTED', '2026-10-01T11:00:00Z')] } });
  assert.equal(s.reviewers[0]!.verdict, 'APPROVED-on-head');
  assert.deepEqual(s.pushWarning, ['a']);
});

test('a reviewer who only commented is COMMENTED-only', () => {
  assert.equal(state({ reviews: { pageInfo: {}, nodes: [review('a', 'COMMENTED', '2026-10-01T09:00:00Z')] } }).reviewers[0]!.verdict, 'COMMENTED-only');
});

test('threads split human vs bot; resolved ones are ignored; text is cut to 200 chars', () => {
  const s = state({ reviewThreads: { pageInfo: {}, nodes: [
    thread('copilot-pull-request-reviewer', 'Bot', 'a.ts', 3, 'x'.repeat(500)), thread('acehand', 'User', 'b.ts', 9, 'please rename'), thread('acehand', 'User', 'c.ts', 1, 'done', true),
  ] } });
  assert.equal(s.botThreads.length, 1);
  assert.equal(s.botThreads[0]!.text.length, 200);
  assert.deepEqual(s.humanThreads.map((t) => t.where), ['b.ts:9']);
  assert.equal(s.ready, false);
});

const CHECK = (over: Record<string, unknown>) => ({ commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { pageInfo: {}, nodes: [{ __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS', ...over }] } } } }] } });
const APPROVED = { pageInfo: {}, nodes: [review('acehand', 'APPROVED', '2026-10-01T10:00:00Z')] };

test('approved on head and CLEAN is ready to merge and ready for review', () => {
  const s = state({ reviews: APPROVED });
  assert.deepEqual([s.readyForReview, s.readyToMerge, s.mergeReasons], [true, true, []]);
});

test('dismissed approval, REVIEW_REQUIRED and BLOCKED (the 601 case) is ready for review but not to merge', () => {
  const s = state({ reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED', reviews: { pageInfo: {}, nodes: [review('acehand', 'APPROVED', '2026-10-01T10:00:00Z', OLD), review('acehand', 'DISMISSED', '2026-10-01T10:00:00Z', OLD)] } });
  assert.equal(s.readyForReview, true);
  assert.equal(s.readyToMerge, false);
  assert.match(s.mergeReasons.join(), /approval dismissed by a push/);
  assert.match(s.mergeReasons.join(), /blocked/);
});

test('a standing CHANGES_REQUESTED is not ready to merge even with threads resolved', () => {
  const s = state({ reviewDecision: 'CHANGES_REQUESTED', reviews: { pageInfo: {}, nodes: [review('acehand', 'CHANGES_REQUESTED', '2026-10-01T10:00:00Z')] } });
  assert.equal(s.readyForReview, true);
  assert.equal(s.readyToMerge, false);
  assert.match(s.mergeReasons.join(), /changes requested by acehand/);
});

test('a changes request beats another reviewer\'s approval', () => {
  const s = state({ reviews: { pageInfo: {}, nodes: [review('a', 'APPROVED', '2026-10-01T10:00:00Z'), review('b', 'CHANGES_REQUESTED', '2026-10-01T11:00:00Z')] } });
  assert.equal(s.readyToMerge, false);
  assert.match(s.mergeReasons.join(), /changes requested by b/);
});

test('pending checks block both verdicts', () => {
  const s = state({ reviews: APPROVED, ...CHECK({ status: 'IN_PROGRESS', conclusion: null }) });
  assert.deepEqual([s.readyForReview, s.readyToMerge], [false, false]);
  assert.match(s.reviewReasons.join(), /checks pending/);
});

test('failing checks block both verdicts', () => {
  const s = state({ reviews: APPROVED, ...CHECK({ conclusion: 'FAILURE' }) });
  assert.deepEqual([s.readyForReview, s.readyToMerge], [false, false]);
  assert.match(s.reviewReasons.join(), /checks failing: lint/);
});

test('an approval on an older commit and BEHIND is not ready to merge', () => {
  const s = state({ mergeStateStatus: 'BEHIND', reviews: { pageInfo: {}, nodes: [review('acehand', 'APPROVED', '2026-10-01T10:00:00Z', OLD)] } });
  assert.equal(s.readyForReview, true);
  assert.equal(s.readyToMerge, false);
  assert.match(s.mergeReasons.join(), /older commit/);
  assert.match(s.mergeReasons.join(), /behind/);
});

test('no review at all is waiting for an approval', () => {
  const s = state({});
  assert.equal(s.readyToMerge, false);
  assert.match(s.mergeReasons.join(), /waiting for an approval/);
});

test('a draft is neither ready for review nor ready to merge', () => {
  const s = state({ isDraft: true, mergeStateStatus: 'DRAFT', reviews: APPROVED });
  assert.deepEqual([s.readyForReview, s.readyToMerge], [false, false]);
  assert.match(s.reviewReasons.join(), /draft/);
});

test('conflicts block both verdicts', () => {
  const s = state({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', reviews: APPROVED });
  assert.deepEqual([s.readyForReview, s.readyToMerge], [false, false]);
  assert.match(s.reviewReasons.join(), /merge conflicts/);
});

test('unknown or unrecognised states fail closed', () => {
  assert.equal(state({ reviews: APPROVED, mergeable: 'UNKNOWN' }).readyForReview, false);
  assert.equal(state({ reviews: APPROVED, mergeStateStatus: 'UNKNOWN' }).readyToMerge, false);
  assert.equal(state({ reviews: APPROVED, mergeStateStatus: 'SOMETHING_NEW' }).readyToMerge, false);
  assert.equal(state({ reviews: APPROVED, mergeStateStatus: undefined }).readyToMerge, false);
});

test('more than one page of threads fails closed', () => {
  const s = state({ reviewThreads: { pageInfo: { hasNextPage: true }, nodes: [] } });
  assert.deepEqual([s.readyForReview, s.readyToMerge], [false, false]);
  assert.match(s.reviewReasons.join(), /threads/);
});

test('CLI prints the loud lines for several PRs, one unreadable', () => {
  const fx = {
    1: pr({ reviews: { pageInfo: {}, nodes: [review('acehand', 'APPROVED', '2026-10-01T10:00:00Z')] } }),
    2: pr({ number: 2, reviews: { pageInfo: {}, nodes: [review('acehand', 'DISMISSED', '2026-10-01T10:00:00Z', OLD)] }, reviewThreads: { pageInfo: {}, nodes: [thread('copilot-pull-request-reviewer', 'Bot', 'a.ts', 3, 'nit')] } }),
  };
  const r = run(fx, 'o/r#1', 'https://github.com/o/r/pull/2', 'o/r#3');
  assert.equal(r.status, 2);
  assert.match(r.stdout, /PUSH WARNING: a push will dismiss 1 approval\(s\): acehand/);
  assert.match(r.stdout, /reviewer acehand: DISMISSED on oldsha0000/);
  assert.match(r.stdout, /unresolved bot threads: 1/);
  assert.match(r.stdout, /READY-FOR-REVIEW: yes\nREADY-TO-MERGE: yes/);
  assert.match(r.stdout, /READY-FOR-REVIEW: no \(1 unresolved thread\(s\)\)\nREADY-TO-MERGE: no \(1 unresolved thread\(s\); approval dismissed by a push/);
  assert.match(r.stdout, /o\/r#3\n  could not read: GraphQL: Could not resolve[^\n]*\nREADY-FOR-REVIEW: no[^\n]*\nREADY-TO-MERGE: no/);
});

test('--json is machine-readable and carries no email field', () => {
  const r = run({ 1: pr({}) }, 'o/r#1', '--json');
  const out = JSON.parse(r.stdout);
  assert.equal(out[0].readyForReview, true);
  assert.equal(out[0].readyToMerge, false);
  assert.equal(out[0].ready, out[0].readyToMerge);
  assert.deepEqual(out[0].reasons, out[0].mergeReasons);
  assert.doesNotMatch(r.stdout, /email|@/);
});

test('bad usage exits 2', () => {
  assert.equal(run({}, 'not-a-pr').status, 2);
  assert.equal(run({}).status, 2);
});
