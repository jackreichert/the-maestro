// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/lib/web/done-write.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFixture, noteText } from '../vault/fixture.ts';
import { createWebServer } from './server.ts';
import { parseSave, safeNotePath } from './done-write.ts';

const NOW = new Date('2026-10-16T15:00:00Z');
const TOKEN = 'test-token-0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab';
const fx = buildFixture();
const ledgerRoot = mkdtempSync(join(tmpdir(), 'done-ledger-'));
const statusDir = join(ledgerRoot, 'Status');
const clientDir = join(ledgerRoot, 'client');
mkdirSync(statusDir, { recursive: true });
mkdirSync(clientDir, { recursive: true });
writeFileSync(join(clientDir, 'index.html'), '<p>home</p>');

// Orchard: an open epic with a child and no definition. Cask: a project note with a definition and no epic. Avonlea: an epic with one (fixture).
fx.write('Projects/orchard/Tickets/orchard-001.md', noteText({ id: 'orchard-001', title: 'Pick the apples', type: 'epic' }));
fx.write('Projects/orchard/Tickets/orchard-002.md', noteText({ id: 'orchard-002', title: 'Ladders', parent: 'orchard-001' }));
fx.write('Projects/cask/CONTEXT.md', '---\ntitle: Cask\nlast-updated: 2026-09-01\n---\n# Cask\n\n## What done looks like\n\n- [ ] First barrel\n\n## Now\n\nWaiting.\n');
writeFileSync(join(statusDir, 'stream-homes.json'), JSON.stringify({ version: 1, streams: {
  Avonlea: { projects: ['avonlea-api'], epics: ['avonlea-api-042'] }, Orchard: { projects: ['orchard'], epics: ['orchard-001'] }, Cask: { projects: ['cask'] },
} }));
const page = { streams: ['Avonlea', 'Orchard', 'Cask'], repoStreams: {}, vaultName: 'Vault', trackerUrlBase: '', ticketNotePath: '', trackerKeyPattern: 'FAKE-\\d+', tz: 'UTC' };
const web = { vault: ledgerRoot, project: 'p', statusDir, page, vaultRoot: fx.root };
const server = createWebServer({ web, clientDir, now: () => NOW, log: () => {}, token: TOKEN });
let port = 0;
before(async () => { await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok)); port = (server.address() as AddressInfo).port; });
after(() => { server.close(); });

const AV = 'Projects/avonlea-api/Tickets/avonlea-api-042.md';
const OR = 'Projects/orchard/Tickets/orchard-001.md';
const CASK = 'Projects/cask/CONTEXT.md';
const read = (rel: string): string => readFileSync(join(fx.root, rel), 'utf8');

interface Reply { status: number; json: Record<string, any> }
function call(o: { method: string; path: string; body?: unknown; headers?: Record<string, string>; token?: string | null }): Promise<Reply> {
  const body = o.body === undefined ? '' : JSON.stringify(o.body);
  const headers: Record<string, string> = { host: `127.0.0.1:${port}`, ...(o.method === 'POST' ? { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } : {}), ...o.headers };
  if (o.method === 'POST' && o.token !== null) headers['x-podium-token'] = o.token ?? TOKEN;
  return new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port, path: o.path, method: o.method, headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => { let json: Record<string, any> = {}; try { json = JSON.parse(text); } catch { /* not JSON */ } ok({ status: res.statusCode ?? 0, json }); });
    });
    req.on('error', fail);
    req.end(o.method === 'POST' ? body : undefined);
  });
}
const get = (stream: string, kind: string, name = ''): Promise<Reply> => call({ method: 'GET', path: `/api/streams/${stream}/done-text?kind=${kind}&name=${encodeURIComponent(name)}` });
const save = (body: unknown, o: { token?: string | null; headers?: Record<string, string> } = {}): Promise<Reply> => call({ method: 'POST', path: '/api/done/save', body, ...o });
const stray = (): string[] => ['avonlea-api/Tickets', 'orchard/Tickets', 'cask'].flatMap((d) => readdirSync(join(fx.root, 'Projects', d)).filter((f) => f.endsWith('.tmp')));

