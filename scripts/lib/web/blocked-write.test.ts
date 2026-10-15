// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/lib/web/blocked-write.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { request } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWebServer } from './server.ts';
import { readBoard } from './api.ts';
import type { WebConfig } from './api.ts';
import { BLOCKED_PATH, MAX_COMMENT, parseUnblock } from './blocked-write.ts';
import { PODIUM_AUTHOR } from '../../local-config.ts';
import { fold, isQueued } from '../ledger-core.ts';
import type { LedgerRow } from '../ledger-core.ts';

const NOW = new Date('2026-10-15T15:00:00Z');
const TOKEN = 'test-token-0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab';
const JOURNAL = fileURLToPath(new URL('../../journal.ts', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'web-blocked-'));
const client = join(root, 'client');
mkdirSync(join(client, 'dist'), { recursive: true });
writeFileSync(join(client, 'index.html'), '<p>home</p>');

const ROWS: Record<string, unknown>[] = [
  { id: 'bl11', ts: '2026-10-14T10:00:00.000Z', date: '2026-10-14', kind: 'blocked', stream: 'Alpha', repo: 'widgets', ticket: 'FAKE-1', text: 'Publish v1', gate: 'ticket:FAKE-9' },
  { id: 'bl22', ts: '2026-10-14T10:05:00.000Z', date: '2026-10-14', kind: 'blocked', stream: 'Alpha', text: 'Pick a vendor' },
  { id: 'wp33', ts: '2026-10-14T10:06:00.000Z', date: '2026-10-14', kind: 'wip', stream: 'Alpha', text: 'Not a blocked item' },
  { id: 'qq44', ts: '2026-10-14T10:07:00.000Z', date: '2026-10-14', kind: 'question', stream: 'Alpha', text: 'An ask, not a block?' },
];
const PAGE_CONFIG = { streams: ['Alpha'], repoStreams: {}, vaultName: '', trackerUrlBase: '', ticketNotePath: '', trackerKeyPattern: 'FAKE-\\d+', tz: 'UTC' };

interface Rig { server: Server; port: number; vault: string; ledger: string; web: WebConfig; logged: string[] }
const rigs: Rig[] = [];
async function rig(name: string, rows: Record<string, unknown>[] = ROWS): Promise<Rig> {
  const vault = join(root, name);
  const statusDir = join(vault, 'Status');
  const ledger = join(vault, 'Projects', 'p', 'Journal', 'ledger.jsonl');
  mkdirSync(statusDir, { recursive: true });
  mkdirSync(join(vault, 'Projects', 'p', 'Journal'), { recursive: true });
  writeFileSync(ledger, rows.map((a) => `${JSON.stringify(a)}\n`).join(''));
  const logged: string[] = [];
  const web: WebConfig = { vault, project: 'p', statusDir, page: PAGE_CONFIG };
  const server = createWebServer({ web, clientDir: client, now: () => NOW, log: (m) => logged.push(m), token: TOKEN });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const r = { server, port: (server.address() as AddressInfo).port, vault, ledger, web, logged };
  rigs.push(r);
  return r;
}
after(() => { for (const r of rigs) r.server.close(); });

