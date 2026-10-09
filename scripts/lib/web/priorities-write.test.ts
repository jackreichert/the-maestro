// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/lib/web/priorities-write.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWebServer } from './server.ts';
import { parseEdit } from './priorities-write.ts';
import { sanitizeState } from '../../web/client/src/contract.ts';

const NOW = new Date('2026-10-07T15:00:00Z');
const TOKEN = 'test-token-0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab';
const root = mkdtempSync(join(tmpdir(), 'web-write-'));
const client = join(root, 'client');
mkdirSync(join(client, 'dist'), { recursive: true });
writeFileSync(join(client, 'index.html'), '<p>home</p>');

interface Rig { server: Server; port: number; vault: string; statusDir: string; file: string; ledger: string; logged: string[] }
const rigs: Rig[] = [];
async function rig(name: string, o: { max?: number; initial?: string } = {}): Promise<Rig> {
  const vault = join(root, name);
  const statusDir = join(vault, 'Status');
  mkdirSync(statusDir, { recursive: true });
  const file = join(statusDir, 'priorities.md');
  if (o.initial !== undefined) writeFileSync(file, o.initial);
  const logged: string[] = [];
  const server = createWebServer({
    web: { vault, project: 'p', statusDir, prioritiesMax: o.max ?? 5, page: { streams: ['Alpha', 'Beta'], repoStreams: {}, vaultName: '', trackerUrlBase: '', ticketNotePath: '', trackerKeyPattern: 'FAKE-\\d+', tz: 'UTC' } },
    clientDir: client, now: () => NOW, log: (m) => logged.push(m), token: TOKEN,
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const r = { server, port: (server.address() as AddressInfo).port, vault, statusDir, file, ledger: join(vault, 'Projects', 'p', 'Journal', 'ledger.jsonl'), logged };
  rigs.push(r);
  return r;
}
after(() => { for (const r of rigs) r.server.close(); });

interface Reply { status: number; json: Record<string, any>; headers: Record<string, unknown> }
function send(r: Rig, path: string, o: { method?: string; body?: unknown; raw?: string; headers?: Record<string, string>; token?: string | null } = {}): Promise<Reply> {
  const body = o.raw ?? (o.body === undefined ? '' : JSON.stringify(o.body));
  const headers: Record<string, string> = { host: `127.0.0.1:${r.port}`, origin: `http://127.0.0.1:${r.port}`, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), ...o.headers };
  if (o.token !== null) headers['x-podium-token'] = o.token ?? TOKEN;
  for (const k of Object.keys(headers)) if (headers[k] === '') delete headers[k];
  return new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port: r.port, path, method: o.method ?? 'POST', headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => { let json: Record<string, any> = {}; try { json = JSON.parse(text); } catch { /* not JSON */ } ok({ status: res.statusCode ?? 0, json, headers: res.headers }); });
    });
    req.on('error', fail);
    req.end(body);
  });
}
const post = (r: Rig, op: string, body: unknown, o: Parameters<typeof send>[2] = {}): Promise<Reply> => send(r, `/api/priorities/${op}`, { body, ...o });
const read = (r: Rig): string => readFileSync(r.file, 'utf8');
const ledgerRows = (r: Rig): Record<string, any>[] => (existsSync(r.ledger) ? readFileSync(r.ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const LIST = 'date: 2026-10-07\n- one | Alpha\n- two\n- three\n';

test('the token endpoint hands the page its token and the cap, and the state carries the cap', async () => {
  const r = await rig('token', { initial: LIST, max: 4 });
  const t = await send(r, '/api/edit-token', { method: 'GET', token: null, headers: { origin: '', 'content-type': '', 'content-length': '' } });
  assert.equal(t.status, 200);
  assert.deepEqual(t.json, { token: TOKEN, max: 4 });
  const s = await send(r, '/api/state', { method: 'GET', token: null, headers: { origin: '', 'content-type': '', 'content-length': '' } });
  assert.equal(s.json.prioritiesMax, 4);
  assert.equal(sanitizeState(s.json)?.state.prioritiesMax, 4);
});

test('each start gets its own random token', async () => {
  const a = createWebServer({ web: { vault: root, project: 'p', statusDir: root, page: { streams: [], repoStreams: {}, vaultName: '', trackerUrlBase: '', ticketNotePath: '', trackerKeyPattern: 'X-\\d+', tz: 'UTC' } }, clientDir: client });
  const b = createWebServer({ web: { vault: root, project: 'p', statusDir: root, page: { streams: [], repoStreams: {}, vaultName: '', trackerUrlBase: '', ticketNotePath: '', trackerKeyPattern: 'X-\\d+', tz: 'UTC' } }, clientDir: client });
  const tokens: string[] = [];
  for (const s of [a, b]) {
    await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok));
    const p = (s.address() as AddressInfo).port;
    const t = await send({ port: p } as Rig, '/api/edit-token', { method: 'GET', token: null, headers: { host: `127.0.0.1:${p}`, origin: '', 'content-type': '', 'content-length': '' } });
    tokens.push(t.json.token);
    s.close();
  }
  assert.match(tokens[0] ?? '', /^[0-9a-f]{64}$/);
  assert.notEqual(tokens[0], tokens[1]);
});

