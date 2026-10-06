// Run: node --test scripts/web.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { request } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './lib/journal/store.ts';

const JOURNAL = new URL('./journal.ts', import.meta.url).pathname;
const ENV = { ...process.env, MAESTRO_LOCAL_CONFIG: '', LEDGER_ROOT: '', VAULT_ROOT: '', MAESTRO_CONTAINER_ROOT: '' };

test('journal.ts web serves the real ledger on 127.0.0.1 and refuses a foreign Host', async () => {
  const vault = mkdtempSync(join(tmpdir(), 'web-cli-'));
  openStore({ vault, project: 'p', dryRun: false }).append({ id: 'ask1', kind: 'question', text: 'Ship it? Yes.', ts: '2026-10-06T12:00:00Z', date: '2026-10-06' });
  const child = spawn(process.execPath, [JOURNAL, 'web', '--port', '0', '--vault', vault, '--project', 'p', '--status-dir', join(vault, 'Status')], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const url = await new Promise<string>((ok, fail) => {
      let out = '';
      child.stdout.on('data', (c) => { out += c; const m = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(out); if (m) ok(m[0]); });
      child.on('exit', (code) => fail(new Error(`web exited ${code}`)));
      setTimeout(() => fail(new Error('no URL printed')), 10_000).unref();
    });
    const port = Number(new URL(url).port);
    const get = (path: string, host: string): Promise<{ status: number; body: string }> => new Promise((ok, fail) => {
      const req = request({ host: '127.0.0.1', port, path, headers: { host } }, (res) => { let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => ok({ status: res.statusCode ?? 0, body })); });
      req.on('error', fail);
      req.end();
    });
    const ok = await get('/api/state', `127.0.0.1:${port}`);
    assert.equal(ok.status, 200);
    assert.equal((JSON.parse(ok.body) as { asks: { id: string }[] }).asks[0]?.id, 'ask1');
    assert.equal((await get('/api/state', `attacker.example:${port}`)).status, 403);
  } finally { child.kill(); }
});

test('web.ts rejects a bad --port with one clean line and exit 1', () => {
  const r = spawnSync(process.execPath, [new URL('./web.ts', import.meta.url).pathname, '--port', '99999', '--vault', tmpdir(), '--project', 'p', '--status-dir', tmpdir()], { env: ENV, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim(), 'web: --port must be a whole number from 0 to 65535');
  assert.equal(r.stdout, '');
});
