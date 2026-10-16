// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/lib/drafts/reconcile.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addDraft, editDraft, listDrafts, revOf } from './queue.ts';
import type { NewDraft } from './queue.ts';
import { approveAndPost } from './post.ts';
import type { GhResult } from './post.ts';
import { reconcileFailedReviews } from './reconcile.ts';

const file = (): string => { const d = mkdtempSync(join(tmpdir(), 'reconcile-')); mkdirSync(join(d, 'J')); return join(d, 'J', 'drafts.jsonl'); };
const COMPLIMENT = 'The ID validation before anything goes into a URL is exactly right.';
const review = (over: Partial<NewDraft> = {}): NewDraft => ({ key: 'acme/widgets#7@abcdef1:review', source: 'review', repo: 'acme/widgets', pr: 7, severity: 'review', target: { kind: 'review', commitId: 'abcdef1' }, text: `${COMPLIMENT}\n\nOk.`, review: { compliment: COMPLIMENT, comments: [] }, ...over });
const T0 = new Date('2026-10-14T10:00:00Z');
const HEAD = `abcdef1${'0'.repeat(33)}`;
const threads = JSON.stringify({ data: { repository: { pullRequest: { state: 'OPEN', author: { login: 'robin-r' }, reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } } });

/** A failed review draft: approve it against a gh that refuses with HTTP 422. */
function failed(f: string, over: Partial<NewDraft> = {}): string {
  const { id } = addDraft(f, review(over), { now: () => T0 });
  const run = (a: string[]): GhResult => {
    if (a.includes('graphql')) return { status: 0, stdout: threads, stderr: '' };
    if (a.includes('--jq')) return { status: 0, stdout: `${HEAD}\n`, stderr: '' };
    return { status: 1, stdout: '{"message":"Unprocessable Entity"}', stderr: 'gh: Unprocessable Entity (HTTP 422)' };
  };
  const d = listDrafts(f).find((x) => x.id === id);
  assert.equal(approveAndPost(f, id, revOf(d as never), { run }).ok, false);
  assert.equal(listDrafts(f).find((x) => x.id === id)?.state, 'failed');
  return id;
}
const mine = (at: string, state = 'APPROVED', login = 'octo-user'): string => JSON.stringify({ user: { login }, state, submitted_at: at, html_url: 'https://github.com/acme/widgets/pull/7#pullrequestreview-1' });
const gh = (lines: string[], calls: string[][] = []): ((a: string[]) => GhResult) => (a) => { calls.push(a); return { status: 0, stdout: lines.join('\n'), stderr: '' }; };

test('a failed review draft with a review of yours submitted after it was made is settled as already reviewed, with the link', () => {
  const f = file(); const id = failed(f);
  const out = reconcileFailedReviews(f, 'Octo-User', { run: gh([mine('2026-10-14T11:00:00Z')]), now: () => T0 });
  assert.deepEqual(out, [{ id, url: 'https://github.com/acme/widgets/pull/7#pullrequestreview-1' }]);
  const d = listDrafts(f)[0];
  assert.equal(d?.state, 'rejected');
  assert.match(d?.rejectReason ?? '', /Already reviewed.*pullrequestreview-1/);
  assert.equal(approveAndPost(f, id, revOf(d as never), { run: gh([]) }).ok, false, 'Approve no longer reaches gh for it');
});

test('reviews that do not count leave the draft failed: someone else\'s, a pending one, or one from before the draft', () => {
  const f = file(); failed(f);
  const none = reconcileFailedReviews(f, 'octo-user', { run: gh([mine('2026-10-14T11:00:00Z', 'APPROVED', 'someone-else'), mine('2026-10-14T11:00:00Z', 'PENDING'), mine('2026-10-14T09:00:00Z')]) });
  assert.deepEqual(none, []);
  assert.equal(listDrafts(f)[0]?.state, 'failed');
});

test('no GitHub call is made unless a failed review draft exists, and an unreadable PR changes nothing', () => {
  const f = file(); const calls: string[][] = [];
  addDraft(f, review(), { now: () => T0 });   // pending, not failed
  assert.deepEqual(reconcileFailedReviews(f, 'octo-user', { run: gh([mine('2026-10-14T11:00:00Z')], calls) }), []);
  assert.equal(calls.length, 0);
  const f2 = file(); failed(f2);
  assert.deepEqual(reconcileFailedReviews(f2, 'octo-user', { run: () => ({ status: 1, stdout: '', stderr: 'rate limited' }) }), []);
  assert.deepEqual(reconcileFailedReviews(f2, '', { run: gh([mine('2026-10-14T11:00:00Z')], calls) }), [], 'no login configured: nothing to match');
  assert.equal(calls.length, 0);
  assert.equal(listDrafts(f2)[0]?.state, 'failed');
});

test('settling is idempotent, and a draft edited back to pending meanwhile is not settled', () => {
  const f = file(); const id = failed(f);
  const run = gh([mine('2026-10-14T11:00:00Z')]);
  assert.equal(reconcileFailedReviews(f, 'octo-user', { run }).length, 1);
  assert.equal(reconcileFailedReviews(f, 'octo-user', { run }).length, 0, 'already rejected: not failed any more');
  const g = file(); const gid = failed(g);
  assert.equal(editDraft(g, gid, `${COMPLIMENT}\n\nReworded.`).ok, true);
  assert.equal(reconcileFailedReviews(g, 'octo-user', { run }).length, 0);
  assert.equal(listDrafts(g)[0]?.state, 'pending');
  assert.ok(id);
});

test('an already-reviewed row only settles a failed review draft: a pending draft, or a non-review one, ignores it', () => {
  const f = file();
  const { id } = addDraft(f, review(), { now: () => T0 });
  appendFileSync(f, `${JSON.stringify({ op: 'already-reviewed', id, ts: '2026-10-14T12:00:00Z' })}\n`);
  assert.equal(listDrafts(f)[0]?.state, 'pending');
});
