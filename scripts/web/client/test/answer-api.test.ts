// Run: node --test scripts/web/client/test/answer-api.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canSkip, createAnswerer } from '../src/answer-api.ts';

interface Call { url: string; init?: RequestInit }
function fake(answers: (Response | Error)[]): { fetch: (u: string, i?: RequestInit) => Promise<Response>; calls: Call[] } {
  const calls: Call[] = [];
  return { calls, fetch: async (url, init) => { calls.push({ url, ...(init ? { init } : {}) }); const a = answers.shift(); if (!a) throw new Error('unexpected call'); if (a instanceof Error) throw a; return a; } };
}
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('an answer is posted as JSON with the token and comes back as what the server recorded', async () => {
  const f = fake([json(200, { token: 'tok' }), json(200, { ok: true, id: 'ab12', answer: 'Take the recommendation: Merge it' })]);
  const out = await createAnswerer(f.fetch).send({ id: 'ab12', mode: 'recommend' });
  assert.deepEqual(out, { ok: true, answer: 'Take the recommendation: Merge it' });
  assert.equal(f.calls[1]?.url, '/api/asks/answer');
  assert.equal(f.calls[1]?.init?.method, 'POST');
  assert.equal((f.calls[1]?.init?.headers as Record<string, string>)['x-podium-token'], 'tok');
  assert.deepEqual(JSON.parse(String(f.calls[1]?.init?.body)), { id: 'ab12', mode: 'recommend' });
});

test('a refusal returns the server message, and says when the ask is already closed', async () => {
  const f = fake([json(200, { token: 'tok' }), json(409, { error: 'answered', message: 'That ask is already closed.' }), json(422, { error: 'invalid', message: 'Write an answer first.' }), json(409, { error: 'pending', message: 'Already typed in the note.' })]);
  const a = createAnswerer(f.fetch);
  assert.deepEqual(await a.send({ id: 'ab12', mode: 'skip' }), { ok: false, message: 'That ask is already closed.', closed: true });
  assert.deepEqual(await a.send({ id: 'ab12', mode: 'text', answer: '' }), { ok: false, message: 'Write an answer first.', closed: false });
  assert.deepEqual(await a.send({ id: 'ab12', mode: 'skip' }), { ok: false, message: 'Already typed in the note.', closed: false }, 'a pending note answer is not a closed ask');
});

test('a dead token is fetched again once; no token, an unreadable body and a dead network are messages, never throws', async () => {
  const f = fake([json(200, { token: 'old' }), json(403, { error: 'forbidden' }), json(200, { token: 'new' }), json(200, { ok: true, id: 'ab12', answer: 'x' })]);
  assert.equal((await createAnswerer(f.fetch).send({ id: 'ab12', mode: 'skip' })).ok, true);
  assert.equal((f.calls[3]?.init?.headers as Record<string, string>)['x-podium-token'], 'new');

  const none = await createAnswerer(fake([json(500, {})]).fetch).send({ id: 'ab12', mode: 'skip' });
  assert.equal(none.ok, false);
  const garbled = await createAnswerer(fake([json(200, { token: 't' }), new Response('<html>', { status: 502 })]).fetch).send({ id: 'ab12', mode: 'skip' });
  assert.deepEqual(garbled, { ok: false, message: 'The answer was not saved. Try again.', closed: false });
  const down = await createAnswerer(fake([json(200, { token: 't' }), new Error('offline')]).fetch).send({ id: 'ab12', mode: 'skip' });
  assert.match(down.ok ? '' : down.message, /^Could not reach the server\./);
});

test('Skip is offered on a two-way ask only; no door recorded counts as one-way', () => {
  assert.equal(canSkip({ door: 'two-way' }), true);
  assert.equal(canSkip({ door: 'one-way' }), false);
  assert.equal(canSkip({}), false);
});
