// Run: node --test scripts/web/client/test/drafts-store.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeDrafts } from '../src/drafts-model.ts';
import type { DraftRow, DraftsData } from '../src/drafts-model.ts';
import { DraftsStore } from '../src/drafts-store.ts';
import type { DraftOp, DraftOutcome } from '../src/drafts-api.ts';

const row = (over: Partial<DraftRow> = {}): DraftRow => ({ rev: '0123456789ab', id: 'dr-0000000a', source: 'review', repo: 'acme/widgets', pr: 7, prUrl: 'https://github.com/acme/widgets/pull/7', severity: 'suggestion', text: 'Could this guard an empty list?', state: 'pending', createdAt: '2026-10-14T10:00:00Z', ...over });
const data = (...drafts: DraftRow[]): DraftsData => ({ generatedAt: '2026-10-14T11:00:00Z', drafts });

function rig(outcome: DraftOutcome = { ok: true }) {
  const sent: { op: DraftOp; payload: Record<string, string> }[] = [];
  let current = data(row());
  const store = new DraftsStore({ load: async () => current, send: async (op, payload) => { sent.push({ op, payload }); return outcome; } });
  return { store, sent, set: (d: DraftsData) => { current = d; } };
}

test('sanitizeDrafts keeps well-formed rows and drops the rest', () => {
  const got = sanitizeDrafts({ generatedAt: 'x', drafts: [row(), { id: 'bad' }, { ...row(), state: 'weird' }, { ...row(), id: 'dr-0000000b', pr: 'seven' }] });
  assert.equal(got?.data.drafts.length, 1);
  assert.equal(got?.dropped, 3);
  assert.equal(sanitizeDrafts({ drafts: [] }), null);
  assert.equal(sanitizeDrafts('nope'), null);
});

test('approve names the revision the card shows, then reloads for the server state', async () => {
  const { store, sent, set } = rig();
  await store.load();
  set(data(row({ state: 'posted' })));
  await store.approve('dr-0000000a');
  assert.deepEqual(sent.map(({ op, payload }) => ({ op, payload })), [{ op: 'approve', payload: { id: 'dr-0000000a', rev: '0123456789ab' } }]);
  assert.equal(store.model.data?.drafts[0]?.state, 'posted');
  assert.equal(store.model.ui['dr-0000000a']?.message, 'Posted.');
});

test('edit keeps the typing across redraws, saves it, and never approves by itself', async () => {
  const { store, sent } = rig();
  await store.load();
  store.startEdit('dr-0000000a');
  assert.equal(store.model.ui['dr-0000000a']?.buffer, 'Could this guard an empty list?');
  store.setBuffer('dr-0000000a', 'Softer wording.');
  await store.saveEdit('dr-0000000a');
  assert.deepEqual(sent.map((s) => s.op), ['edit']);
  assert.equal(sent[0]?.payload.text, 'Softer wording.');
});

test('reject sends the reason; a refusal keeps the card open with the server message', async () => {
  const bad = rig({ ok: false, message: 'Say why, in a few words.' });
  await bad.store.load();
  bad.store.startReject('dr-0000000a');
  await bad.store.reject('dr-0000000a');
  assert.equal(bad.store.model.ui['dr-0000000a']?.mode, 'reject');
  assert.equal(bad.store.model.ui['dr-0000000a']?.message, 'Say why, in a few words.');
  const good = rig();
  await good.store.load();
  good.store.startReject('dr-0000000a');
  good.store.setBuffer('dr-0000000a', 'already covered');
  await good.store.reject('dr-0000000a');
  assert.deepEqual(good.sent, [{ op: 'reject', payload: { id: 'dr-0000000a', reason: 'already covered' } }]);
});

test('a double press while a decision is in flight makes one request', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((ok) => { release = ok; });
  let calls = 0;
  const store = new DraftsStore({ load: async () => data(row()), send: async () => { calls += 1; await gate; return { ok: true }; } });
  await store.load();
  const first = store.approve('dr-0000000a');
  await store.approve('dr-0000000a');
  release();
  await first;
  assert.equal(calls, 1);
});

test('a review card edits its inline comments through the store and sends them with the edit', async () => {
  const review: DraftRow = row({ severity: 'review', rev: 'abcdef012345', review: { event: 'APPROVE', compliment: 'Nice validation.', comments: [{ path: 'a.ts', line: 3, text: 'One.', severity: 'suggestion' }, { path: 'b.ts', line: 9, text: 'Two.', severity: 'suggestion' }] } });
  const seen: (string[] | undefined)[] = [];
  const store = new DraftsStore({ load: async () => data(review), send: async (_op, _p, comments) => { seen.push(comments); return { ok: true }; } });
  await store.load();
  store.startEdit('dr-0000000a');
  assert.deepEqual(store.model.ui['dr-0000000a']?.comments, ['One.', 'Two.']);
  store.setComment('dr-0000000a', 1, '');
  await store.saveEdit('dr-0000000a');
  assert.deepEqual(seen, [['One.', '']]);
});

test('approve as a comment sends `as: comment` with the same revision; a plain approve sends no `as`', async () => {
  const { store, sent } = rig();
  await store.load();
  await store.approve('dr-0000000a', 'comment');
  assert.deepEqual(sent.map(({ payload }) => payload), [{ id: 'dr-0000000a', rev: '0123456789ab', as: 'comment' }]);
});
