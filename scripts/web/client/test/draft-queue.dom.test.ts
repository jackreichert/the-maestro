// Run: node --test scripts/web/client/test/draft-queue.dom.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, mount } from './dom-harness.ts';
import type { DraftRow } from '../src/drafts-model.ts';
import type { DraftsModel } from '../src/drafts-store.ts';
import type { DraftActions } from '../src/draft-queue.ts';

installDom();
type El = HTMLElement & { model: DraftsModel; sources: string[]; actions: DraftActions; emptyText: string };
const row = (over: Partial<DraftRow> = {}): DraftRow => ({ rev: '0123456789ab', id: 'dr-0000000a', source: 'review', repo: 'acme/widgets', pr: 7, prUrl: 'https://github.com/acme/widgets/pull/7', severity: 'suggestion', text: 'Could this guard an empty list?', where: 'src/a.ts:3', context: 'Reads items[0] without a check', state: 'pending', createdAt: '2026-10-14T10:00:00Z', ...over });
const model = (drafts: DraftRow[], ui: DraftsModel['ui'] = {}): DraftsModel => ({ data: { generatedAt: '2026-10-14T11:00:00Z', drafts }, loaded: true, ui });
const noop: DraftActions = { startEdit() {}, startReject() {}, cancel() {}, setBuffer() {}, setComment() {}, saveEdit() {}, approve() {}, reject() {} };