test('GET returns the section raw with a revision, for an epic and for a project note', async () => {
  const a = await get('Avonlea', 'epic', 'avonlea-api-042');
  assert.equal(a.status, 200);
  assert.equal(a.json.text, 'The new pipeline is primary for seven days. Nothing reads the old one.');
  assert.match(a.json.rev, /^[0-9a-f]{12}$/);
  const c = await get('Cask', 'project', 'cask');
  assert.equal(c.json.text, '- [ ] First barrel');
  const n = await get('Orchard', 'new');
  assert.equal(n.status, 200);
  assert.equal(n.json.text, '');
});

test('save replaces only the epic section, bumps updated and leaves the rest of the note alone', async () => {
  const before = read(AV);
  const { json: { rev } } = await get('Avonlea', 'epic', 'avonlea-api-042');
  const r = await save({ stream: 'Avonlea', kind: 'epic', name: 'avonlea-api-042', rev, text: '1. Staged\n2. Proven' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const after = read(AV);
  assert.match(after, /^updated: 2026-10-16$/m);
  assert.match(after, /## What done looks like\n\n1\. Staged\n2\. Proven\n$/);
  assert.equal(after.replace(/^updated: .*$/m, '').replace(/## What done looks like[\s\S]*$/, ''), before.replace(/^updated: .*$/m, '').replace(/## What done looks like[\s\S]*$/, ''));
  assert.deepEqual(stray(), [], 'no temp file is left behind');
  assert.equal((await get('Avonlea', 'epic', 'avonlea-api-042')).json.text, '1. Staged\n2. Proven');
});

test('a project note is edited the same way and its last-updated is bumped', async () => {
  const { json: { rev } } = await get('Cask', 'project', 'cask');
  const r = await save({ stream: 'Cask', kind: 'project', name: 'cask', rev, text: '- [x] First barrel\n- [ ] Second barrel' });
  assert.equal(r.status, 200);
  assert.equal(read(CASK), '---\ntitle: Cask\nlast-updated: 2026-10-16\n---\n# Cask\n\n## What done looks like\n\n- [x] First barrel\n- [ ] Second barrel\n\n## Now\n\nWaiting.\n');
});

test('a stream with no written definition gets the section in its first open epic', async () => {
  const { json: { rev } } = await get('Orchard', 'new');
  const r = await save({ stream: 'Orchard', kind: 'new', rev, text: '1. Apples picked' });
  assert.equal(r.status, 200);
  assert.equal(r.json.created, true);
  assert.match(read(OR), /\n## What done looks like\n\n1\. Apples picked\n$/);
  assert.match(read(OR), /^updated: 2026-10-16$/m);
  const again = await save({ stream: 'Orchard', kind: 'new', rev, text: 'again' });
  assert.equal(again.status, 409, 'once written, "new" is refused: edit the source instead');
});

test('a stale revision is refused and nothing is written', async () => {
  const before = read(AV);
  const r = await save({ stream: 'Avonlea', kind: 'epic', name: 'avonlea-api-042', rev: '000000000000', text: 'Overwrite' });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'changed');
  assert.equal(read(AV), before);
});

test('only a source the stream reads is writable: another stream, an unlisted epic, a path or a traversal is refused', async () => {
  const snapshot = [AV, OR, CASK].map(read);
  const { json: { rev } } = await get('Avonlea', 'epic', 'avonlea-api-042');
  const attempts: Record<string, unknown>[] = [
    { stream: 'Orchard', kind: 'epic', name: 'avonlea-api-042' },            // an epic of another stream
    { stream: 'Avonlea', kind: 'epic', name: 'avonlea-api-043' },            // a ticket that is not a source (closed child)
    { stream: 'Avonlea', kind: 'epic', name: 'orchard-001' },
    { stream: 'Avonlea', kind: 'project', name: 'cask' },                    // a project the stream does not map
    { stream: 'Avonlea', kind: 'project', name: 'avonlea-api' },             // mapped, but its CONTEXT.md has no definition
    { stream: 'Avonlea', kind: 'project', name: '../../outside' },
    { stream: 'Avonlea', kind: 'epic', name: '../Tickets/avonlea-api-042.md' },
    { stream: 'Avonlea', kind: 'epic', name: 'Projects/avonlea-api/Tickets/avonlea-api-042.md' },
    { stream: 'Avonlea', kind: 'project', name: 'outside-dir' },             // a symlink under Projects
    { stream: 'Nowhere', kind: 'epic', name: 'avonlea-api-042' },
    { stream: 'Avonlea', kind: 'new' },                                       // Avonlea already has one
  ];
  for (const a of attempts) {
    const r = await save({ ...a, rev, text: 'Hijacked' });
    assert.ok(r.status === 404 || r.status === 409, `${JSON.stringify(a)} -> ${r.status}`);
  }
  assert.deepEqual([AV, OR, CASK].map(read), snapshot);
  assert.equal(readFileSync(join(fx.outside, 'outside-ticket.md'), 'utf8').includes('Hijacked'), false);
});

test('safeNotePath accepts a note under <root>/Projects and nothing else', () => {
  assert.ok(safeNotePath(fx.root, AV)?.endsWith('avonlea-api-042.md'));
  assert.ok(safeNotePath(fx.root, CASK));
  for (const bad of ['../outside/outside-ticket.md', 'Projects/../DECISIONS.md', '/etc/passwd', 'Projects/avonlea-api/Tickets/link.md', 'Projects/outside-dir/CONTEXT.md',
    'Projects/avonlea-api/DECISIONS.md', 'Projects/avonlea-api/Plans/2026-10-01-cutover.md', 'Projects/avonlea-api/Tickets/.env.md', 'Projects/avonlea-api/Tickets/missing.md', 'Projects/avonlea-api/Tickets/huge.md', 'CONTEXT.md']) {
    assert.equal(safeNotePath(fx.root, bad), null, bad);
  }
  const root2 = mkdtempSync(join(tmpdir(), 'done-root-'));
  mkdirSync(join(root2, 'Projects'));
  symlinkSync(fx.outside, join(root2, 'Projects', 'escape'));
  assert.equal(safeNotePath(root2, 'Projects/escape/CONTEXT.md'), null);
});

test('the body shape is exact; an invalid text is 422 and writes nothing', async () => {
  assert.equal(parseSave({ stream: 'A', kind: 'epic', name: 'x', rev: 'abcdef012345', text: 't' })?.src.name, 'x');
  assert.equal(parseSave({ stream: 'A', kind: 'new', rev: 'abcdef012345', text: 't' })?.src.kind, 'new');
  for (const bad of [null, [], {}, { stream: 'A', kind: 'epic', rev: 'abcdef012345', text: 't' }, { stream: 'A', kind: 'new', name: 'x', rev: 'abcdef012345', text: 't' },
    { stream: 'A', kind: 'path', name: 'x', rev: 'abcdef012345', text: 't' }, { stream: 'A', kind: 'epic', name: 'x', rev: 'nope', text: 't' }, { stream: 'A', kind: 'epic', name: 'x', rev: 'abcdef012345', text: 't', path: '/etc' }]) {
    assert.equal(parseSave(bad), null, JSON.stringify(bad));
  }
  const { json: { rev } } = await get('Avonlea', 'epic', 'avonlea-api-042');
  const before = read(AV);
  for (const text of ['', '   ', 'ok\n## Smuggled heading']) assert.equal((await save({ stream: 'Avonlea', kind: 'epic', name: 'avonlea-api-042', rev, text })).status, 422);
  assert.equal((await save({ stream: 'Avonlea', kind: 'epic', name: 'avonlea-api-042', rev, text: 'x', extra: 1 })).status, 400);
  assert.equal(read(AV), before);
});

test('the route keeps the same guards as the other writes: token, origin, JSON, method', async () => {
  const body = { stream: 'Avonlea', kind: 'epic', name: 'avonlea-api-042', rev: 'abcdef012345', text: 'x' };
  const before = read(AV);
  assert.equal((await save(body, { token: null })).status, 403);
  assert.equal((await save(body, { token: 'wrong'.padEnd(TOKEN.length, 'x') })).status, 403);
  assert.equal((await save(body, { headers: { origin: 'http://evil.example' } })).status, 403);
  assert.equal((await save(body, { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await call({ method: 'GET', path: '/api/done/save' })).status, 405);
  assert.equal(read(AV), before);
});