test('move, add and delete edit the file, answer with the real list, and leave one closed note each in the ledger', async () => {
  const r = await rig('happy', { initial: '# mine\n' + LIST });
  let res = await post(r, 'move', { from: 2, to: 0, text: 'three' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.priorities.items.map((i: { text: string }) => i.text), ['three', 'one', 'two']);
  assert.equal(res.json.max, 5);
  res = await post(r, 'add', { text: 'four', stream: 'Beta' });
  assert.equal(res.status, 200);
  res = await post(r, 'delete', { index: 1, text: 'one' });
  assert.equal(res.status, 200);
  assert.equal(read(r), '# mine\ndate: 2026-10-07\n- three\n- two\n- four | Beta\n');
  assert.deepEqual(readdirSync(r.statusDir), ['priorities.md'], 'no temp file is left');
  const rows = ledgerRows(r);
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.filter((_, i) => i % 2 === 0).map((n) => n.kind), ['note', 'note', 'note']);
  assert.deepEqual(rows.filter((_, i) => i % 2 === 1).map((n) => [n.kind, n.closes]), rows.filter((_, i) => i % 2 === 0).map((n) => ['resolved', n.id]));
  assert.match(rows[0]?.text, /^Podium priorities: moved priority 3 to 1: three$/);
  const state = (await send(r, '/api/state', { method: 'GET', token: null, headers: { origin: '', 'content-type': '', 'content-length': '' } })).json;
  assert.deepEqual([state.asks.length, state.working.length, state.blocked.length, state.done.length], [0, 0, 0, 0], 'the closed notes show up as no work');
});

test('a write with no token, a wrong token or a near-miss token changes nothing', async () => {
  const r = await rig('token-check', { initial: LIST });
  for (const token of [null, '', 'wrong', TOKEN.slice(0, -1), `${TOKEN}0`]) {
    const res = await post(r, 'add', { text: 'sneaky' }, { token });
    assert.equal(res.status, 403, String(token));
  }
  assert.equal(read(r), LIST);
  assert.equal(ledgerRows(r).length, 0);
});

test('a cross-origin page cannot write: foreign or missing Origin, cross-site fetch, rebound host, wrong content type', async () => {
  const r = await rig('csrf', { initial: LIST });
  const body = { text: 'sneaky' };
  const cases: [string, Parameters<typeof send>[2], number][] = [
    ['foreign origin', { headers: { origin: 'https://evil.example' } }, 403],
    ['null origin', { headers: { origin: 'null' } }, 403],
    ['no origin', { headers: { origin: '' } }, 403],
    ['cross-site', { headers: { 'sec-fetch-site': 'cross-site' } }, 403],
    ['same-site', { headers: { 'sec-fetch-site': 'same-site' } }, 403],
    ['rebound host', { headers: { host: `evil.example:${r.port}` } }, 403],
    ['text/plain form post', { headers: { 'content-type': 'text/plain' } }, 415],
    ['urlencoded form post', { headers: { 'content-type': 'application/x-www-form-urlencoded' } }, 415],
  ];
  for (const [name, o, status] of cases) assert.equal((await post(r, 'add', body, o)).status, status, name);
  assert.equal((await send(r, '/api/priorities/add', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } })).status, 403);
  assert.equal((await send(r, '/api/priorities/add', { method: 'OPTIONS' })).status, 405, 'no preflight is ever answered');
  assert.equal(read(r), LIST);
  assert.equal(ledgerRows(r).length, 0);
});

test('only the write routes take POST; everything else, and every other method, is 405', async () => {
  const r = await rig('methods', { initial: LIST });
  for (const path of ['/api/state', '/api/edit-token', '/api/events', '/api/priorities', '/api/priorities/add/', '/api/priorities/reset', '/index.html', '/']) assert.equal((await send(r, path, { body: {} })).status, 405, `POST ${path}`);
  for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
    const res = await send(r, '/api/priorities/delete', { method, body: {} });
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.allow, 'POST', method);
  }
  assert.equal(read(r), LIST);
});

