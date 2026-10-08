// Run: node --test scripts/loop-supervisor.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DELAYS, quietSleepSeconds, queueSavedDigest, secondsUntilClock, supervise } from './loop-supervisor.ts';
import type { LoopResult } from './loop-supervisor.ts';
import { NO_OWNER_LOG } from './lib/digest-queue.ts';
import { digestBody, digestDir, unseenDigests } from './lib/digest-store.ts';
import { commands, fillTemplate, LABEL, shq } from './install-loop-supervisor.ts';

const tempDir = () => mkdtempSync(join(tmpdir(), 'loop-supervisor-test-'));
const SUPERVISOR = new URL('./loop-supervisor.ts', import.meta.url).pathname;
const INSTALL = new URL('./install-loop-supervisor.ts', import.meta.url).pathname;
const NOON = Date.parse('2026-10-01T12:00:00Z');

/** Runs supervise over scripted results; returns what it slept, saved and logged. */
async function drive(results: Partial<LoopResult>[]) {
  const slept: number[] = [];
  const modes: (string | undefined)[] = [];
  const saved: string[] = [];
  const logs: string[] = [];
  let launches = 0;
  await supervise({
    runLoop: async () => ({ code: 0, stdout: '', stderr: '', ...results[launches++] }),
    sleep: async (s, mode) => { slept.push(s); modes.push(mode); },
    save: (d) => { saved.push(d); },
    log: (l) => { logs.push(l); },
    now: () => NOON,
    maxRuns: results.length,
  });
  return { slept, modes, saved, logs, launches };
}

test('exit 10 saves the digest and relaunches without sleeping', async () => {
  const r = await drive([{ code: 10, stdout: 'ACTION a (t): x\n' }, { code: 10, stdout: 'ACTION b (t): y\n' }]);
  assert.deepEqual(r.saved, ['ACTION a (t): x\n', 'ACTION b (t): y\n']);
  assert.deepEqual(r.slept, []);
  assert.equal(r.launches, 2);
});

test('exit 0 sleeps 300s, exit 2 logs the stderr line and sleeps 300s, other codes sleep 30s', async () => {
  const r = await drive([{ code: 0 }, { code: 2, stderr: 'old\nevent-loop: another event loop is running (pid 7)\n' }, { code: 1, stderr: 'boom' }, { code: null, stderr: '' }]);
  assert.deepEqual(r.slept, [DELAYS.idle, DELAYS.usage, DELAYS.crash, DELAYS.crash]);
  assert.match(r.logs[0], /another event loop is running \(pid 7\)/);
  assert.match(r.logs[1], /exited 1: boom/);
  assert.deepEqual(r.saved, []);
});

test('exit 3 sleeps until the stated time; an unreadable time falls back to 300s with a log line', async () => {
  const r = await drive([{ code: 3, stdout: 'QUIET-HOURS stop until 14:30 UTC\n' }, { code: 3, stdout: 'QUIET-HOURS stop until soon UTC\n' }]);
  assert.deepEqual(r.slept, [2.5 * 3600, DELAYS.quietFallback]);
  assert.equal(r.logs.length, 1);
});

test('quiet-hours parsing: next occurrence in the zone, wrap past midnight, 12h cap, junk refused', () => {
  assert.equal(secondsUntilClock(NOON, '12:30', 'UTC'), 1800);
  assert.equal(secondsUntilClock(NOON, '11:00', 'UTC'), 12 * 3600);
  assert.equal(secondsUntilClock(NOON + 30000, '12:01', 'UTC'), 30);
  assert.equal(secondsUntilClock(NOON, '07:00', 'America/New_York'), 12 * 3600);
  assert.equal(secondsUntilClock(Date.parse('2026-03-08T06:00:00Z'), '04:00', 'America/New_York'), 2 * 3600);
  assert.equal(secondsUntilClock(NOON, '25:00', 'UTC'), null);
  assert.equal(secondsUntilClock(NOON, '10:00', 'Not/AZone'), null);
  assert.equal(quietSleepSeconds('QUIET-HOURS stop until 13:00 America/New_York', NOON), 5 * 3600);
  assert.equal(quietSleepSeconds('nothing here', NOON), null);
});

/** An executable fake loop that prints a digest and exits 10. */
function fakeLoop(dir: string): string {
  const bin = join(dir, 'fake-loop.sh');
  writeFileSync(bin, '#!/bin/sh\necho "ACTION w1 (fake): changed"\nexit 10\n');
  chmodSync(bin, 0o755);
  return bin;
}
const envFor = (ledger: string, extra: Record<string, string> = {}) => ({ ...process.env, LEDGER_ROOT: ledger, MAESTRO_PROJECT: 'proj', MAESTRO_EVENT_DIR: join(ledger, 'Events'), ...extra });

