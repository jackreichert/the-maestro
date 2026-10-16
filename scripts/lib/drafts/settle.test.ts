// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/lib/drafts/settle.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addDraft, listDrafts, rejectDraft } from './queue.ts';
import type { NewDraft } from './queue.ts';
import { settleStaleDrafts } from './settle.ts';
import type { GhRead } from './reconcile.ts';

const file = (): string => { const d = mkdtempSync(join(tmpdir(), 'settle-')); mkdirSync(join(d, 'J')); return join(d, 'J', 'drafts.jsonl'); };
const COMPLIMENT = 'The ID validation before anything goes into a URL is exactly right.';
const draft = (pr: number, over: Partial<NewDraft> = {}): NewDraft => ({ key: `acme/widgets#${pr}@abcdef1:review`, source: 'review', repo: 'acme/widgets', pr, severity: 'review', target: { kind: 'review', commitId: `abcdef1${'0'.repeat(33)}` }, text: `${COMPLIMENT}\n\nOne nit.`, review: { compliment: COMPLIMENT, comments: [] }, ...over });
const T0 = new Date('2026-10-14T10:00:00Z');
const NOW = (): Date => new Date('2026-10-16T10:00:00Z');

interface View { rest?: unknown[]; state?: string; reviewDecision?: string; author?: { login: string }; createdAt?: string; reviewRequests?: { login?: string }[]; reviews?: unknown[]; commits?: { committedDate: string }[] }
const view = (v: View): string => JSON.stringify({ state: 'OPEN', reviewDecision: '', author: { login: 'pat-fake' }, createdAt: '2026-10-01T00:00:00Z', reviewRequests: [], commits: [{ committedDate: '2026-10-01T00:00:00Z' }], ...v });
const review = (login: string, state: string, submittedAt: string, body = '', type = 'User'): unknown => ({ user: { login, type }, state, submitted_at: submittedAt, body });
/** A gh that answers `pr view` for the PR number in its args from `byPr`, and records each call. */
const gh = (byPr: Record<number, View | null>, calls: string[][] = []): GhRead => (args) => {
  calls.push(args);
  if (args[0] === 'api') {
    const n = Number(/pulls\/(\d+)\/reviews/.exec(args[2] ?? '')?.[1]);
    const v = byPr[n];
    return v ? { status: 0, stdout: (v.reviews ?? []).map((x) => JSON.stringify(x)).join('\n'), stderr: '' } : { status: 1, stdout: '', stderr: 'rate limited' };
  }
  const n = Number(args[args.indexOf('view') + 1]);
  const v = byPr[n];
  return v ? { status: 0, stdout: view(v), stderr: '' } : { status: 1, stdout: '', stderr: 'rate limited' };
};

test('a queued review draft on a merged, closed, approved or picked-up PR is rejected with the reason recorded', () => {
  const f = file();
  const ids = [1, 2, 3, 4].map((n) => addDraft(f, draft(n), { now: () => T0 }).id);
  const run = gh({
    1: { state: 'MERGED' }, 2: { state: 'CLOSED' }, 3: { reviewDecision: 'APPROVED' },
    4: { reviews: [review('kim-fake', 'COMMENTED', '2026-10-02T00:00:00Z', 'I have this one.')] },
  });
  const out = settleStaleDrafts(f, 'me-fake', { run, now: NOW });
  assert.deepEqual(out.map((o) => o.id), ids);
  const by = new Map(listDrafts(f).map((d) => [d.pr, d]));
  assert.deepEqual([1, 2, 3, 4].map((n) => by.get(n)?.state), ['rejected', 'rejected', 'rejected', 'rejected']);
  assert.match(by.get(1)?.rejectReason ?? '', /^Settled automatically: the PR was merged/);
  assert.match(by.get(4)?.rejectReason ?? '', /kim-fake already reviewed it/);
});