interface Reply { status: number; json: Record<string, any> }
function send(r: Rig, o: { body?: unknown; headers?: Record<string, string>; token?: string | null; path?: string; method?: string } = {}): Promise<Reply> {
  const body = o.body === undefined ? '' : JSON.stringify(o.body);
  const headers: Record<string, string> = { host: `127.0.0.1:${r.port}`, origin: `http://127.0.0.1:${r.port}`, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), ...o.headers };
  if (o.token !== null) headers['x-podium-token'] = o.token ?? TOKEN;
  return new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port: r.port, path: o.path ?? BLOCKED_PATH, method: o.method ?? 'POST', headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => { let json: Record<string, any> = {}; try { json = JSON.parse(text); } catch { /* not JSON */ } ok({ status: res.statusCode ?? 0, json }); });
    });
    req.on('error', fail);
    req.end(body);
  });
}
const post = (r: Rig, body: unknown, o: Parameters<typeof send>[1] = {}): Promise<Reply> => send(r, { body, ...o });
const rows = (r: Rig): LedgerRow[] => readFileSync(r.ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const items = (r: Rig) => fold(rows(r), null).items;

test('parseUnblock accepts exactly {id, mode, comment} and nothing else', () => {
  assert.deepEqual(parseUnblock({ id: 'bl11', mode: 'unblock', comment: 'go' }), { id: 'bl11', mode: 'unblock', comment: 'go' });
  assert.deepEqual(parseUnblock({ id: 'bl11', mode: 'comment', comment: 'go' }), { id: 'bl11', mode: 'comment', comment: 'go' });
  for (const bad of [null, [], 'x', {}, { id: 'bl11', mode: 'unblock' }, { id: 'bl11', mode: 'close', comment: 'x' }, { id: 'BL 1', mode: 'unblock', comment: 'x' },
    { id: 'bl11', mode: 'unblock', comment: 7 }, { id: 'bl11', mode: 'unblock', comment: 'x', by: 'Eve' }, { id: 'bl11', mode: 'unblock', comment: 'x'.repeat(MAX_COMMENT * 2 + 1) }]) {
    assert.equal(parseUnblock(bad), null, JSON.stringify(bad));
  }
});

test('Unblock records the comment, closes the block and queues the item with the comment on it', async () => {
  const r = await rig('happy');
  const res = await post(r, { id: 'bl11', mode: 'unblock', comment: '  Go ahead,\n  FAKE-9 landed  ' });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.same, false);
  assert.equal(res.json.comment, 'Go ahead, FAKE-9 landed');

  const added = rows(r).slice(ROWS.length);
  assert.deepEqual(added.map((x) => x.kind), ['comment', 'resolved', 'wip']);
  const [note, closer, queued] = added as [LedgerRow, LedgerRow, LedgerRow];
  assert.deepEqual([note.of, note.by, note.source, note.text], ['bl11', PODIUM_AUTHOR, 'podium', 'Go ahead, FAKE-9 landed']);
  assert.deepEqual([closer.closes, closer.by, closer.source, closer.unblocked], ['bl11', PODIUM_AUTHOR, 'podium', true]);
  assert.equal(queued.queued, true);
  assert.equal(queued.unblocks, 'bl11');
  assert.equal(queued.text, `Publish v1 -- ${PODIUM_AUTHOR}: Go ahead, FAKE-9 landed`);
  assert.deepEqual([queued.stream, queued.repo, queued.ticket], ['Alpha', 'widgets', 'FAKE-1']);
  assert.equal(queued.gate, undefined, 'the gate stays on the closed block');
  assert.equal(res.json.queued, queued.id);

  const now = items(r);
  assert.equal(now.find((i) => i.id === 'bl11')?.closedBy?.kind, 'resolved');
  assert.equal(isQueued(now.find((i) => i.id === queued.id) as LedgerRow), true);
  const { g } = readBoard(r.web, NOW);
  assert.deepEqual(g.blocked.map((b) => b.id), ['bl22']);
  assert.ok(g.queued.some((q) => String(q.text).includes('Go ahead')), 'the next worker sees the comment on the queued row');
});

test('the rows it writes pass `journal.ts verify`', async () => {
  const r = await rig('verify');
  await post(r, { id: 'bl11', mode: 'unblock', comment: 'Go' });
  await post(r, { id: 'bl22', mode: 'comment', comment: 'Still thinking' });
  const out = spawnSync(process.execPath, [JOURNAL, 'verify', '--vault', r.vault, '--project', 'p'], { encoding: 'utf8', env: { ...process.env, MAESTRO_LOCAL_CONFIG: '' } });
  assert.equal(out.status, 0, out.stdout + out.stderr);
});

test('Comment only records the comment and leaves the item blocked', async () => {
  const r = await rig('comment-only');
  const res = await post(r, { id: 'bl22', mode: 'comment', comment: 'Ask finance first' });
  assert.equal(res.status, 200);
  const added = rows(r).slice(ROWS.length);
  assert.deepEqual(added.map((x) => x.kind), ['comment']);
  assert.deepEqual([added[0]?.of, added[0]?.by, added[0]?.source], ['bl22', PODIUM_AUTHOR, 'podium']);
  assert.equal(items(r).find((i) => i.id === 'bl22')?.closedBy, null);
  assert.deepEqual(readBoard(r.web, NOW).g.blocked.map((b) => b.id), ['bl11', 'bl22']);
});