test('a body that is not exactly the shape of its route is 400, and bad text is 422; neither writes', async () => {
  const r = await rig('schema', { initial: LIST });
  const bad: [string, unknown][] = [
    ['add', {}], ['add', { text: 5 }], ['add', { text: 'x', extra: 1 }], ['add', { text: 'x', stream: 5 }], ['add', { text: 'x'.repeat(401) }], ['add', { text: 'x', stream: 'y'.repeat(41) }], ['add', []], ['add', null],
    ['move', { from: 0, to: 1 }], ['move', { from: '0', to: 1, text: 'one' }], ['move', { from: -1, to: 1, text: 'one' }], ['move', { from: 0.5, to: 1, text: 'one' }], ['move', { from: 0, to: 1e9, text: 'one' }],
    ['delete', { index: 0 }], ['delete', { index: 0, text: 'one', stream: 'Alpha' }], ['delete', { index: null, text: 'one' }],
  ];
  for (const [op, body] of bad) assert.equal((await post(r, op, body)).status, 400, `${op} ${JSON.stringify(body)}`);
  assert.equal((await send(r, '/api/priorities/add', { raw: '{not json' })).status, 400);
  assert.equal((await send(r, '/api/priorities/add', { raw: 'x'.repeat(3000) })).status, 413);
  for (const text of ['<script>alert(1)</script>', 'a | b', '[x] box', 'two\nlines']) {
    const res = await post(r, 'add', { text });
    assert.equal(res.status, 422, text);
    assert.equal(res.json.error, 'invalid');
    assert.doesNotMatch(JSON.stringify(res.json), /script|two\\nlines/, 'the request text is never echoed back');
  }
  assert.equal(read(r), LIST);
});

test('add past the cap is refused with a remove-one-first message and the file is untouched', async () => {
  const r = await rig('cap', { initial: LIST, max: 3 });
  const res = await post(r, 'add', { text: 'four' });
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'cap');
  assert.match(res.json.message, /remove one first/);
  assert.match(res.json.message, /3 of 3/);
  assert.equal(res.json.priorities.items.length, 3);
  assert.equal(read(r), LIST);
  assert.equal(ledgerRows(r).length, 0, 'a refused edit leaves no history');
});

test('a list over the cap is grandfathered: shown whole, reorder and delete allowed, add blocked until it fits', async () => {
  const six = 'date: 2026-10-07\n- a\n- b\n- c\n- d\n- e\n- f\n';
  const r = await rig('grandfather', { initial: six, max: 5 });
  const state = (await send(r, '/api/state', { method: 'GET', token: null, headers: { origin: '', 'content-type': '', 'content-length': '' } })).json;
  assert.equal(state.priorities.items.length, 6);
  assert.equal(state.prioritiesMax, 5);
  assert.equal((await post(r, 'move', { from: 5, to: 0, text: 'f' })).status, 200);
  assert.equal((await post(r, 'add', { text: 'g' })).status, 409);
  assert.equal((await post(r, 'delete', { index: 0, text: 'f' })).status, 200);
  assert.equal((await post(r, 'add', { text: 'g' })).status, 409, 'at the cap is still full');
  assert.equal((await post(r, 'delete', { index: 0, text: 'a' })).status, 200);
  assert.equal((await post(r, 'add', { text: 'g' })).status, 200);
});

test('a hand edit made between two requests is kept, and a stale index is a conflict that answers with the file as it is', async () => {
  const r = await rig('hand', { initial: LIST });
  await post(r, 'move', { from: 1, to: 0, text: 'two' });
  writeFileSync(r.file, 'date: 2026-10-07\n# edited in the editor\n- three\n- one | Alpha\n- hand added\n- two\n');
  const stale = await post(r, 'delete', { index: 0, text: 'two' });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error, 'conflict');
  assert.deepEqual(stale.json.priorities.items.map((i: { text: string }) => i.text), ['three', 'one', 'hand added', 'two']);
  const added = await post(r, 'add', { text: 'four' });
  assert.equal(added.status, 200);
  assert.equal(read(r), 'date: 2026-10-07\n# edited in the editor\n- three\n- one | Alpha\n- hand added\n- two\n- four\n');
});

test('with no list for today an add starts one; move and delete have nothing to act on', async () => {
  const r = await rig('fresh', { initial: 'date: 2026-10-06\n- yesterday\n' });
  assert.equal((await post(r, 'delete', { index: 0, text: 'yesterday' })).status, 409);
  assert.equal((await post(r, 'add', { text: 'today' })).status, 200);
  assert.equal(read(r), 'date: 2026-10-07\n- today\n');
});

test('a ledger that cannot be written does not fail the edit: the file is the source of truth, and the failure is logged', async () => {
  const r = await rig('no-ledger', { initial: LIST });
  mkdirSync(r.ledger, { recursive: true });   // the ledger path is a directory: every append fails
  const res = await post(r, 'add', { text: 'four' });
  assert.equal(res.status, 200);
  assert.match(read(r), /- four/);
  assert.ok(r.logged.some((m) => /could not record the priorities edit/.test(m)), r.logged.join('|'));
});

test('parseEdit accepts exactly the three shapes', () => {
  assert.deepEqual(parseEdit('add', { text: 'x' }), { op: 'add', text: 'x' });
  assert.deepEqual(parseEdit('move', { from: 0, to: 2, text: 'x' }), { op: 'move', from: 0, to: 2, text: 'x' });
  assert.deepEqual(parseEdit('delete', { index: 1, text: 'x' }), { op: 'delete', index: 1, text: 'x' });
  assert.equal(parseEdit('add', { text: 'x', op: 'delete' }), null, 'a body cannot pick its own operation');
  assert.equal(parseEdit('add', JSON.parse('{"text":"x","__proto__":{"op":"delete"}}')), null, 'an own __proto__ key is an unknown key');
});
