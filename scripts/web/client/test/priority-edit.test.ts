// Run: node --test scripts/web/client/test/priority-edit.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionLabel, addBlockedReason, counter, moveItem, removeItem } from '../src/priority-edit.ts';
import { createEditor } from '../src/priorities-api.ts';

test('counter reads N of cap and flags full and over', () => {
  assert.deepEqual(counter(3, 5), { label: '3 of 5', full: false, over: false });
  assert.deepEqual(counter(5, 5), { label: '5 of 5', full: true, over: false });
  assert.deepEqual(counter(6, 5), { label: '6 of 5', full: true, over: true });
});

test('addBlockedReason says remove one first at the cap and how many to remove when over', () => {
  assert.equal(addBlockedReason(4, 5), null);
  assert.match(addBlockedReason(5, 5) ?? '', /Full \(5 of 5\)\. Remove one first\./);
  assert.match(addBlockedReason(6, 5) ?? '', /Over the cap \(6 of 5\)\. Remove 1 to add another\./);
  assert.match(addBlockedReason(8, 5) ?? '', /Remove 3 /);
});

test('moveItem and removeItem copy, never mutate, and ignore a bad index', () => {
  const a = ['a', 'b', 'c'];
  assert.deepEqual(moveItem(a, 0, 2), ['b', 'c', 'a']);
  assert.deepEqual(moveItem(a, 2, 0), ['c', 'a', 'b']);
  assert.deepEqual(moveItem(a, 1, 1), a);
  for (const [f, t] of [[-1, 0], [0, 3], [3, 0], [0.5, 1], [0, Number.NaN]] as [number, number][]) assert.deepEqual(moveItem(a, f, t), a);
  assert.deepEqual(removeItem(a, 1), ['a', 'c']);
  assert.deepEqual(removeItem(a, 9), a);
  assert.deepEqual(a, ['a', 'b', 'c']);
});

test('actionLabel names the priority the button acts on', () => {
  assert.equal(actionLabel('Move up', { text: 'Ship it', stream: 'Alpha' }), 'Move up: Ship it');
});

interface Call { url: string; init?: RequestInit }
/** A fetch that answers from a script, newest call last, and records what was asked. */
function fake(answers: (Response | Error)[]): { fetch: (u: string, i?: RequestInit) => Promise<Response>; calls: Call[] } {
  const calls: Call[] = [];
  return { calls, fetch: async (url, init) => { calls.push({ url, ...(init ? { init } : {}) }); const a = answers.shift(); if (!a) throw new Error('unexpected call'); if (a instanceof Error) throw a; return a; } };
}
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const LIST = { priorities: { state: 'ok', date: '2026-10-07', items: [{ text: 'a' }, { text: 'b', stream: 'Alpha' }] }, max: 5 };

test('a write fetches the token once, sends it as a header with a JSON body, and returns the server list', async () => {
  const f = fake([json(200, { token: 'tok', max: 5 }), json(200, LIST), json(200, LIST)]);
  const ed = createEditor(f.fetch);
  const out = await ed.send({ op: 'move', from: 1, to: 0, text: 'b' });
  assert.deepEqual(out, { ok: true, items: [{ text: 'a' }, { text: 'b', stream: 'Alpha' }], max: 5 });
  assert.equal(f.calls[1]?.url, '/api/priorities/move');
  assert.equal(f.calls[1]?.init?.method, 'POST');
  const headers = f.calls[1]?.init?.headers as Record<string, string>;
  assert.equal(headers['x-podium-token'], 'tok');
  assert.equal(headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(String(f.calls[1]?.init?.body)), { from: 1, to: 0, text: 'b' }, 'the op is in the path, not the body');
  await ed.send({ op: 'add', text: 'c' });
  assert.equal(f.calls.length, 3, 'the token is not fetched again');
});

test('a refused edit returns the server message and the server list, so the page can roll back to the truth', async () => {
  const f = fake([json(200, { token: 'tok' }), json(409, { error: 'cap', message: 'Priorities are full (5 of 5): remove one first.', ...LIST })]);
  const out = await createEditor(f.fetch).send({ op: 'add', text: 'x' });
  assert.equal(out.ok, false);
  assert.ok(!out.ok && /remove one first/.test(out.message));
  assert.ok(!out.ok && out.items?.length === 2 && out.max === 5);
});

test('a dead token (403) is replaced once and the edit retried; a second 403 gives up', async () => {
  const f = fake([json(200, { token: 'old' }), json(403, { error: 'forbidden' }), json(200, { token: 'new' }), json(200, LIST)]);
  assert.equal((await createEditor(f.fetch).send({ op: 'add', text: 'x' })).ok, true);
  assert.equal((f.calls[3]?.init?.headers as Record<string, string>)['x-podium-token'], 'new');
  const g = fake([json(200, { token: 'old' }), json(403, {}), json(200, { token: 'new' }), json(403, {})]);
  assert.equal((await createEditor(g.fetch).send({ op: 'add', text: 'x' })).ok, false);
});

test('no token, a network failure and an unreadable answer are each a message, never an exception', async () => {
  assert.equal((await createEditor(fake([json(500, {})]).fetch).send({ op: 'add', text: 'x' })).ok, false);
  assert.equal((await createEditor(fake([new Error('down')]).fetch).send({ op: 'add', text: 'x' })).ok, false);
  const out = await createEditor(fake([json(200, { token: 't' }), new Response('<html>', { status: 502 })]).fetch).send({ op: 'add', text: 'x' });
  assert.ok(!out.ok && out.message.length > 0 && out.items === undefined);
  const net = await createEditor(fake([json(200, { token: 't' }), new Error('reset')]).fetch).send({ op: 'delete', index: 0, text: 'x' });
  assert.ok(!net.ok && /Could not reach the server/.test(net.message));
});

test('malformed rows in the server list are dropped, not trusted', async () => {
  const f = fake([json(200, { token: 't' }), json(200, { priorities: { state: 'ok', date: '2026-10-07', items: [{ text: 'good' }, { text: 5 }, 'junk'] }, max: 5 })]);
  const out = await createEditor(f.fetch).send({ op: 'add', text: 'x' });
  assert.deepEqual(out.ok && out.items, [{ text: 'good' }]);
});

test('refuseDraft says why before a guess is shown, and lets ordinary text through', async () => {
  const { refuseDraft } = await import('../src/priority-edit.ts');
  assert.equal(refuseDraft('Ship the widget (v2) & more'), null);
  assert.match(refuseDraft('x'.repeat(201)) ?? '', /at most 200/);
  assert.match(refuseDraft('<b>hi</b>') ?? '', /angle brackets/);
  assert.match(refuseDraft('a | Alpha') ?? '', /stream box/);
  assert.match(refuseDraft('bell\u0007') ?? '', /one line/);
});
