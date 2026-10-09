// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/lib/web/answer-write.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { request } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWebServer } from './server.ts';
import { readBoard } from './api.ts';
import type { WebConfig } from './api.ts';
import { ANSWER_PATH, SKIP_TEXT, parseAnswer } from './answer-write.ts';
import { generate } from '../status-page/generate.ts';
import { extractFields } from '../status-page/inline.ts';
import { PODIUM_FILE, readSeenPage } from '../status-page/seen.ts';
import { check } from '../../event-types/status-watch.ts';

const NOW = new Date('2026-10-07T15:00:00Z');
const TOKEN = 'test-token-0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab';
const JOURNAL = fileURLToPath(new URL('../../journal.ts', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'web-answer-'));
const client = join(root, 'client');
mkdirSync(join(client, 'dist'), { recursive: true });
writeFileSync(join(client, 'index.html'), '<p>home</p>');

const ASKS = [
  { id: 'aa11', ts: '2026-10-07T10:00:00.000Z', date: '2026-10-07', kind: 'question', stream: 'Alpha', text: 'Merge it? The context is here.', recommend: 'Merge it today', door: 'two-way' },
  { id: 'bb22', ts: '2026-10-07T10:05:00.000Z', date: '2026-10-07', kind: 'question', stream: 'Alpha', text: 'Pick a name?' },
  { id: 'cc33', ts: '2026-10-07T10:06:00.000Z', date: '2026-10-07', kind: 'question', stream: 'Alpha', text: 'Third ask?' },
];
const PAGE_CONFIG = { streams: ['Alpha', 'Beta'], repoStreams: {}, vaultName: '', trackerUrlBase: '', ticketNotePath: '', trackerKeyPattern: 'FAKE-\\d+', tz: 'UTC' };