test('an empty, over-long, control-character or secret-shaped comment is refused and writes nothing', async () => {
  const r = await rig('refuse-text');
  const secret = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
  for (const comment of ['', ' \n\t ', 'x'.repeat(MAX_COMMENT + 1), 'bell\u0007', 'csi\u009b', 'flip\u202e', `key ${secret}`]) {
    for (const mode of ['unblock', 'comment']) {
      const res = await post(r, { id: 'bl11', mode, comment });
      assert.equal(res.status, 422, `${mode} ${comment.slice(0, 12)}`);
      assert.equal(res.json.error, 'invalid');
      assert.ok(!JSON.stringify(res.json).includes(secret), 'a refusal never echoes the value');
    }
  }
  assert.equal(rows(r).length, ROWS.length);
});

test('an unknown id, a non-blocked item and a malformed body are refused and write nothing', async () => {
  const r = await rig('refuse-id');
  for (const id of ['zz99', 'wp33', 'qq44']) {
    const res = await post(r, { id, mode: 'unblock', comment: 'go' });
    assert.equal(res.status, 404, id);
    assert.equal(res.json.error, 'unknown');
  }
  assert.equal((await post(r, { id: 'bl11', mode: 'unblock' })).status, 400);
  assert.equal((await post(r, { id: 'bl11', mode: 'unblock', comment: 'go', by: 'Eve' })).status, 400);
  assert.equal(rows(r).length, ROWS.length);
});

test('a double submit of the same Unblock appends once and answers the same ok', async () => {
  const r = await rig('double');
  const body = { id: 'bl11', mode: 'unblock', comment: 'Go ahead' };
  const [a, b] = await Promise.all([post(r, body), post(r, body)]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.deepEqual([a.json.same, b.json.same].sort(), [false, true]);
  assert.equal(a.json.queued, b.json.queued, 'both name the one queued row');
  assert.equal(rows(r).length, ROWS.length + 3);
  const again = await post(r, body);
  assert.equal(again.status, 200);
  assert.equal(again.json.same, true);
  assert.equal(rows(r).length, ROWS.length + 3);
});

test('a double submit of the same Comment only appends once; a different comment is a new row', async () => {
  const r = await rig('double-comment');
  const body = { id: 'bl22', mode: 'comment', comment: 'Ask finance first' };
  assert.equal((await post(r, body)).json.same, false);
  assert.equal((await post(r, body)).json.same, true);
  assert.equal(rows(r).length, ROWS.length + 1);
  assert.equal((await post(r, { ...body, comment: 'And legal' })).json.same, false);
  assert.equal(rows(r).length, ROWS.length + 2);
});

test('an item already unblocked is refused with a different comment, and by the CLI too', async () => {
  const r = await rig('already');
  assert.equal((await post(r, { id: 'bl11', mode: 'unblock', comment: 'Go' })).status, 200);
  const n = rows(r).length;
  const other = await post(r, { id: 'bl11', mode: 'unblock', comment: 'Actually wait' });
  assert.equal(other.status, 409);
  assert.equal(other.json.error, 'unblocked');
  assert.equal((await post(r, { id: 'bl11', mode: 'comment', comment: 'late thought' })).status, 409, 'no comment lands on a closed block');

  const cli = await rig('already-cli');
  const ran = spawnSync(process.execPath, [JOURNAL, 'resolve', 'bl22', '--answer', 'gate cleared', '--allow-unmarked', '--vault', cli.vault, '--project', 'p'], { encoding: 'utf8', env: { ...process.env, MAESTRO_LOCAL_CONFIG: '' } });
  assert.equal(ran.status, 0, ran.stderr);
  const late = await post(cli, { id: 'bl22', mode: 'unblock', comment: 'Go' });
  assert.equal(late.status, 409);
  assert.equal(rows(r).length, n, 'nothing more was written');
});

test('the same guards as the other writes: token, origin, content type and method', async () => {
  const r = await rig('guards');
  const body = { id: 'bl11', mode: 'unblock', comment: 'go' };
  assert.equal((await post(r, body, { token: null })).status, 403);
  assert.equal((await post(r, body, { token: 'wrong' })).status, 403);
  assert.equal((await post(r, body, { headers: { origin: 'http://evil.example' } })).status, 403);
  assert.equal((await post(r, body, { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await send(r, { method: 'GET' })).status, 405);
  assert.equal(rows(r).length, ROWS.length);
});
