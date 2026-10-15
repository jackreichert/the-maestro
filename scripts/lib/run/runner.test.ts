import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir, tmpdir } from 'node:os';
import { createRunner } from './runner.ts';
import type { RunView } from './runner.ts';

const FAKE_TOKEN = `ghp_${'a1B2'.repeat(9)}`;
const meta = { source: 'ask', target: 'ab12', sha256: 'x' };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function finished(r: ReturnType<typeof createRunner>, id: string): Promise<RunView> {
  for (let i = 0; i < 200; i++) { const v = r.view(id)!; if (v.status !== 'running') return v; await sleep(25); }
  throw new Error('run did not finish');
}
const text = (v: RunView): string => v.chunks.map((c) => c.text).join('');
const make = (extra: Partial<Parameters<typeof createRunner>[0]> = {}) => createRunner({ home: tmpdir(), shell: '/bin/sh', ...extra });

test('runs a shell block in the given home directory and reports the exit code and duration', async () => {
  const done: unknown[] = [];
  const r = make({ home: homedir(), onDone: (d) => done.push(d) });
  const s = r.start('ask:ab12', meta, { kind: 'shell', command: 'pwd; echo err >&2; exit 3' }, 5000);
  assert.ok(s.ok);
  const v = await finished(r, s.ok ? s.runId : '');
  assert.equal(v.exitCode, 3);
  assert.equal(v.status, 'done');
  assert.match(text(v), new RegExp(homedir().replace(/[/.]/g, '\\$&')));
  assert.ok(v.chunks.some((c) => c.stream === 'err' && c.text === 'err\n'));
  assert.equal(done.length, 1);
  assert.deepEqual(Object.keys(done[0] as object).sort(), ['durationMs', 'exitCode', 'key', 'runId', 'sha256', 'source', 'status', 'target']);
});

test('secret-shaped output lines are withheld before they are stored', async () => {
  const r = make();
  const s = r.start('k', meta, { kind: 'shell', command: `echo before; echo ${FAKE_TOKEN}; echo after` }, 5000);
  const v = await finished(r, s.ok ? s.runId : '');
  assert.ok(!text(v).includes(FAKE_TOKEN));
  assert.match(text(v), /withheld/);
  assert.match(text(v), /before\n/);
  assert.match(text(v), /after\n/);
});

test('only one run per key at a time; another key is fine', async () => {
  const r = make();
  const a = r.start('k', meta, { kind: 'shell', command: 'sleep 5' }, 10_000);
  assert.ok(a.ok);
  assert.deepEqual(r.start('k', meta, { kind: 'shell', command: 'true' }, 1000), { ok: false, code: 'busy' });
  const b = r.start('other', meta, { kind: 'shell', command: 'true' }, 1000);
  assert.ok(b.ok);
  assert.ok(r.kill(a.ok ? a.runId : ''));
  assert.equal((await finished(r, a.ok ? a.runId : '')).status, 'killed');
  assert.ok(r.start('k', meta, { kind: 'shell', command: 'true' }, 1000).ok, 'the key is free again once the run ended');
});

test('kill takes the whole process group, children included', async () => {
  const r = make();
  const s = r.start('k', meta, { kind: 'shell', command: 'sleep 30 & echo $!; wait' }, 10_000);
  const id = s.ok ? s.runId : '';
  let pid = 0;
  for (let i = 0; i < 100 && !pid; i++) { await sleep(25); pid = Number(text(r.view(id)!).trim()) || 0; }
  assert.ok(pid > 0);
  r.kill(id);
  await finished(r, id);
  await sleep(100);
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test('a run past its timeout is killed and says so', async () => {
  const r = make();
  const s = r.start('k', meta, { kind: 'shell', command: 'sleep 30' }, 150);
  const v = await finished(r, s.ok ? s.runId : '');
  assert.equal(v.status, 'timeout');
});

test('an argv run is not passed through a shell: metacharacters stay literal', async () => {
  const r = make();
  const s = r.start('k', meta, { kind: 'argv', argv: ['/bin/echo', '$(echo pwned); `id` *', '&&', 'x'], cwd: tmpdir() }, 5000);
  const v = await finished(r, s.ok ? s.runId : '');
  assert.equal(text(v), '$(echo pwned); `id` * && x\n');
});

test('output is capped, and the page can read from an offset', async () => {
  const r = make();
  const s = r.start('k', meta, { kind: 'shell', command: 'i=0; while [ $i -lt 6000 ]; do echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; i=$((i+1)); done' }, 10_000);
  const id = s.ok ? s.runId : '';
  const v = await finished(r, id);
  assert.equal(v.truncated, true);
  assert.ok(text(v).length < 300 * 1024);
  assert.deepEqual(r.view(id, v.next)!.chunks, []);
  assert.equal(r.view('nope'), null);
});

test('a missing program fails the run instead of throwing', async () => {
  const r = make();
  const s = r.start('k', meta, { kind: 'argv', argv: ['/no/such/program'], cwd: tmpdir() }, 2000);
  const v = await finished(r, s.ok ? s.runId : '');
  assert.equal(v.status, 'failed');
});