test('a draft shows repo, PR link, file:line, severity in words, the text, and the three buttons', async () => {
  const { root, cleanup } = await mount<El>('../src/draft-queue.ts', 'draft-queue', { model: model([row()]), actions: noop, sources: ['review'] });
  const text = root.textContent ?? '';
  assert.match(text, /acme\/widgets#7/);
  assert.match(text, /Suggestion/);
  assert.match(text, /src\/a\.ts:3/);
  assert.match(text, /Could this guard an empty list\?/);
  assert.deepEqual([...root.querySelectorAll('button')].map((b) => b.textContent), ['Approve', 'Edit', 'Reject']);
  assert.equal(root.querySelector('h3 a')?.getAttribute('href'), 'https://github.com/acme/widgets/pull/7');
  cleanup();
});

test('the buttons call the actions with the draft id; nothing else is wired', async () => {
  const calls: string[] = [];
  const actions: DraftActions = { ...noop, approve: (id) => calls.push(`approve ${id}`), startEdit: (id) => calls.push(`edit ${id}`), startReject: (id) => calls.push(`reject ${id}`) };
  const { root, cleanup } = await mount<El>('../src/draft-queue.ts', 'draft-queue', { model: model([row()]), actions, sources: ['review'] });
  for (const b of root.querySelectorAll('button')) (b as HTMLButtonElement).click();
  assert.deepEqual(calls, ['approve dr-0000000a', 'edit dr-0000000a', 'reject dr-0000000a']);
  cleanup();
});

test('edit mode shows a textarea with the buffer and Save/Cancel; typing reports the buffer', async () => {
  const typed: string[] = [];
  const { root, cleanup } = await mount<El>('../src/draft-queue.ts', 'draft-queue', { model: model([row()], { 'dr-0000000a': { mode: 'edit', buffer: 'Softer.', busy: false } }), actions: { ...noop, setBuffer: (_i: string, t: string) => typed.push(t) }, sources: ['review'] });
  const ta = root.querySelector('textarea') as HTMLTextAreaElement;
  assert.equal(ta.value, 'Softer.');
  ta.value = 'Softer still.'; ta.dispatchEvent(new Event('input'));
  assert.deepEqual(typed, ['Softer still.']);
  assert.deepEqual([...root.querySelectorAll('button')].map((b) => b.textContent), ['Save', 'Cancel']);
  cleanup();
});

test('reject mode asks why and says nothing is posted', async () => {
  const { root, cleanup } = await mount<El>('../src/draft-queue.ts', 'draft-queue', { model: model([row()], { 'dr-0000000a': { mode: 'reject', buffer: '', busy: false } }), actions: noop, sources: ['review'] });
  assert.match(root.textContent ?? '', /nothing is posted/);
  assert.ok(root.querySelector('input[type=text]'));
  cleanup();
});

test('sources filter the tab: replies do not show on the review tab, and posted or rejected drafts fold under Decided', async () => {
  const drafts = [row(), row({ id: 'dr-0000000b', source: 'reply', severity: 'reply', text: 'Fixed in the next commit.' }), row({ id: 'dr-0000000c', state: 'rejected', rejectReason: 'covered', text: 'Old one.' }), row({ id: 'dr-0000000d', state: 'posted', postedUrl: 'https://github.com/acme/widgets/pull/7#r1', text: 'Posted one.' })];
  const { root, cleanup } = await mount<El>('../src/draft-queue.ts', 'draft-queue', { model: model(drafts), actions: noop, sources: ['review'] });
  assert.equal(root.querySelectorAll('li.draft').length, 3);
  assert.doesNotMatch(root.textContent ?? '', /Fixed in the next commit/);
  assert.match(root.querySelector('details.finished')?.textContent ?? '', /Decided \(2\)/);
  assert.match(root.querySelector('details.finished')?.textContent ?? '', /Rejected: covered/);
  assert.equal(root.querySelectorAll('details.finished button').length, 0, 'decided drafts have no buttons');
  cleanup();
});

test('a failed draft shows the refusal and can be approved again; an unloaded queue says so', async () => {
  const { root, cleanup } = await mount<El>('../src/draft-queue.ts', 'draft-queue', { model: model([row({ state: 'failed', error: 'HTTP 422' })]), actions: noop, sources: ['review'] });
  assert.match(root.textContent ?? '', /Nothing was posted/);
  assert.equal(root.querySelectorAll('button').length, 3);
  cleanup();
  const none = await mount<El>('../src/draft-queue.ts', 'draft-queue', { model: { data: null, loaded: true, ui: {} }, actions: noop, sources: ['review'] });
  assert.match(none.root.textContent ?? '', /not available/);
  none.cleanup();
});

test('text from a draft is set as text, never as markup', async () => {
  const { root, cleanup } = await mount<El>('../src/draft-queue.ts', 'draft-queue', { model: model([row({ text: '<img src=x onerror=alert(1)>' })]), actions: noop, sources: ['review'] });
  assert.equal(root.querySelector('img'), null);
  cleanup();
});

test('a review shows its event in words, its compliment-first body and each inline comment with file:line; edit has a box per comment', async () => {
  const review = row({ severity: 'review', text: 'The ID validation before anything goes into a URL is exactly right.\n\nResolve these however you think best.', review: { event: 'REQUEST_CHANGES', compliment: 'The ID validation before anything goes into a URL is exactly right.', comments: [{ path: 'src/a.ts', line: 3, text: 'This crashes on an empty cart.', severity: 'blocking' }, { path: 'src/b.ts', line: 8, text: 'Could we name this once?', severity: 'suggestion' }] } });
  const view = await mount<El>('../src/draft-queue.ts', 'draft-queue', { model: model([review]), actions: noop, sources: ['review'] });
  const text = view.root.textContent ?? '';
  assert.match(text, /Review: request changes/);
  assert.match(text, /src\/a\.ts:3/);
  assert.match(text, /Blocking/);
  assert.match(text, /ID validation before anything goes into a URL/);
  view.cleanup();
  const edit = await mount<El>('../src/draft-queue.ts', 'draft-queue', { model: model([review], { 'dr-0000000a': { mode: 'edit', buffer: review.text, comments: ['This crashes on an empty cart.', 'Could we name this once?'], busy: false } }), actions: noop, sources: ['review'] });
  assert.equal(edit.root.querySelectorAll('textarea').length, 3);
  edit.cleanup();
});

test('an uncertain or in-flight draft stays in the open list with Reject only: the person checks GitHub, and cannot approve or edit it', async () => {
  for (const state of ['uncertain', 'posting'] as const) {
    const { root, cleanup } = await mount<El>('../src/draft-queue.ts', 'draft-queue', { model: model([row({ state })]), actions: noop, sources: ['review'] });
    assert.deepEqual([...root.querySelectorAll('button')].map((b) => b.textContent), ['Reject'], state);
    assert.equal(root.querySelector('details.finished'), null, state);
    cleanup();
  }
});

test('a draft left approved shows Approve and Reject (no Edit), so it is never stuck without a control', async () => {
  const { root, cleanup } = await mount<El>('../src/draft-queue.ts', 'draft-queue', { model: model([row({ state: 'approved' })]), actions: noop, sources: ['review'] });
  assert.deepEqual([...root.querySelectorAll('button')].map((b) => b.textContent), ['Approve', 'Reject']);
  cleanup();
});

test('on the Open PRs tab the queue shows only replies, one section per PR, each naming the person it answers', async () => {
  const reply = (over: Partial<DraftRow>): DraftRow => row({ source: 'reply', severity: 'reply', where: undefined, replyTo: 'jane', text: 'Fixed in the next commit.', ...over });
  const drafts = [reply({ id: 'dr-00000001' }), reply({ id: 'dr-00000002', pr: 9, prUrl: 'https://github.com/acme/widgets/pull/9', text: 'I would keep it: order matters.' }), row({ id: 'dr-00000003' })];
  const { root, cleanup } = await mount<El>('../src/draft-queue.ts', 'draft-queue', { model: model(drafts), actions: noop, sources: ['reply'] });
  assert.deepEqual([...root.querySelectorAll('section.pr h3')].map((h) => h.textContent), ['acme/widgets#7', 'acme/widgets#9']);
  assert.equal(root.querySelectorAll('li.draft').length, 2, 'the review draft is not shown here');
  assert.match(root.textContent ?? '', /answering jane/);
  assert.match(root.textContent ?? '', /Reply/);
  cleanup();
});

test('match limits the waiting drafts shown, and quiet leaves out the Decided list and an empty line', async () => {
  const drafts = [row(), row({ id: 'dr-0000000b', pr: 8, prUrl: 'https://github.com/acme/widgets/pull/8' }), row({ id: 'dr-0000000c', state: 'rejected', text: 'Old one.' })];
  const { root, cleanup } = await mount<El & { match: (d: DraftRow) => boolean; quiet: boolean }>('../src/draft-queue.ts', 'draft-queue', { model: model(drafts), actions: noop, sources: ['review'], match: (d: DraftRow) => d.pr === 8, quiet: true });
  assert.deepEqual([...root.querySelectorAll('li.draft')].map((l) => l.getAttribute('data-id')), ['dr-0000000b']);
  assert.equal(root.querySelector('details.finished'), null);
  cleanup();
  const none = await mount<El & { match: (d: DraftRow) => boolean; quiet: boolean }>('../src/draft-queue.ts', 'draft-queue', { model: model(drafts), actions: noop, sources: ['review'], match: () => false, emptyText: '', quiet: true });
  assert.equal(none.root.querySelector('.empty'), null);
  none.cleanup();
});

test('each card names whose PR it is beside repo#number: the draft\'s author, or what authorOf supplies, and nothing invented', async () => {
  const drafts = [row({ author: 'pat-fake' }), row({ id: 'dr-0000000b', pr: 8, prUrl: 'https://github.com/acme/widgets/pull/8' }), row({ id: 'dr-0000000c', pr: 9, prUrl: 'https://github.com/acme/widgets/pull/9', state: 'rejected', author: 'old-fake' })];
  const { root, cleanup } = await mount<El & { authorOf: (d: DraftRow) => string | undefined }>('../src/draft-queue.ts', 'draft-queue', { model: model(drafts), actions: noop, sources: ['review'] });
  const heads = [...root.querySelectorAll('section.pr h3')].map((h) => h.textContent);
  assert.deepEqual(heads, ['acme/widgets#7 by pat-fake', 'acme/widgets#8']);
  assert.match(root.querySelector('details.finished')?.textContent ?? '', /acme\/widgets#9 by old-fake/);
  cleanup();
  const fb = await mount<El & { authorOf: (d: DraftRow) => string | undefined }>('../src/draft-queue.ts', 'draft-queue', { model: model(drafts), actions: noop, sources: ['review'], authorOf: (d: DraftRow) => d.author ?? 'list-author' });
  assert.equal(fb.root.querySelectorAll('section.pr h3')[1]?.textContent, 'acme/widgets#8 by list-author');
  fb.cleanup();
});
