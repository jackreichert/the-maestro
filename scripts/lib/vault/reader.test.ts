// Run: node --test scripts/lib/vault/reader.test.ts
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createReader, cleanPath } from './reader.ts';
import { isSecretName, hasSecretSegment } from './secret-names.ts';
import { TICKET_DIR_SCOPES, TICKET_FILE_SCOPES } from './tickets.ts';
import { assertNoCanary, buildFixture, snapshot } from './fixture.ts';

const A = 'Projects/avonlea-api';
const make = (root: string) => createReader({ root, dirScopes: TICKET_DIR_SCOPES, fileScopes: TICKET_FILE_SCOPES });

test('the denylist matches secret names and leaves ordinary notes alone', () => {
  for (const n of ['.env', '.env.local', '.ENV.production', 'ssm-prod.json', 'a.tfvars', 'a.tfvars.json', 'terraform.tfstate', 'x.tfstate.backup', 'k.pem', 'k.key', 'a.p12', 'a.pfx', 'id_rsa', 'id_rsa.pub', 'id_ed25519', '.npmrc', '.netrc', 'credentials.json', 'Credentials.md', 'db.kdbx']) assert.ok(isSecretName(n), n);
  for (const n of ['CONTEXT.md', 'avonlea-api-042.md', 'environment.md', 'monkey.md', 'ssm-notes.md', 'keynote.md']) assert.ok(!isSecretName(n), n);
  assert.ok(hasSecretSegment('Projects/x/.env/notes.md'));
});

test('cleanPath accepts plain relative paths only', () => {
  assert.deepEqual(cleanPath('Projects/a/Tickets/x.md'), ['Projects', 'a', 'Tickets', 'x.md']);
  for (const bad of ['', '/etc/passwd', '../x.md', 'Projects/../x.md', 'Projects//x.md', 'Projects/./x.md', 'a\\b.md', 'a\0b.md', 'a/', 'x'.repeat(1100)]) assert.equal(cleanPath(bad), null, JSON.stringify(bad));
});

test('listing returns real projects and notes only: symlinks, secret names and non-markdown files are left out', () => {
  const fx = buildFixture();
  const r = make(fx.root);
  const top = r.list('Projects');
  assert.ok(top.ok && top.dirs.includes('avonlea-api') && !top.dirs.includes('outside-dir'));
  const tickets = r.list(`${A}/Tickets`);
  assert.ok(tickets.ok);
  if (tickets.ok) {
    assert.ok(tickets.files.includes('avonlea-api-042.md') && tickets.files.includes('ssm-ticket.md'));
    for (const hidden of ['link.md', 'credentials.md', '.env.md', 'ssm-test.json', 'prod.tfvars', '.env.local']) assert.ok(!tickets.files.includes(hidden), hidden);
    assert.deepEqual(tickets.dirs, ['Archive']);
    assertNoCanary(JSON.stringify(tickets));
  }
});

test('reads refuse every unsafe path with a reason, and never return a canary', () => {
  const fx = buildFixture();
  const r = make(fx.root);
  const reason = (p: string): string => { const x = r.read(p, 256 * 1024); return x.ok ? 'ok' : x.reason; };
  assert.equal(reason(`${A}/Tickets/avonlea-api-042.md`), 'ok');
  assert.equal(reason(`${A}/Tickets/Archive/avonlea-api-051.md`), 'ok');
  assert.equal(reason(`${A}/Tickets/credentials.md`), 'denied');
  assert.equal(reason(`${A}/Tickets/.env.md`), 'denied');
  assert.equal(reason(`${A}/Tickets/.env.local`), 'denied');
  assert.equal(reason(`${A}/Tickets/terraform.tfstate`), 'denied');
  assert.equal(reason(`${A}/Tickets/link.md`), 'symlink');
  assert.equal(reason('Projects/outside-dir/Tickets/outside-ticket.md'), 'symlink');
  assert.equal(reason(`${A}/Tickets/locked.md`), 'unreadable');
  assert.equal(reason(`${A}/Tickets/missing.md`), 'missing');
  assert.equal(reason(`${A}/Tickets/prod.tfvars.md`.replace('.md', '')), 'denied');
  assert.equal(reason(`${A}/CONTEXT.md`), 'out-of-scope');
  assert.equal(reason(`${A}/Tickets/avonlea-api-042.txt`), 'not-markdown');
  assert.equal(reason(`${A}/Tickets/huge.md`), 'too-large');
  for (const bad of ['../outside/outside-ticket.md', '/etc/hosts', `${A}/Tickets/../../../outside/x.md`, `${A}/Tickets/a\\b.md`, 'Projects/%2e%2e/x.md']) assert.notEqual(reason(bad), 'ok', bad);
  assert.equal(make('/nonexistent-vault-root').list('Projects').ok, false);
});

test('a head read returns only the first bytes and a size cap still applies', () => {
  const fx = buildFixture();
  const r = make(fx.root);
  const x = r.head(`${A}/Tickets/huge.md`, 64, 400 * 1024);
  assert.ok(x.ok && x.text.length === 64);
  assert.equal(r.head(`${A}/Tickets/huge.md`, 64, 1024).ok, false);
});

test('a denied name is never lstat-ed, listed or opened, and the vault is byte-identical afterwards', () => {
  const fx = buildFixture();
  const before = snapshot(fx.root);
  const touched: string[] = [];
  const names = ['openSync', 'lstatSync', 'realpathSync'] as const;
  for (const n of names) {
    const real = fs[n] as (...a: unknown[]) => unknown;
    mock.method(fs, n, (...a: unknown[]) => { touched.push(String(a[0])); return real(...a); });
  }
  syncBuiltinESMExports();
  try {
    const r = make(fx.root);
    for (const p of [`${A}/Tickets/credentials.md`, `${A}/Tickets/.env.md`, `${A}/Tickets/ssm-test.json`, `${A}/Tickets/terraform.tfstate`, `${A}/Plans/prod.tfvars`]) r.read(p, 1000);
    r.list(`${A}/Tickets`);
    r.list('Projects');
  } finally { mock.restoreAll(); syncBuiltinESMExports(); }
  const bad = touched.filter((p) => p.split('/').some((s) => isSecretName(s)));
  assert.deepEqual(bad, []);
  assert.ok(touched.length > 0);
  assert.equal(snapshot(fx.root), before);
});

test('a named pipe called like a note is refused without blocking, in a read and in a listing', () => {
  const fx = buildFixture();
  const fifo = `${fx.root}/Projects/avonlea-api/Tickets/pipe.md`;
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  const r = make(fx.root);
  const started = Date.now();
  const x = r.read(`${A}/Tickets/pipe.md`, 1000);
  assert.deepEqual(x, { ok: false, reason: 'not-file' });
  assert.ok(Date.now() - started < 2000);
  const ls = r.list(`${A}/Tickets`);
  assert.ok(ls.ok && !ls.files.includes('pipe.md'), 'a listing leaves out anything that is not a regular file');
});
