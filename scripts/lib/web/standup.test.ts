// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/lib/web/standup.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../journal/store.ts';
import { snapshot } from '../vault/fixture.ts';
import { createWebServer } from './server.ts';

let now = new Date('2026-10-26T15:00:00Z'); // a Monday
const ledgerRoot = mkdtempSync(join(tmpdir(), 'standup-ledger-'));
const statusDir = join(ledgerRoot, 'Status');
const clientDir = join(ledgerRoot, 'client');
mkdirSync(statusDir, { recursive: true });
mkdirSync(clientDir, { recursive: true });
writeFileSync(join(clientDir, 'index.html'), '<p>home</p>');
const store = openStore({ vault: ledgerRoot, project: 'p', dryRun: false });
const row = (r: Record<string, unknown>): void => { store.append({ ts: `${r.date}T10:00:00Z`, ...r } as Parameters<typeof store.append>[0]); };
row({ id: 'w001', kind: 'wip', date: '2026-10-23', text: 'build the thing', stream: 'Avonlea' });
row({ id: 'd001', kind: 'done', date: '2026-10-23', text: 'thing shipped in #9 (w001)', closes: 'w001' });
row({ id: 'w002', kind: 'wip', date: '2026-10-22', text: 'older work', stream: 'Avonlea' });
row({ id: 'd002', kind: 'done', date: '2026-10-22', text: 'older work done', closes: 'w002' });
row({ id: 'w003', kind: 'wip', date: '2026-10-26', text: 'running now' });
const page = { streams: ['Avonlea'], repoStreams: {}, vaultName: 'Vault', trackerUrlBase: 'https://tracker.test/browse/', ticketNotePath: '', trackerKeyPattern: '\\b[A-Z][A-Z0-9]+-\\d+\\b', tz: 'UTC' };
const server = createWebServer({ web: { vault: ledgerRoot, project: 'p', statusDir, page }, clientDir, now: () => now, log: () => {} });
let port = 0;
before(async () => { await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok)); port = (server.address() as AddressInfo).port; });
after(() => { server.close(); });

const hit = (path: string, method = 'GET'): Promise<{ status: number; body: string; headers: Record<string, unknown> }> => new Promise((ok, fail) => {
  const req = request({ host: '127.0.0.1', port, path, method, headers: { host: `127.0.0.1:${port}` } }, (res) => { let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => ok({ status: res.statusCode ?? 0, body, headers: res.headers })); });
  req.on('error', fail);
  req.end();
});

test('GET /api/standup with no days uses the Monday default (Friday to Sunday), is team-safe, and writes nothing', async () => {
  const before = snapshot(ledgerRoot);
  const r = await hit('/api/standup');
  assert.equal(r.status, 200);
  assert.equal(r.headers['cache-control'], 'no-store');
  const d = JSON.parse(r.body);
  d.text = d.lines.join('\n');
  assert.ok(!('text' in JSON.parse(r.body)), 'the route sends lines: the secret scan reads a long joined text as one string and can withhold all of it on a cross-line false positive');
  assert.deepEqual([d.days, d.from, d.to, d.defaultDays], [3, '2026-10-23', '2026-10-25', 3]);
  assert.match(d.text, /thing shipped in #9/);
  assert.doesNotMatch(d.text, /older work|w001|d001/);
  assert.match(d.text, /\*Today\*\n- Other\n  - running now/);
  assert.ok(!r.body.includes(ledgerRoot), 'no absolute path in the response');
  assert.equal(snapshot(ledgerRoot), before);
});

test('days widens the window, and a refresh sees a row written after the last request', async () => {
  assert.match(JSON.parse((await hit('/api/standup?days=5')).body).lines.join('\n'), /older work done/);
  row({ id: 'd003', kind: 'done', date: '2026-10-24', text: 'fresh close' });
  assert.match(JSON.parse((await hit('/api/standup?days=3')).body).lines.join('\n'), /fresh close/);
});

test('the default is yesterday on a Wednesday', async () => {
  const keep = now;
  now = new Date('2026-10-28T15:00:00Z');
  const d = JSON.parse((await hit('/api/standup')).body);
  now = keep;
  assert.deepEqual([d.days, d.from, d.to], [1, '2026-10-27', '2026-10-27']);
});

test('a bad days value is a 400, never clamped', async () => {
  for (const q of ['days=0', 'days=15', 'days=-2', 'days=abc', 'days=', 'days=2.5', 'days=1&days=2', 'days=%00', 'days=1e1']) {
    const r = await hit(`/api/standup?${q}`);
    assert.equal(r.status, 400, q);
    assert.deepEqual(JSON.parse(r.body), { error: 'bad request' });
  }
});

test('the route is GET-only', async () => {
  assert.notEqual((await hit('/api/standup', 'POST')).status, 200);
});
