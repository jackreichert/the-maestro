// Run: node --test scripts/web/client/test/blocked-api.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCommenter, GENERIC_FAILURE } from '../src/blocked-api.ts';

interface Call { url: string; init?: RequestInit }
function fake(answers: (Response | Error)[]): { fetch: (u: string, i?: RequestInit) => Promise<Response>; calls: Call[] } {
  const calls: Call[] = [];
  return { calls, fetch: async (url, init) => { calls.push({ url, ...(init ? { init } : {}) }); const a = answers.shift(); if (!a) throw new Error('unexpected call'); if (a instanceof Error) throw a; return a; } };
}
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('an unblock is posted as JSON with the token and returns what the server recorded', async () => {
  const f = fake([json(200, { token: 'tok' }), json(200, { ok: true, id: 'bl11', mode: 'unblock', comment: 'Go ahead', same: false, queued: 'qq01' })]);
  const out = await createCommenter(f.fetch).send({ id: 'bl11', mode: 'unblock', comment: 'Go ahead' });
  assert.deepEqual(out, { ok: true, comment: 'Go ahead', same: false, queued: 'qq01' });
  assert.equal(f.calls[1]?.url, '/api/blocked/comment');
  assert.equal(f.calls[1]?.init?.method, 'POST');
  assert.equal((f.calls[1]?.init?.headers as Record<string, string>)['x-podium-token'], 'tok');
  assert.deepEqual(JSON.parse(String(f.calls[1]?.init?.body)), { id: 'bl11', mode: 'unblock', comment: 'Go ahead' });
});

test('a comment-only reply has no queued id', async () => {
  const f = fake([json(200, { token: 'tok' }), json(200, { ok: true, id: 'bl11', mode: 'comment', comment: 'Wait', same: true })]);
  assert.deepEqual(await createCommenter(f.fetch).send({ id: 'bl11', mode: 'comment', comment: 'Wait' }), { ok: true, comment: 'Wait', same: true });
});

test('a refusal returns the server message, and says when the item is gone or already unblocked', async () => {
  const f = fake([json(200, { token: 'tok' }), json(409, { error: 'unblocked', message: 'That item is no longer blocked.' }), json(422, { error: 'invalid', message: 'Write a comment first.' }), json(404, { error: 'unknown', message: 'No such blocked item.' })]);
  const c = createCommenter(f.fetch);
  assert.deepEqual(await c.send({ id: 'bl11', mode: 'unblock', comment: 'x' }), { ok: false, message: 'That item is no longer blocked.', closed: true });
  assert.deepEqual(await c.send({ id: 'bl11', mode: 'unblock', comment: '' }), { ok: false, message: 'Write a comment first.', closed: false });
  assert.deepEqual(await c.send({ id: 'zz99', mode: 'unblock', comment: 'x' }), { ok: false, message: 'No such blocked item.', closed: true });
});

test('no token, an unreadable body and a dead network are messages, never throws', async () => {
  const none = await createCommenter(fake([json(500, {})]).fetch).send({ id: 'bl11', mode: 'comment', comment: 'x' });
  assert.equal(none.ok, false);
  const garbled = await createCommenter(fake([json(200, { token: 't' }), new Response('<html>', { status: 502 })]).fetch).send({ id: 'bl11', mode: 'comment', comment: 'x' });
  assert.deepEqual(garbled, { ok: false, message: GENERIC_FAILURE, closed: false });
  const down = await createCommenter(fake([json(200, { token: 't' }), new Error('offline')]).fetch).send({ id: 'bl11', mode: 'comment', comment: 'x' });
  assert.deepEqual(down, { ok: false, message: `Could not reach the server. ${GENERIC_FAILURE}`, closed: false });
});