interface Rig { server: Server; port: number; vault: string; statusDir: string; ledger: string; web: WebConfig; logged: string[] }
const rigs: Rig[] = [];
async function rig(name: string, asks: Record<string, unknown>[] = ASKS): Promise<Rig> {
  const vault = join(root, name);
  const statusDir = join(vault, 'Status');
  const ledger = join(vault, 'Projects', 'p', 'Journal', 'ledger.jsonl');
  mkdirSync(statusDir, { recursive: true });
  mkdirSync(join(vault, 'Projects', 'p', 'Journal'), { recursive: true });
  writeFileSync(ledger, asks.map((a) => `${JSON.stringify(a)}\n`).join(''));
  const logged: string[] = [];
  const web: WebConfig = { vault, project: 'p', statusDir, page: PAGE_CONFIG };
  const server = createWebServer({ web, clientDir: client, now: () => NOW, log: (m) => logged.push(m), token: TOKEN });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const r = { server, port: (server.address() as AddressInfo).port, vault, statusDir, ledger, web, logged };
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
const answer = (r: Rig, body: unknown, o: Parameters<typeof send>[2] = {}): Promise<Reply> => send(r, ANSWER_PATH, { body, ...o });
const rows = (r: Rig): Record<string, any>[] => (existsSync(r.ledger) ? readFileSync(r.ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const closers = (r: Rig): Record<string, any>[] => rows(r).filter((x) => x.closes);

/** The page as the generator writes it from the ledger as it stands, with the watcher's baseline adopted once so later edits show against it. */
function writePage(r: Rig): string {
  const { inputs } = readBoard(r.web, NOW);
  const deps = { journal: (sub: 'status' | 'triage') => (sub === 'status' ? inputs.status : inputs.triage), fetchPrs: () => [], sleep: () => {}, now: () => NOW };
  const out = generate({ statusDir: r.statusDir, dryRun: false, snapshot: false, command: 'journal.ts status-page', config: PAGE_CONFIG, cachedPrsOnly: true }, deps);
  check(r.statusDir);
  return out.page;
}

test('a typed answer closes the ask with the same row `journal.ts resolve --answer` writes', async () => {
  const r = await rig('happy');
  const res = await answer(r, { id: 'bb22', mode: 'text', answer: '  Call it\n  Cadenza  ' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true, id: 'bb22', answer: 'Call it Cadenza' });
  assert.equal(closers(r).length, 1);

  const cli = await rig('cli');   // the same ledger, closed by the command line instead
  const ran = spawnSync(process.execPath, [JOURNAL, 'resolve', 'bb22', '--answer', 'Call it Cadenza', '--allow-unmarked', '--vault', cli.vault, '--project', 'p'], { encoding: 'utf8', env: { ...process.env, MAESTRO_LOCAL_CONFIG: '' } });
  assert.equal(ran.status, 0, ran.stderr);
  const shape = (x: Record<string, any>): Record<string, any> => { const { id, ts, date, ...rest } = x; return rest; };
  assert.deepEqual(shape(closers(r)[0] as Record<string, any>), shape(closers(cli)[0] as Record<string, any>), 'one recorder, one row shape');
  assert.equal(closers(r)[0]?.closes, 'bb22');
});

test('Take recommendation records the ask\'s own recommendation; Skip records that nothing was decided', async () => {
  const r = await rig('quick');
  assert.equal((await answer(r, { id: 'aa11', mode: 'recommend' })).status, 200);
  assert.equal(closers(r)[0]?.text, 'Take the recommendation: Merge it today');
  assert.equal((await answer(r, { id: 'bb22', mode: 'recommend' })).status, 422, 'no recommendation to take');
  assert.equal((await answer(r, { id: 'bb22', mode: 'text', answer: 'Cadenza' })).status, 200);
  const skipped = await rig('skip-two-way', [{ ...ASKS[0], id: 'dd44', recommend: undefined }]);
  assert.equal((await answer(skipped, { id: 'dd44', mode: 'skip' })).status, 200);
  assert.equal(closers(skipped)[0]?.text, SKIP_TEXT);
});

test('a skip is refused for a one-way ask and for an ask with no door, and writes nothing', async () => {
  const r = await rig('skip-one-way', [{ ...ASKS[1], door: 'one-way' }, ASKS[2] as Record<string, unknown>]);   // bb22 one-way, cc33 no door
  for (const id of ['bb22', 'cc33']) {
    const res = await answer(r, { id, mode: 'skip' });
    assert.equal(res.status, 409, id);
    assert.equal(res.json.error, 'one-way');
  }
  assert.equal(closers(r).length, 0);
  assert.equal((await answer(r, { id: 'bb22', mode: 'text', answer: 'a real answer' })).status, 200, 'the ask can still be answered');
});

test('an empty answer, an unknown id and an answered ask are refused and write nothing', async () => {
  const r = await rig('refuse');
  for (const body of [{ id: 'aa11', mode: 'text', answer: '' }, { id: 'aa11', mode: 'text', answer: ' \n\t ' }, { id: 'aa11', mode: 'text', answer: 'x'.repeat(1001) }, { id: 'aa11', mode: 'text', answer: 'bell\u0007' }]) {
    const res = await answer(r, body);
    assert.equal(res.status, 422, JSON.stringify(body).slice(0, 40));
    assert.equal(res.json.error, 'invalid');
  }
  const unknown = await answer(r, { id: 'zz99', mode: 'text', answer: 'hi' });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error, 'unknown');
  assert.equal(closers(r).length, 0);

  assert.equal((await answer(r, { id: 'cc33', mode: 'text', answer: 'first' })).status, 200);
  const again = await answer(r, { id: 'cc33', mode: 'text', answer: 'second' });
  assert.equal(again.status, 409);
  assert.equal(again.json.error, 'answered');
  assert.equal(closers(r).length, 1, 'the second answer wrote nothing');
  assert.equal(closers(r)[0]?.text, 'first');
});

test('a row that is not an ask, or is not on the board, cannot be closed through this route', async () => {
  const r = await rig('notask', [...ASKS, { id: 'ww11', ts: '2026-10-07T10:00:00.000Z', date: '2026-10-07', kind: 'wip', text: 'working' }]);
  const res = await answer(r, { id: 'ww11', mode: 'text', answer: 'nope' });
  assert.equal(res.status, 404);
  assert.equal(closers(r).length, 0);
});

test('the route needs the page\'s own origin, the token, a JSON body of exactly one of the three shapes, and POST', async () => {
  const r = await rig('guard');
  const ok = { id: 'aa11', mode: 'text', answer: 'yes' };
  assert.equal((await answer(r, ok, { token: null })).status, 403, 'no token');
  assert.equal((await answer(r, ok, { token: 'wrong' })).status, 403, 'wrong token');
  assert.equal((await answer(r, ok, { headers: { origin: 'http://evil.test' } })).status, 403, 'foreign origin');
  assert.equal((await answer(r, ok, { headers: { origin: '' } })).status, 403, 'no origin');
  assert.equal((await answer(r, ok, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403, 'cross-site fetch');
  assert.equal((await answer(r, ok, { headers: { host: 'evil.test' } })).status, 403, 'rebound host');
  assert.equal((await answer(r, ok, { headers: { 'content-type': 'text/plain' } })).status, 415, 'not JSON');
  for (const body of [{}, { id: 'aa11' }, { id: 'aa11', mode: 'text' }, { id: 'aa11', mode: 'text', answer: 5 }, { id: 'aa11', mode: 'skip', answer: 'x' }, { id: 'aa11', mode: 'recommend', extra: 1 }, { id: 'AA 11', mode: 'skip' }, { id: 'aa11', mode: 'approve' }, [], null])
    assert.equal((await answer(r, body)).status, 400, JSON.stringify(body));
  assert.equal((await send(r, ANSWER_PATH, { raw: '{not json' })).status, 400);
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const res = await send(r, ANSWER_PATH, { method, body: {} });
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.allow, 'POST');
  }
  assert.equal(closers(r).length, 0, 'every refusal left the ledger alone');
  assert.equal((await answer(r, ok)).status, 200, 'and the same request goes through when it is right');
});

test('parseAnswer accepts exactly the three shapes', () => {
  assert.deepEqual(parseAnswer({ id: 'ab12', mode: 'text', answer: 'x' }), { id: 'ab12', mode: 'text', answer: 'x' });
  assert.deepEqual(parseAnswer({ id: 'ab12', mode: 'skip' }), { id: 'ab12', mode: 'skip' });
  assert.deepEqual(parseAnswer({ id: 'ab12', mode: 'recommend' }), { id: 'ab12', mode: 'recommend' });
  for (const bad of [null, 'x', [], {}, { id: 'ab', mode: 'skip' }, { id: 'ab12', mode: 'text' }, { id: 'ab12', mode: 'skip', answer: 'x' }, { id: 'ab12', mode: 'text', answer: 'x', y: 1 }]) assert.equal(parseAnswer(bad), null);
});

test('round trip: the note\'s stub is filled, the watcher reports nothing, and the next rebuild drops the ask', async () => {
  const r = await rig('trip');
  const page = writePage(r);
  assert.match(page, /`aa11`[^\n]*\n  > answer: \n/, 'the generator wrote an empty stub');
  assert.equal(check(r.statusDir).fresh.length, 0);

  const res = await answer(r, { id: 'aa11', mode: 'text', answer: 'Merge it, then tag it' });
  assert.equal(res.status, 200);
  const note = readFileSync(join(r.statusDir, PODIUM_FILE), 'utf8');
  assert.deepEqual(extractFields(note).answers, { aa11: 'Merge it, then tag it' }, 'the note shows the answer where a typed one would be');
  assert.equal(extractFields(readSeenPage(r.statusDir) ?? '').answers.aa11, 'Merge it, then tag it', 'the watcher\'s baseline agrees');
  assert.deepEqual(check(r.statusDir).fresh, [], 'no second event for an answer already recorded');
  assert.equal(closers(r).length, 1);

  const next = writePage(r);
  assert.ok(!next.includes('`aa11`'), 'the answered ask leaves the page');
  assert.ok(next.includes('`bb22`') && next.includes('`cc33`'), 'the others stay');
  assert.deepEqual(check(r.statusDir).fresh, []);
  assert.deepEqual(r.logged, []);
});

test('an answer typed in the note and not yet reported is not overwritten or doubled: the web route refuses it', async () => {
  const r = await rig('pending');
  writePage(r);
  const path = join(r.statusDir, PODIUM_FILE);
  writeFileSync(path, readFileSync(path, 'utf8').replace(/(`bb22`[^\n]*\n)  > answer: /, '$1  > answer: typed by hand'));
  const res = await answer(r, { id: 'bb22', mode: 'text', answer: 'from the web' });
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'pending');
  assert.equal(closers(r).length, 0);
  assert.match(readFileSync(path, 'utf8'), /> answer: typed by hand/);
  assert.equal((await answer(r, { id: 'cc33', mode: 'text', answer: 'other asks still work' })).status, 200);
  assert.equal(check(r.statusDir).fresh.length, 1, 'the typed answer is still reported once, as before');
});

test('with no note yet the answer is still recorded in the ledger', async () => {
  const r = await rig('nonote');
  assert.equal((await answer(r, { id: 'aa11', mode: 'skip' })).status, 200);
  assert.equal(closers(r).length, 1);
  assert.equal(existsSync(join(r.statusDir, PODIUM_FILE)), false, 'a web answer never creates the note');
  assert.deepEqual(r.logged, []);
});
