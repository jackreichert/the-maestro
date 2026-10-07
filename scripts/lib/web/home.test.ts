// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/lib/web/home.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../journal/store.ts';
import { assertNoCanary, buildFixture, snapshot } from '../vault/fixture.ts';
import { createWebServer } from './server.ts';

const NOW = new Date('2026-10-07T15:00:00Z');
const fx = buildFixture();
const ledgerRoot = mkdtempSync(join(tmpdir(), 'home-ledger-'));
const statusDir = join(ledgerRoot, 'Status');
const clientDir = join(ledgerRoot, 'client');
mkdirSync(statusDir, { recursive: true });
mkdirSync(clientDir, { recursive: true });
writeFileSync(join(clientDir, 'index.html'), '<p>home</p>');
writeFileSync(join(statusDir, 'stream-homes.json'), JSON.stringify({ version: 1, streams: { Avonlea: {
  projects: ['avonlea-api'], epics: ['avonlea-api-042'], docs: ['../etc/passwd.md', 'Projects/avonlea-api/Plans/ok.md'], pins: [{ label: 'bad', url: 'javascript:alert(1)' }, { label: 'Dashboard', url: 'https://dash.example.com/d/1' }],
} } }));
writeFileSync(join(statusDir, 'ticket-map.json'), JSON.stringify({ 'avonlea-api-045': ['ask1'] }));
const store = openStore({ vault: ledgerRoot, project: 'p', dryRun: false });
store.append({ id: 'ask1', kind: 'question', text: 'Approve the backfill window?', stream: 'Avonlea', ts: '2026-10-07T12:00:00Z', date: '2026-10-07' });
store.append({ id: 'gg01', kind: 'wip', text: 'pilot work', stream: 'Green Gables', ts: '2026-10-07T12:00:00Z', date: '2026-10-07' });
const page = { streams: ['Avonlea', 'Green Gables'], repoStreams: {}, vaultName: 'Vault', trackerUrlBase: 'https://tracker.test/browse/', ticketNotePath: '', trackerKeyPattern: '\\b[A-Z][A-Z0-9]+-\\d+\\b', tz: 'UTC' };
const server = createWebServer({ web: { vault: ledgerRoot, project: 'p', statusDir, page, vaultRoot: fx.root }, clientDir, now: () => NOW, log: () => {} });
let port = 0;
before(async () => { await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok)); port = (server.address() as AddressInfo).port; });
after(() => { server.close(); });

const hit = (path: string): Promise<{ status: number; body: string }> => new Promise((ok, fail) => {
  const req = request({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}` } }, (res) => { let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => ok({ status: res.statusCode ?? 0, body })); });
  req.on('error', fail);
  req.end();
});

test('GET /api/streams/:name/home returns the epic, what is left and the unknowns, and touches nothing', async () => {
  const roots = [fx.root, ledgerRoot];
  const before = roots.map(snapshot);
  const r = await hit('/api/streams/Avonlea/home');
  assert.equal(r.status, 200);
  const h = JSON.parse(r.body);
  assert.equal(h.stream, 'Avonlea');
  assert.deepEqual(h.mapping, { source: 'config', configFound: true });
  const e = h.epics.find((x: { id: string }) => x.id === 'avonlea-api-042');
  assert.deepEqual([e.total, e.closed, e.inProgress, e.blocked, e.notStarted, e.awaiting], [10, 4, 1, 2, 3, 1], 'the ask is linked through ticket-map.json');
  assert.ok(h.unknowns.some((u: { kind: string; text: string }) => u.kind === 'config-invalid' && /docs\[0\]/.test(u.text)));
  assert.ok(h.unknowns.some((u: { kind: string; text: string }) => u.kind === 'config-invalid' && /pins\[0\]/.test(u.text)));
  assert.deepEqual(h.links.map((g: { group: string }) => g.group), ['pinned', 'epics', 'docs', 'runbooks']);
  assert.ok(h.links.flatMap((g: { items: { url: string }[] }) => g.items).every((l: { url: string }) => !l.url.startsWith('javascript:')));
  assertNoCanary(r.body);
  assert.ok(!r.body.includes(fx.root) && !r.body.includes(fx.outside) && !r.body.includes(ledgerRoot), 'no absolute path in the response');
  assert.deepEqual(roots.map(snapshot), before, 'vault, ledger and status dir are byte-identical');
});

test('a stream with no epics still answers, and an unknown, traversal or over-long name is a 404', async () => {
  const gg = await hit('/api/streams/Green%20Gables/home');
  assert.equal(gg.status, 200);
  assert.deepEqual(JSON.parse(gg.body).epics.filter((e: { id: string }) => e.id === 'avonlea-api-042'), []);
  for (const name of ['Nowhere', '%2e%2e', '..', '%2e%2e%2f%2e%2e', 'other', encodeURIComponent('x'.repeat(300)), '%zz']) assert.equal((await hit(`/api/streams/${name}/home`)).status, 404, name);
});

test('without a vault root the endpoint still answers and says why', async () => {
  const s2 = createWebServer({ web: { vault: ledgerRoot, project: 'p', statusDir, page }, clientDir, now: () => NOW, log: () => {} });
  await new Promise<void>((ok) => s2.listen(0, '127.0.0.1', ok));
  const p2 = (s2.address() as AddressInfo).port;
  const body = await new Promise<string>((ok) => { request({ host: '127.0.0.1', port: p2, path: '/api/streams/Avonlea/home', headers: { host: `127.0.0.1:${p2}` } }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => ok(b)); }).end(); });
  s2.close();
  assert.deepEqual(JSON.parse(body).unknowns.filter((u: { kind: string }) => u.kind === 'no-vault').length, 1);
});