test('a PR you were asked to review and have not reviewed keeps its draft even when someone else commented', () => {
  const f = file();
  addDraft(f, draft(1), { now: () => T0 });
  const run = gh({ 1: { reviewRequests: [{ login: 'ME-fake' }], reviews: [review('kim-fake', 'COMMENTED', '2026-10-02T00:00:00Z', 'My take.')] } });
  assert.deepEqual(settleStaleDrafts(f, 'me-fake', { run, now: NOW }), []);
  assert.equal(listDrafts(f)[0]?.state, 'pending');
});

test('an open PR nobody picked up keeps its draft, and a draft already rejected is never looked at', () => {
  const f = file(); const calls: string[][] = [];
  addDraft(f, draft(1), { now: () => T0 });
  const { id } = addDraft(f, draft(2), { now: () => T0 });
  assert.equal(rejectDraft(f, id, 'no thanks').ok, true);
  assert.deepEqual(settleStaleDrafts(f, 'me-fake', { run: gh({ 1: {}, 2: { state: 'MERGED' } }, calls), now: NOW }), []);
  assert.equal(calls.length, 2, 'only the pending draft\'s PR is read (view and reviews)');
  assert.equal(listDrafts(f).find((d) => d.pr === 1)?.state, 'pending');
});

test('a reply draft (an answer on your own PR) is not a review draft and is left alone', () => {
  const f = file();
  addDraft(f, { key: 'k', source: 'reply', repo: 'acme/widgets', pr: 3, severity: 'reply', text: 'Thanks, fixed.', target: { kind: 'reply', commentId: 5 }, replyTo: 'kim-fake' }, { now: () => T0 });
  const calls: string[][] = [];
  assert.deepEqual(settleStaleDrafts(f, 'me-fake', { run: gh({ 3: { state: 'MERGED' } }, calls), now: NOW }), []);
  assert.equal(calls.length, 0);
});

test('two drafts on one PR cost one read, and GitHub failing leaves every draft as it was', () => {
  const f = file(); const calls: string[][] = [];
  addDraft(f, draft(1), { now: () => T0 });
  addDraft(f, draft(1, { key: 'acme/widgets#1@2222222:review' }), { now: () => T0 });
  assert.deepEqual(settleStaleDrafts(f, 'me-fake', { run: gh({ 1: null }, calls), now: NOW }), []);
  assert.equal(calls.length, 1, 'view failed: no second call');
  assert.deepEqual(listDrafts(f).map((d) => d.state), ['pending', 'pending']);
  assert.equal(settleStaleDrafts(f, 'me-fake', { run: gh({ 1: { state: 'MERGED' } }), now: NOW }).length, 2);
});

test('settling is idempotent', () => {
  const f = file();
  addDraft(f, draft(1), { now: () => T0 });
  const run = gh({ 1: { state: 'MERGED' } });
  assert.equal(settleStaleDrafts(f, 'me-fake', { run, now: NOW }).length, 1);
  assert.equal(settleStaleDrafts(f, 'me-fake', { run, now: NOW }).length, 0);
});

test('the PR is read by number with a fixed argument list, never through a shell string built from the repo name', () => {
  const f = file(); const calls: string[][] = [];
  addDraft(f, draft(7), { now: () => T0 });
  settleStaleDrafts(f, 'me-fake', { run: gh({ 7: {} }, calls), now: NOW });
  assert.deepEqual(calls[0]?.slice(0, 5), ['pr', 'view', '7', '--repo', 'acme/widgets']);
  assert.equal(calls[1]?.[2], 'repos/acme/widgets/pulls/7/reviews');
});

test('a reviewer GitHub types as a Bot (any login, not only the known ones) does not pick a PR up', () => {
  const f = file();
  addDraft(f, draft(1), { now: () => T0 });
  const run = gh({ 1: { reviews: [review('some-review-bot', 'COMMENTED', '2026-10-02T00:00:00Z', 'Automated notes.', 'Bot')] } });
  assert.deepEqual(settleStaleDrafts(f, 'me-fake', { run, now: NOW }), []);
  assert.equal(listDrafts(f)[0]?.state, 'pending');
});
