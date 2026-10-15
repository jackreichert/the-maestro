// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/lib/web/run-write.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWebServer } from './server.ts';
import type { WebConfig } from './api.ts';
import { RUN_KILL_PATH, RUN_POLL_PATH, RUN_PREVIEW_PATH, RUN_RESOLVE_PATH, RUN_START_PATH, RUN_WRITE_PATHS } from './run-write.ts';

const NOW = new Date('2026-10-07T15:00:00Z');
const TOKEN = 'test-token-0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab';
const FAKE_TOKEN = `ghp_${'a1B2'.repeat(9)}`;
const root = mkdtempSync(join(tmpdir(), 'web-run-'));
const client = join(root, 'client');
mkdirSync(join(client, 'dist'), { recursive: true });
writeFileSync(join(client, 'index.html'), '<p>home</p>');
const PAGE_CONFIG = { streams: ['Alpha'], repoStreams: {}, vaultName: '', trackerUrlBase: '', ticketNotePath: '', trackerKeyPattern: 'FAKE-\\d+', tz: 'UTC' };

interface Rig { server: Server; port: number; ledger: string; dir: string; logged: string[] }
const rigs: Rig[] = [];
/** A ledger with one paste ask (`aa11`) whose block file holds `block`, and a second paste ask (`bb22`) with its own file. */
async function rig(name: string, blocks: Record<string, string>): Promise<Rig> {
  const vault = join(root, name);
  const dir = join(vault, 'blocks');
  const statusDir = join(vault, 'Status');
  const ledger = join(vault, 'Projects', 'p', 'Journal', 'ledger.jsonl');
  mkdirSync(dir, { recursive: true }); mkdirSync(statusDir, { recursive: true }); mkdirSync(join(vault, 'Projects', 'p', 'Journal'), { recursive: true });
  const asks = Object.entries(blocks).map(([id, block], i) => {
    writeFileSync(join(dir, `${id}.sh`), block);
    return { id, ts: `2026-10-07T10:0${i}:00.000Z`, date: '2026-10-07', kind: 'question', stream: 'Alpha', text: `Run block ${id}`, paste: join(dir, `${id}.sh`) };
  });
  writeFileSync(ledger, asks.map((a) => `${JSON.stringify(a)}\n`).join(''));
  const logged: string[] = [];
  const web: WebConfig = { vault, project: 'p', statusDir, page: PAGE_CONFIG };
  const server = createWebServer({ web, clientDir: client, now: () => NOW, log: (m) => logged.push(m), token: TOKEN, home: root, runShell: '/bin/sh' });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const r = { server, port: (server.address() as AddressInfo).port, ledger, dir, logged };
  rigs.push(r);
  return r;
}
after(() => { for (const r of rigs) r.server.close(); });