test('the real supervisor process saves the fake loop digest under the ledger root only', () => {
  const ledger = tempDir();
  const r = spawnSync(process.execPath, [SUPERVISOR], { encoding: 'utf8', env: envFor(ledger, { MAESTRO_LOOP_BIN: fakeLoop(tempDir()), MAESTRO_SUPERVISOR_MAX_RUNS: '2' }) });
  assert.equal(r.status, 0, r.stderr);
  const dir = digestDir(ledger, 'proj');
  assert.equal(unseenDigests(dir).length, 2);
  assert.equal(digestBody(unseenDigests(dir)[0]), 'ACTION w1 (fake): changed');
});

test('the supervisor refuses to start without a ledger root and writes nothing', () => {
  const r = spawnSync(process.execPath, [SUPERVISOR], { encoding: 'utf8', env: { ...envFor('x'), LEDGER_ROOT: '', MAESTRO_LOOP_BIN: fakeLoop(tempDir()), MAESTRO_SUPERVISOR_MAX_RUNS: '1' } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no ledger root/);
});

test('install fills every placeholder, prints the launchctl commands, never runs them, and refuses while a loop holds the lock', () => {
  const ledger = tempDir();
  const out = join(tempDir(), 'x.plist');
  const ok = spawnSync(process.execPath, [INSTALL, '--out', out], { encoding: 'utf8', env: envFor(ledger) });
  assert.equal(ok.status, 0, ok.stderr);
  const plist = readFileSync(out, 'utf8');
  assert.equal(/\{\{/.test(plist), false);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<integer>30<\/integer>/);
  assert.match(ok.stdout, new RegExp(`launchctl bootstrap gui/\\d+ '${out}'`));
  assert.match(ok.stdout, new RegExp(`launchctl bootout gui/\\d+/${LABEL}`));
  assert.match(ok.stdout, /launchctl print/);
  const events = join(ledger, 'Events');
  mkdirSync(events, { recursive: true });
  writeFileSync(join(events, 'loop.lock'), String(process.pid));
  const out2 = join(tempDir(), 'y.plist');
  const refused = spawnSync(process.execPath, [INSTALL, '--out', out2], { encoding: 'utf8', env: envFor(ledger) });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, new RegExp(`pid ${process.pid}`));
  assert.equal(existsSync(out2), false);
  assert.equal(existsSync(join(events, 'loop.lock')), true);
});

test('fillTemplate escapes XML and rejects a placeholder without a value; commands carry the label', () => {
  assert.equal(fillTemplate('<s>{{A}}</s>', { A: 'a&b<c' }), '<s>a&amp;b&lt;c</s>');
  assert.throws(() => fillTemplate('{{A}}{{B}}', { A: '1' }), /\{\{B\}\}/);
  assert.match(commands('/p.plist', 501).unload, new RegExp(`gui/501/${LABEL}$`));
});

test('commands single-quote paths; a space and a single quote survive a shell round trip', () => {
  const plist = "/tmp/a b/it's.plist";
  const c = commands(plist, 501);
  assert.equal(shq("it's"), "'it'\\''s'");
  assert.equal(spawnSync('sh', ['-c', `printf %s ${c.load.split(' ').slice(3).join(' ')}`], { encoding: 'utf8' }).stdout, plist);
});

test('SIGTERM to the supervisor is forwarded to the loop and the supervisor exits 0 after it', async () => {
  const dir = tempDir();
  const marker = join(dir, 'marker');
  const bin = join(dir, 'slow-loop.sh');
  writeFileSync(bin, `#!/bin/sh\ntrap 'echo term >> "${marker}"; exit 143' TERM\necho started >> "${marker}"\nwhile :; do sleep 0.1; done\n`);
  chmodSync(bin, 0o755);
  const p = spawn(process.execPath, [SUPERVISOR], { env: envFor(tempDir(), { MAESTRO_LOOP_BIN: bin }) });
  const closed = new Promise<number | null>((resolve) => p.on('close', resolve));
  for (let i = 0; i < 100 && !existsSync(marker); i += 1) await new Promise((r) => setTimeout(r, 50));
  assert.equal(existsSync(marker), true);
  p.kill('SIGTERM');
  assert.equal(await closed, 0);
  assert.match(readFileSync(marker, 'utf8'), /term/);
});

test('a quiet-hours stop sleeps in quiet mode, a crash or refusal in backoff mode, and a clean exit in idle mode', async () => {
  const r = await drive([{ code: 3, stdout: 'QUIET-HOURS stop until 07:00 UTC' }, { code: 0 }, { code: 2, stderr: 'another event loop is running' }]);
  assert.deepEqual(r.modes, ['quiet', undefined, 'backoff']);
});

test('the real supervisor heartbeats while it waits, as itself, in idle mode', async () => {
  const ledger = tempDir();
  const bin = join(tempDir(), 'exit0.sh');
  writeFileSync(bin, '#!/bin/sh\nexit 0\n');
  chmodSync(bin, 0o755);
  const p = spawn(process.execPath, [SUPERVISOR], { env: envFor(ledger, { MAESTRO_LOOP_BIN: bin }) });
  const closed = new Promise<number | null>((resolve) => p.on('close', resolve));
  const file = join(ledger, 'Events', 'heartbeat.json');
  for (let i = 0; i < 100 && !existsSync(file); i += 1) await new Promise((r) => setTimeout(r, 50));
  p.kill('SIGTERM');
  await closed;
  const beat = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(beat.pid, p.pid);
  assert.equal(beat.mode, 'idle');
  assert.ok(Date.parse(beat.sleepingUntil) > Date.parse(beat.at));
});

test('exit 10 queues only after a successful save, and a queue failure does not stop the loop', async () => {
  const queued: string[] = [];
  const logs: string[] = [];
  const slept: number[] = [];
  let saves = 0;
  await supervise({
    runLoop: async () => ({ code: 10, stdout: saves === 0 ? 'first\n' : 'second\n', stderr: '' }),
    sleep: async (s) => { slept.push(s); },
    save: () => { saves += 1; if (saves === 1) throw new Error('disk full'); },
    log: (l) => { logs.push(l); },
    queueDigest: (d) => { if (d.startsWith('second')) throw new Error('queue down'); queued.push(d); },
    maxRuns: 2,
  });
  assert.deepEqual(queued, []);
  assert.deepEqual(slept, [DELAYS.crash]);
  assert.match(logs.join('\n'), /could not save digest: disk full/);
  assert.match(logs.join('\n'), /could not queue digest fixes: queue down/);
});

test('an empty allowlist logs and does not queue', () => {
  const logs: string[] = [];
  queueSavedDigest('ACTION prs (pr-watch): CONFLICT acme/widget#4 main <- feature https://github.com/acme/widget/pull/4\n', (l) => logs.push(l), {
    vault: tempDir(),
    project: 'proj',
    owners: [],
    enqueue: () => { throw new Error('should not queue'); },
  });
  assert.deepEqual(logs, [NO_OWNER_LOG]);
});

test('a failed queue is logged and the next fix is still attempted', () => {
  const logs: string[] = [];
  const seen: string[] = [];
  const digest = [
    'ACTION prs (pr-watch): CONFLICT acme/widget#4 main <- feature https://github.com/acme/widget/pull/4',
    'ACTION prs (pr-watch): CHECKS-FAILING acme/widget#7 ci https://github.com/acme/widget/pull/7',
  ].join('\n');
  queueSavedDigest(digest, (l) => logs.push(l), {
    vault: tempDir(),
    project: 'proj',
    owners: ['acme'],
    excludeRepos: [],
    enqueue: (item) => { if (item.kind === 'CONFLICT') throw new Error('nope'); seen.push(item.key); },
  });
  assert.deepEqual(seen, ['acme/widget#7|CHECKS-FAILING|https://github.com/acme/widget/pull/7']);
  assert.match(logs.join('\n'), /could not queue acme\/widget#4\|CONFLICT/);
});

test('queueSavedDigest writes one journal item and a second pass does not write another', () => {
  const vault = tempDir();
  const digest = 'ACTION prs (pr-watch): CONFLICT acme/widget#4 main <- feature https://github.com/acme/widget/pull/4\n';
  const logs: string[] = [];
  const opts = { vault, project: 'proj', owners: ['acme'], excludeRepos: [] as string[] };
  queueSavedDigest(digest, (l) => logs.push(l), opts);
  queueSavedDigest(digest, (l) => logs.push(l), opts);
  const ledger = readFileSync(join(vault, 'Projects', 'proj', 'Journal', 'ledger.jsonl'), 'utf8');
  const fixes = ledger.split('\n').filter((l) => l.includes('fix acme/widget#4 CONFLICT https://github.com/acme/widget/pull/4'));
  assert.equal(fixes.length, 1, logs.join('\n') || ledger);
});
