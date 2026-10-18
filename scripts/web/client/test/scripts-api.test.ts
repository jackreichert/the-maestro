// Run: node --test scripts/web/client/test/scripts-api.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScriptActions, loadScriptSource, loadScripts, sanitizeScript, sanitizeSource } from '../src/scripts-api.ts';

const ROW = { id: 'sc-0123abcd', kind: 'one-time', title: 'Close ticket', what: 'w', why: 'y', after: 'a', blocks: 'abcd', command: 'echo hi', createdAt: '2026-10-15T15:00:00.000Z', ask: 'ab12', status: 'blocked', askOpen: true, runs: 0 };
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
interface Call { url: string; init?: RequestInit }
function fake(answers: (Response | Error)[]): { fetch: (u: string, i?: RequestInit) => Promise<Response>; calls: Call[] } {
  const calls: Call[] = [];
  return { calls, fetch: async (url, init) => { calls.push({ url, ...(init ? { init } : {}) }); const a = answers.shift(); if (!a) throw new Error('unexpected call'); if (a instanceof Error) throw a; return a; } };
}

test('a well-formed row is kept, an optional field is carried, and every kind of malformed row is dropped', () => {
  assert.deepEqual(sanitizeScript(ROW), ROW);
  assert.equal(sanitizeScript({ ...ROW, blockedBy: 'agent: task', lastRun: { at: 't', result: 'done', via: 'podium' } })?.lastRun?.via, 'podium');
  for (const bad of [null, [], { ...ROW, kind: 'sometimes' }, { ...ROW, status: 'lost' }, { ...ROW, command: 5 }, { ...ROW, askOpen: 'yes' }, { ...ROW, runs: '2' }, { ...ROW, id: undefined }]) assert.equal(sanitizeScript(bad), null);
});

test('loadScripts returns the readable rows, and null when the server gives none', async () => {
  const f = fake([json(200, { scripts: [ROW, { nonsense: true }] })]);
  assert.deepEqual(await loadScripts(f.fetch), [ROW]);
  assert.equal(f.calls[0]?.url, '/api/scripts');
  assert.equal(await loadScripts(fake([json(500, {})]).fetch), null);
  assert.equal(await loadScripts(fake([json(200, { scripts: 'x' })]).fetch), null);
  assert.equal(await loadScripts(fake([new Error('down')]).fetch), null);
});

test('marking a script posts only its id with the token, and reports what the server did', async () => {
  const f = fake([json(200, { token: 'tok' }), json(200, { ok: true, id: ROW.id, resolvedAsk: true }), json(409, { error: 'finished', message: 'That one-time script is already finished.' })]);
  const a = createScriptActions(f.fetch);
  assert.deepEqual(await a.markRan(ROW.id), { ok: true, resolvedAsk: true });
  assert.equal(f.calls[1]?.url, '/api/scripts/ran');
  assert.deepEqual(JSON.parse(String(f.calls[1]?.init?.body)), { id: ROW.id });
  assert.equal((f.calls[1]?.init?.headers as Record<string, string>)['x-podium-token'], 'tok');
  assert.deepEqual(await a.markRan(ROW.id), { ok: false, message: 'That one-time script is already finished.' });
});

test('no token or no network is a message, never a throw', async () => {
  assert.match((await createScriptActions(fake([json(500, {})]).fetch).markRan(ROW.id) as { message: string }).message, /permission/);
  assert.match((await createScriptActions(fake([json(200, { token: 'tok' }), new Error('down')]).fetch).markRan(ROW.id) as { message: string }).message, /Could not reach/);
});

const SRC = { path: '/s/a.sh', role: 'script', lines: 4, mutates: 1, gates: 1, warn: false, modified: '2026-10-18T10:00:00.000Z', text: 'a\nb\n', marks: { 2: 'mutates', 3: 'gate' } };

test('a source file keeps only marks with a known kind, and a file missing a field is dropped', () => {
  assert.deepEqual(sanitizeSource(SRC), { ...SRC, marks: { 2: 'mutates', 3: 'gate' } });
  assert.deepEqual(sanitizeSource({ ...SRC, marks: { 2: 'mutates', x: 'gate', 5: 'evil' } })?.marks, { 2: 'mutates' });
  assert.equal(sanitizeSource({ ...SRC, hidden: 'missing', text: undefined })?.hidden, 'missing');
  for (const bad of [null, [], { ...SRC, role: 'other' }, { ...SRC, lines: -1 }, { ...SRC, mutates: '1' }, { ...SRC, warn: 'no' }, { ...SRC, path: 3 }]) assert.equal(sanitizeSource(bad), null);
});

test('loadScriptSource asks for one script by id and returns null when the server has none', async () => {
  const f = fake([json(200, { files: [SRC, { nonsense: 1 }] })]);
  assert.equal((await loadScriptSource('sc-0123abcd', f.fetch))?.length, 1);
  assert.equal(f.calls[0]?.url, '/api/scripts/sc-0123abcd/source');
  assert.equal(await loadScriptSource('sc-0123abcd', fake([json(404, {})]).fetch), null);
  assert.equal(await loadScriptSource('sc-0123abcd', fake([new Error('down')]).fetch), null);
});