interface Reply { status: number; json: Record<string, any> }
function send(r: Rig, path: string, o: { method?: string; body?: unknown; headers?: Record<string, string>; token?: string | null } = {}): Promise<Reply> {
  const body = o.body === undefined ? '' : JSON.stringify(o.body);
  const headers: Record<string, string> = { host: `127.0.0.1:${r.port}`, origin: `http://127.0.0.1:${r.port}`, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), ...o.headers };
  if (o.token !== null) headers['x-podium-token'] = o.token ?? TOKEN;
  for (const k of Object.keys(headers)) if (headers[k] === '') delete headers[k];
  return new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port: r.port, path, method: o.method ?? 'POST', headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => { let json: Record<string, any> = {}; try { json = JSON.parse(text); } catch { /* not JSON */ } ok({ status: res.statusCode ?? 0, json }); });
    });
    req.on('error', fail);
    req.end(body);
  });
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const ledger = (r: Rig): Record<string, any>[] => readFileSync(r.ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const preview = (r: Rig, id = 'aa11') => send(r, RUN_PREVIEW_PATH, { body: { source: 'ask', id } });
async function runToEnd(r: Rig, id = 'aa11'): Promise<{ start: Reply; end: Record<string, any> }> {
  const p = await preview(r, id);
  const start = await send(r, RUN_START_PATH, { body: { source: 'ask', id, sha256: p.json.sha256 } });
  if (start.status !== 200) return { start, end: {} };
  for (let i = 0; i < 200; i++) {
    const poll = await send(r, RUN_POLL_PATH, { body: { runId: start.json.runId, since: 0 } });
    if (poll.json.status !== 'running') return { start, end: poll.json };
    await sleep(25);
  }
  throw new Error('run did not finish');
}
const outText = (end: Record<string, any>): string => (end.chunks as { text: string }[]).map((c) => c.text).join('');

test('the server is bound to the loopback address only', async () => {
  const r = await rig('bind', { aa11: 'echo hi' });
  assert.equal((r.server.address() as AddressInfo).address, '127.0.0.1');
});

test('every run endpoint refuses a missing token, a bad token and a cross-origin request', async () => {
  const r = await rig('auth', { aa11: 'echo hi' });
  for (const path of RUN_WRITE_PATHS) {
    const body = { source: 'ask', id: 'aa11' };
    assert.equal((await send(r, path, { body, token: null })).status, 403, `${path}: no token`);
    assert.equal((await send(r, path, { body, token: 'x'.repeat(TOKEN.length) })).status, 403, `${path}: bad token`);
    assert.equal((await send(r, path, { body, headers: { origin: 'http://evil.example' } })).status, 403, `${path}: cross-origin`);
    assert.equal((await send(r, path, { body, headers: { origin: '' } })).status, 403, `${path}: no origin`);
    assert.equal((await send(r, path, { body, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403, `${path}: cross-site fetch`);
    assert.equal((await send(r, path, { body, headers: { host: 'evil.example' } })).status, 403, `${path}: rebound host`);
    assert.equal((await send(r, path, { body, method: 'GET' })).status, 405, `${path}: GET`);
  }
});

test('preview shows the exact block and its hash; a run records exit code and duration, not output', async () => {
  const r = await rig('happy', { aa11: 'echo from-the-block; exit 2' });
  const p = await preview(r);
  assert.equal(p.status, 200);
  assert.equal(p.json.command, 'echo from-the-block; exit 2');
  assert.match(p.json.sha256, /^[0-9a-f]{64}$/);
  assert.equal(p.json.runnable, true);
  const { start, end } = await runToEnd(r);
  assert.equal(start.status, 200);
  assert.equal(end.exitCode, 2);
  assert.equal(outText(end), 'from-the-block\n');
  const run = ledger(r).find((x) => x.kind === 'run')!;
  assert.equal(run.runTarget, 'aa11');
  assert.equal(run.exitCode, 2);
  assert.equal(typeof run.durationMs, 'number');
  assert.ok(!JSON.stringify(run).includes('from-the-block'), 'the output is not in the ledger');
  assert.equal(ledger(r).filter((x) => x.closes).length, 0, 'running does not close the ask');
});

test('the run uses the block the ledger names; a body that carries command text is refused', async () => {
  const r = await rig('strict', { aa11: 'echo real' });
  const p = await preview(r);
  for (const extra of [{ command: 'echo injected' }, { block: 'echo injected' }, { path: '/etc/passwd' }]) {
    assert.equal((await send(r, RUN_START_PATH, { body: { source: 'ask', id: 'aa11', sha256: p.json.sha256, ...extra } })).status, 400);
  }
  assert.equal((await send(r, RUN_START_PATH, { body: { source: 'ask', id: 'aa11', sha256: 'nothex' } })).status, 400);
  assert.equal((await send(r, RUN_START_PATH, { body: { source: 'ask', id: '../x', sha256: p.json.sha256 } })).status, 400);
  assert.equal((await send(r, RUN_START_PATH, { body: { source: 'ask', id: 'zz99', sha256: p.json.sha256 } })).status, 404);
});

test('a block edited after review does not run (hash pin)', async () => {
  const r = await rig('pin', { aa11: 'echo reviewed' });
  const p = await preview(r);
  const marker = join(root, 'pin', 'ran');
  writeFileSync(join(r.dir, 'aa11.sh'), `touch ${marker}`);
  const start = await send(r, RUN_START_PATH, { body: { source: 'ask', id: 'aa11', sha256: p.json.sha256 } });
  assert.equal(start.status, 409);
  assert.equal(start.json.error, 'changed');
  assert.equal(start.json.command, `touch ${marker}`, 'the reply carries the new block for a second review');
  await sleep(100);
  assert.equal(existsSync(marker), false);
});

test('blocks that name secret files, dump the environment, break paste-lint or hold a secret never run', async () => {
  const marker = join(root, 'refused-ran');
  const bad: Record<string, string> = { aa11: `touch ${marker}; cat .env`, bb22: `touch ${marker}; env`, cc33: `touch ${marker} # note`, dd44: `touch ${marker}; echo ${FAKE_TOKEN}`, ee55: `touch ${marker}; cat ssm-params-production.json` };
  const r = await rig('refused', bad);
  for (const id of Object.keys(bad)) {
    const p = await preview(r, id);
    assert.equal(p.json.runnable, false, id);
    const start = await send(r, RUN_START_PATH, { body: { source: 'ask', id, sha256: p.json.sha256 } });
    assert.equal(start.status, 422, id);
    assert.equal(start.json.error, 'refused');
  }
  await sleep(100);
  assert.equal(existsSync(marker), false);
});

test('a block file that is a secret file, or a symlink to one, is refused', async () => {
  const r = await rig('symlink', { aa11: 'echo hi' });
  const vaultDir = join(root, 'symlink');
  const target = join(vaultDir, 'blocks', '.env');
  writeFileSync(target, 'echo hi');
  const row = { id: 'cc33', ts: '2026-10-07T10:09:00.000Z', date: '2026-10-07', kind: 'question', stream: 'Alpha', text: 'x', paste: target };
  writeFileSync(r.ledger, `${readFileSync(r.ledger, 'utf8')}${JSON.stringify(row)}\n`);
  assert.equal((await preview(r, 'cc33')).status, 422);
  const link = join(vaultDir, 'blocks', 'harmless.sh');
  symlinkSync(target, link);
  writeFileSync(r.ledger, `${readFileSync(r.ledger, 'utf8')}${JSON.stringify({ ...row, id: 'dd44', paste: link })}\n`);
  assert.equal((await preview(r, 'dd44')).status, 422, 'a link named harmlessly still resolves to the secret file');
});

test('output is scrubbed of secret-shaped lines on the way to the page', async () => {
  const r = await rig('scrub', { aa11: "printf 'ok\\n'; printf 'ghp_%s\\n' a1B2a1B2a1B2a1B2a1B2a1B2a1B2a1B2a1B2; printf 'done\\n'" });
  const { end } = await runToEnd(r);
  assert.ok(!outText(end).includes('a1B2a1B2'));
  assert.match(outText(end), /ok\n/);
  assert.match(outText(end), /done\n/);
});

test('one run per item at a time, and a kill ends it', async () => {
  const r = await rig('busy', { aa11: 'sleep 20', bb22: 'echo other' });
  const p = await preview(r);
  const first = await send(r, RUN_START_PATH, { body: { source: 'ask', id: 'aa11', sha256: p.json.sha256 } });
  assert.equal(first.status, 200);
  const second = await send(r, RUN_START_PATH, { body: { source: 'ask', id: 'aa11', sha256: p.json.sha256 } });
  assert.equal(second.status, 409);
  assert.equal(second.json.error, 'busy');
  assert.equal((await runToEnd(r, 'bb22')).end.exitCode, 0, 'another item still runs');
  assert.equal((await send(r, RUN_KILL_PATH, { body: { runId: first.json.runId } })).status, 200);
  for (let i = 0; i < 100; i++) { const v = await send(r, RUN_POLL_PATH, { body: { runId: first.json.runId } }); if (v.json.status !== 'running') { assert.equal(v.json.status, 'killed'); break; } await sleep(25); }
  assert.equal((await send(r, RUN_KILL_PATH, { body: { runId: first.json.runId } })).status, 409, 'nothing left to kill');
});

test('resolving the ask with the result closes it with a server-composed answer without output', async () => {
  const r = await rig('resolve', { aa11: 'echo result-line' });
  const early = await send(r, RUN_RESOLVE_PATH, { body: { runId: '0'.repeat(24) } });
  assert.equal(early.status, 404);
  const { start } = await runToEnd(r);
  const res = await send(r, RUN_RESOLVE_PATH, { body: { runId: start.json.runId } });
  assert.equal(res.status, 200);
  assert.match(res.json.answer, /^Ran on the Podium \(done, exit 0, [\d.]+s\)\. The output stays on the Podium\.$/);
  assert.ok(!JSON.stringify(ledger(r)).includes('result-line'), 'no output reaches the ledger');
  const closers = ledger(r).filter((x) => x.closes === 'aa11');
  assert.equal(closers.length, 1);
  assert.equal((await send(r, RUN_START_PATH, { body: { source: 'ask', id: 'aa11', sha256: 'a'.repeat(64) } })).status, 404, 'a closed ask no longer runs');
  assert.equal((await send(r, RUN_RESOLVE_PATH, { body: { runId: start.json.runId } })).status, 409, 'it cannot be answered twice');
});
