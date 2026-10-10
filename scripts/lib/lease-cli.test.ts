// Run: node --test scripts/lib/lease-cli.test.ts
// Two windows share one ledger through the real journal.ts: start, lease, release, done, brief, status and the race.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = new URL('../journal.ts', import.meta.url).pathname;
const MARK = ['--model', 'Test Model', '--used', 'skill:the-maestro,tool:journal.ts'];

function setup() {
  const vault = mkdtempSync(join(tmpdir(), 'lease-cli-'));
  const cwd = mkdtempSync(join(tmpdir(), 'lease-cli-cwd-'));
  const argv = (window: string, args: string[]) => [SCRIPT, ...args, '--vault', vault, '--project', 'test-proj', '--window', window];
  const env = { ...process.env, VAULT_ROOT: '', MAESTRO_LOCAL_CONFIG: '', MAESTRO_WINDOW: '', CLAUDE_CODE_SESSION_ID: '', CLAUDE_PID: '', MAESTRO_UPDATE_CHECK: 'off', MAESTRO_CONTAINER_ROOT: '', MAESTRO_EVENT_DIR: join(vault, 'Events') };
  const run = (window: string, ...args: string[]) => spawnSync(process.execPath, argv(window, args), { encoding: 'utf8', cwd, env });
  const runAsync = (window: string, ...args: string[]) => new Promise<number | null>((resolve) => spawn(process.execPath, argv(window, args), { cwd, env, stdio: 'ignore' }).on('close', resolve));
  const queue = (text: string): string => run('a', 'queue', text, ...MARK).stdout.match(/queued\s+(\S+)/)![1];
  const rows = () => readFileSync(join(vault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  return { run, runAsync, queue, rows, done: () => { rmSync(vault, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); } };
}

test('start takes the lease; the other window is refused with who holds it, and nothing is written', () => {
  const t = setup();
  try {
    const id = t.queue('shared item');
    assert.equal(t.run('a', 'start', id, ...MARK).status, 0);
    const before = t.rows().length;
    const refused = t.run('b', 'start', id, ...MARK);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, new RegExp(`${id} is leased by a until \\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\dZ`));
    assert.match(refused.stderr, /--steal/);
    assert.equal(t.rows().length, before);
    assert.equal(t.run('a', 'start', id, ...MARK).status, 0, 'the holder starting again is idempotent');
    assert.match(t.run('b', 'status').stdout, new RegExp(`Leases\\n  ${id}  leased by a until`));
    assert.equal(t.run('b', 'verify').status, 0, 'lease rows are not an integrity problem');
  } finally { t.done(); }
});

test('start --steal takes it; done frees it; release frees it; a lapsed lease is free', () => {
  const t = setup();
  try {
    const id = t.queue('shared item');
    t.run('a', 'start', id, ...MARK);
    assert.equal(t.run('b', 'start', id, '--steal', ...MARK).status, 0);
    assert.equal(t.run('a', 'lease', id).status, 1, 'a no longer holds it');
    assert.equal(t.run('b', 'release', id).status, 0);
    assert.equal(t.run('a', 'lease', id).status, 0, 'released, so a can take it');
    assert.equal(t.run('b', 'release', id).status, 1, 'b cannot release a\'s lease');
    assert.equal(t.run('b', 'release', id, '--force').status, 0);
    assert.equal(t.run('a', 'lease', id, '--ttl', '0.01').status, 0);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 900);
    assert.equal(t.run('b', 'lease', id).status, 0, 'a 0.6 s lease has lapsed');
    assert.equal(t.run('b', 'done', id, ...MARK).status, 0);
    assert.equal(t.run('a', 'status', '--json').status, 0);
    assert.deepEqual(JSON.parse(t.run('a', 'status', '--json').stdout).leases.held, []);
  } finally { t.done(); }
});

test('start "<text>" leases the new item to its window; brief refuses another window\'s item before writing', () => {
  const t = setup();
  try {
    const out = t.run('a', 'start', 'fresh work', ...MARK).stdout;
    const id = out.match(/wip\s+(\S+)/)![1];
    assert.equal(t.run('b', 'start', id, ...MARK).status, 1);
    const before = t.rows().length;
    const dir = mkdtempSync(join(tmpdir(), 'lease-cli-brief-'));
    const brief = t.run('b', 'brief', id, '--read-only', '--out-dir', dir, ...MARK);
    assert.equal(brief.status, 1);
    assert.match(brief.stderr, /leased by a/);
    assert.equal(t.rows().length, before);
    rmSync(dir, { recursive: true, force: true });
  } finally { t.done(); }
});

