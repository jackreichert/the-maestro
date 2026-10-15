// Run: node --test scripts/web/client/test/needs-items.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isReadyToMerge, needsItems, needsSig, readyPrItems, reviewDraftItems, scopedItems, streamOfRepo } from '../src/needs-items.ts';
import { reviewVerdicts } from '../../../lib/status-page/reviews.ts';
import { reviewOf } from '../../../lib/web/open-prs.ts';
import type { DraftRow, DraftsData } from '../src/drafts-model.ts';
import type { OpenPrRow, OpenPrsData, PrCard } from '../src/types.ts';

const NOW = '2026-10-15T12:00:00Z';
const pr = (over: Partial<OpenPrRow> = {}): OpenPrRow => ({
  number: 7, title: 'Add the thing', url: 'https://github.com/acme/widgets/pull/7', base: 'develop', head: 'feat/x-1', isDraft: false,
  review: 'approved', unresolved: 0, mergeable: 'mergeable', twins: [], ci: 'SUCCESS', approvers: ['pat'], ageDays: 2, ...over,
});
const prs = (rows: Record<string, OpenPrRow[]>): OpenPrsData => ({
  generatedAt: NOW, prData: { fetchedAt: NOW, stale: false }, total: 0,
  groups: [{ id: 'team', label: 'Team repos', count: 0, repos: Object.entries(rows).map(([repo, p]) => ({ repo, count: p.length, prs: p })) }],
});
const card = (repo: string, number: number, stream: string): PrCard => ({ repo, short: repo.split('/')[1]!, number, title: 't', url: 'u', stream, base: 'develop', head: 'h', isDraft: false, ci: 'SUCCESS', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', unresolved: 0, review: 'APPROVED', flags: [] });
const draft = (over: Partial<DraftRow> = {}): DraftRow => ({
  rev: 'abcdef012345', id: 'dr-00000001', source: 'review', repo: 'acme/gadgets', pr: 41, prUrl: 'https://github.com/acme/gadgets/pull/41', severity: 'review',
  text: 'Nice tidy diff.\n\nResolve the suggestions however you like.', context: 'Approves: 0 blocking, 2 suggestion(s); 1a2b3c', state: 'pending', createdAt: '2026-10-13T12:00:00Z',
  review: { event: 'APPROVE', compliment: 'Nice tidy diff.', comments: [] }, author: 'robin', ...over,
});
const drafts = (...d: DraftRow[]): DraftsData => ({ generatedAt: NOW, drafts: d });

test('a clean approved PR with green checks is ready', () => {
  assert.equal(isReadyToMerge(pr()), true);
});

test('a draft, an open thread, a failing, pending or missing check, a conflict and an unknown mergeable state are never ready', () => {
  assert.equal(isReadyToMerge(pr({ isDraft: true })), false);
  assert.equal(isReadyToMerge(pr({ unresolved: 1 })), false);
  assert.equal(isReadyToMerge(pr({ ci: 'FAILURE' })), false);
  assert.equal(isReadyToMerge(pr({ ci: 'PENDING' })), false, 'this list says merge now, so checks must be green, not merely not red');
  assert.equal(isReadyToMerge(pr({ ci: undefined })), false, 'no check result fails closed');
  assert.equal(isReadyToMerge(pr({ mergeable: 'conflicting' })), false);
  assert.equal(isReadyToMerge(pr({ mergeable: 'unknown' })), false);
  assert.equal(isReadyToMerge(pr({ review: 'none' })), false);
  assert.equal(isReadyToMerge(pr({ review: 'changes-requested' })), false);
});

test('a self-review repo PR is ready on checks alone, but never as a draft or while mergeable is unknown, and its row does not claim an approval', () => {
  const mine = pr({ readyOnChecks: true, review: 'none', approvers: undefined, unresolved: 2 });
  assert.equal(isReadyToMerge(mine), true);
  assert.equal(isReadyToMerge({ ...mine, isDraft: true }), false);
  assert.equal(isReadyToMerge({ ...mine, mergeable: 'unknown' }), false);
  assert.equal(isReadyToMerge({ ...mine, base: 'staging', sides: { develop: { number: 5, url: 'u' } } }), false);
  const [item] = readyPrItems(prs({ 'me/tool': [mine] }), [], []);
  assert.equal(item!.summary, 'Checks passing, no conflict (self-review repo).');
});

test('an approval a later push dismissed is not an approval: the review history says none, so the PR is not ready', () => {
  const history = [
    { state: 'APPROVED', submittedAt: '2026-10-14T09:00:00Z', author: { login: 'pat' } },
    { state: 'DISMISSED', submittedAt: '2026-10-14T10:00:00Z', author: { login: 'pat' } },
  ];
  const { approvers, changesBy } = reviewVerdicts(history);
  const review = reviewOf(null, approvers, changesBy);
  assert.equal(review, 'none');
  assert.equal(isReadyToMerge(pr({ review, approvers })), false);
  const again = reviewVerdicts([...history, { state: 'APPROVED', submittedAt: '2026-10-14T11:00:00Z', author: { login: 'pat' } }]);
  assert.equal(isReadyToMerge(pr({ review: reviewOf(null, again.approvers, again.changesBy), approvers: again.approvers })), true, 'a fresh approval after the push counts');
});

test('a staging PR waits for its develop twin to merge, even when the cache did not say so', () => {
  const sides = (merged?: boolean): OpenPrRow['sides'] => ({ develop: { number: 5, url: 'https://github.com/acme/widgets/pull/5', ...(merged ? { merged: true } : {}) }, staging: { number: 7, url: 'u' } });
  assert.equal(isReadyToMerge(pr({ base: 'staging', waitsOnDevelop: { number: 5 } })), false, 'waits flagged');
  assert.equal(isReadyToMerge(pr({ base: 'staging', sides: sides() })), false, 'twin still open, no waits flag: held anyway');
  assert.equal(isReadyToMerge(pr({ base: 'staging', sides: sides(true) })), true, 'twin merged');
  assert.equal(isReadyToMerge(pr({ base: 'develop', sides: sides() })), true, 'the develop PR itself is not held by its staging twin');
});

test('ready PRs list oldest first with repo, base, ticket and link, under the stream of their repo', () => {
  const data = prs({ 'acme/widgets': [pr({ number: 7, ageDays: 1 }), pr({ number: 8, ageDays: 5, base: 'staging', ticket: { label: 'AB-9', url: 'https://x.test/AB-9' } }), pr({ number: 9, isDraft: true })] });
  const items = readyPrItems(data, [card('acme/widgets', 7, 'Avonlea'), card('acme/widgets', 8, 'Avonlea')], ['Avonlea']);
  assert.deepEqual(items.map((i) => i.number), [8, 7]);
  assert.equal(items[0]!.kind, 'ready to merge');
  assert.equal(items[0]!.stream, 'Avonlea');
  assert.equal(items[0]!.base, 'staging');
  assert.deepEqual(items[0]!.ticket, { label: 'AB-9', url: 'https://x.test/AB-9' });
  assert.equal(items[0]!.url, 'https://github.com/acme/widgets/pull/7');
  assert.match(items[0]!.summary, /Approved by pat/);
  assert.deepEqual(readyPrItems(null, [], []), []);
});

test('a pending review draft is an approve-review item with author, one-line summary and verdict; decided and reply drafts are not', () => {
  const data = drafts(
    draft(),
    draft({ id: 'dr-00000002', state: 'posted' }),
    draft({ id: 'dr-00000003', state: 'rejected' }),
    draft({ id: 'dr-00000004', source: 'reply', severity: 'reply', review: undefined }),
    draft({ id: 'dr-00000005', pr: 42, state: 'failed', review: { event: 'REQUEST_CHANGES', compliment: 'Clear naming.', comments: [] }, author: undefined, context: undefined }),
  );
  const items = reviewDraftItems(data, [card('acme/gadgets', 1, 'Green Gables')], ['Green Gables'], NOW);
  assert.deepEqual(items.map((i) => i.key), ['review:dr-00000001', 'review:dr-00000005']);
  const [a, b] = items;
  assert.equal(a!.kind, 'approve review');
  assert.equal(a!.stream, 'Green Gables');
  assert.equal(a!.author, 'robin');
  assert.equal(a!.verdict, 'approve');
  assert.equal(a!.summary, 'Approves: 0 blocking, 2 suggestion(s); 1a2b3c');
  assert.equal(a!.ageDays, 2);
  assert.equal(a!.url, 'https://github.com/acme/gadgets/pull/41');
  assert.equal(b!.verdict, 'request changes');
  assert.equal(b!.author, undefined);
  assert.equal(b!.summary, 'Clear naming.', 'without a context line the opening compliment stands in');
  assert.deepEqual(reviewDraftItems(null, [], [], NOW), []);
});

test('a repo with no known PR takes the stream named like it, else other', () => {
  assert.equal(streamOfRepo('acme/gadgets', [], ['gadgets', 'Avonlea']), 'gadgets');
  assert.equal(streamOfRepo('acme/gadgets', [], ['Avonlea']), 'other');
  assert.equal(streamOfRepo('acme/gadgets', [card('acme/gadgets', 1, 'Avonlea')], ['Avonlea']), 'Avonlea');
});

test('both kinds in one list: reviews first, scoped by stream, and the fingerprint moves when a row changes', () => {
  const items = needsItems(prs({ 'acme/widgets': [pr()] }), drafts(draft()), [card('acme/widgets', 7, 'Avonlea'), card('acme/gadgets', 1, 'Green Gables')], ['Avonlea', 'Green Gables'], NOW);
  assert.deepEqual(items.map((i) => i.kind), ['approve review', 'ready to merge']);
  assert.deepEqual(scopedItems(items, 'Avonlea').map((i) => i.kind), ['ready to merge']);
  assert.equal(scopedItems(items, null).length, 2);
  assert.notEqual(needsSig(items), needsSig(items.slice(1)));
  assert.equal(needsSig([]), '');
});