test('status --json and the footer carry lease counts for this window and others; they are absent from the footer only when nothing is leased', () => {
  const t = setup();
  try {
    const one = t.queue('one');
    const two = t.queue('two');
    const quiet = t.run('a', 'status', '--footer').stdout;
    assert.doesNotMatch(quiet, /Leases/);
    t.run('a', 'start', one, ...MARK);
    assert.match(t.run('a', 'status', '--footer').stdout, /\*\*Leases:\*\* 1 mine, 0 other/, 'this window alone holding the only live lease still shows a Leases line');
    t.run('b', 'start', two, ...MARK);
    const json = JSON.parse(t.run('a', 'status', '--json').stdout);
    assert.deepEqual([json.leases.mine, json.leases.other, json.leases.window], [1, 1, 'a']);
    assert.ok(json.footer && json.inflight && json.date, 'existing fields are still there');
    assert.match(t.run('a', 'status', '--footer').stdout, /\*\*Leases:\*\* 1 mine, 1 other/);
    assert.match(t.run('b', 'status', '--footer', '--line').stdout, /Leases: 1 mine, 1 other/);
  } finally { t.done(); }
});

test('four processes starting one queued item at once: one succeeds, three are refused, one promote row', async () => {
  const t = setup();
  try {
    const id = t.queue('contended');
    const codes = await Promise.all(['a', 'b', 'c', 'd'].map((w) => t.runAsync(w, 'start', id, ...MARK)));
    assert.deepEqual(codes.filter((c) => c === 0).length, 1, `exit codes ${codes.join(',')}`);
    assert.equal(codes.filter((c) => c === 1).length, 3);
    assert.equal(t.rows().filter((r) => r.kind === 'promote').length, 1, 'the item was promoted once');
  } finally { t.done(); }
});

const holderOf = (t: ReturnType<typeof setup>, id: string): string | undefined => JSON.parse(t.run('h', 'status', '--json').stdout).leases.held.find((l: { item: string }) => l.item === id)?.holder;

for (const n of [2, 4, 8]) {
  test(`${n} processes running \`lease --steal h\` or \`start --steal h\` against holder h: exactly one exits 0 and the ledger folds to it`, async () => {
    for (let round = 0; round < 4; round++) {
      const t = setup();
      try {
        const id = t.queue('contended steal');
        assert.equal(t.run('h', 'start', id, ...MARK).status, 0);
        const windows = Array.from({ length: n }, (_, i) => `s${i}`);
        const codes = await Promise.all(windows.map((w, i) => t.runAsync(w, i % 2 ? 'start' : 'lease', id, '--steal', 'h', ...MARK)));
        const winners = windows.filter((_, i) => codes[i] === 0);
        assert.equal(winners.length, 1, `round ${round}: exit codes ${codes.join(',')}`);
        assert.equal(codes.filter((c) => c === 1).length, n - 1, `round ${round}: losers exit 1 (${codes.join(',')})`);
        assert.equal(holderOf(t, id), winners[0], `round ${round}: the ledger names the process that was told it won`);
      } finally { t.done(); }
    }
  });
}

test('a steal naming a window that does not hold the lease exits 1 and writes nothing; so does a named force', () => {
  const t = setup();
  try {
    const id = t.queue('named target');
    t.run('a', 'start', id, ...MARK);
    assert.equal(t.run('b', 'start', id, '--steal', 'a', ...MARK).status, 0);
    const before = t.rows().length;
    const stale = t.run('c', 'lease', id, '--steal', 'a');
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /leased by b/);
    assert.match(stale.stderr, /not by a/);
    assert.equal(t.run('c', 'release', id, '--force', '--from', 'a').status, 1, 'the lease is not a\'s any more');
    assert.equal(t.rows().length, before, 'neither refusal wrote a row');
    assert.equal(t.run('c', 'release', id, '--force', '--from', 'b').status, 0);
    assert.equal(t.run('c', 'lease', id, '--steal', 'b').status, 1, 'nobody holds it, so there is nothing to steal');
    assert.equal(t.run('c', 'lease', id).status, 0, 'a plain lease of the free item works');
  } finally { t.done(); }
});

test('release --force --from h racing lease --steal h: exactly one exits 0 and the ledger agrees', async () => {
  for (let round = 0; round < 6; round++) {
    const t = setup();
    try {
      const id = t.queue('force vs steal');
      t.run('h', 'start', id, ...MARK);
      const [forced, stolen] = await Promise.all([t.runAsync('f', 'release', id, '--force', '--from', 'h'), t.runAsync('s', 'lease', id, '--steal', 'h')]);
      assert.equal([forced, stolen].filter((c) => c === 0).length, 1, `round ${round}: exit codes ${forced},${stolen}`);
      assert.equal(holderOf(t, id), stolen === 0 ? 's' : undefined, `round ${round}: the ledger agrees with who was told it won`);
    } finally { t.done(); }
  }
});
