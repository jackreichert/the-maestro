// Run: node --test scripts/loop-supervisor.test.ts
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess, StdioOptions } from 'node:child_process';
import { appendFileSync, closeSync, rmSync, readdirSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DELAYS, quietSleepSeconds, queueSavedDigest, secondsUntilClock, supervise } from './loop-supervisor.ts';
import type { LoopResult } from './loop-supervisor.ts';
import { NO_OWNER_LOG } from './lib/digest-queue.ts';
import { digestBody, digestDir, saveDigest, unseenDigests } from './lib/digest-store.ts';
import { appendEvents, readInbox } from './lib/event-inbox.ts';
import { checkedOutBranch, commands, fillTemplate, LABEL, otherLoopPlists, shq } from './install-loop-supervisor.ts';
import { supervisorLogPath } from './lib/supervisor-state.ts';
import { cleanEnv, notifyCalls } from './lib/test-env.ts';

const tempDir = () => mkdtempSync(join(tmpdir(), 'loop-supervisor-test-'));
const SUPERVISOR = new URL('./loop-supervisor.ts', import.meta.url).pathname;
const INSTALL = new URL('./install-loop-supervisor.ts', import.meta.url).pathname;
/** How long a real supervisor gets for a cold node start under load; the waits return as soon as the condition holds, so this only costs time when something is wrong. */
const PATIENCE_MS = 60_000;

/** Polls `done` every 50 ms until it is true or `ms` pass; returns whether it became true. */
async function waitFor(done: () => boolean, ms: number = PATIENCE_MS): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (done()) return true;
  return done();
}

/** Supervisors started by `startSupervisor` that have not closed yet; the `after` hook kills what a failed assertion left behind. */
const live = new Set<ChildProcess>();
/** SIGKILLs the supervisor's whole process group (it and the loop it launched), if it is still ours to kill. */
const killTree = (p: ChildProcess): void => { if (live.has(p) && p.pid) { try { process.kill(-p.pid, 'SIGKILL'); } catch { /* already gone */ } } };
after(() => { for (const p of live) killTree(p); });

/** A real supervisor in its own process group, so a test that throws before it stops the supervisor can still kill the loop under it. */
function startSupervisor(env: NodeJS.ProcessEnv, stdio?: StdioOptions): { p: ChildProcess; closed: Promise<number | null> } {
  const p = spawn(process.execPath, [SUPERVISOR], { env, stdio, detached: true });
  live.add(p);
  const closed = new Promise<number | null>((resolve) => p.on('close', (code) => { live.delete(p); resolve(code); }));
  return { p, closed };
}
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

/**
 * The env that makes a real supervisor's loop be node itself, steered by a preloaded module that runs `body` only when it is launched as the loop
 * (`node run --serve`; the supervisor, which shares NODE_OPTIONS, is untouched). Tests used to write an executable script instead, but the first
 * run of a freshly written executable can stall for minutes under load (a macOS provenance scan), which no sensible wait covers; node is already trusted.
 */
function nodeLoop(body: string): Record<string, string> {
  const preload = join(tempDir(), 'loop.mjs');
  writeFileSync(preload, `import { appendFileSync, writeFileSync } from 'node:fs';\nif (process.argv.includes('--serve')) {\n${body}\n}\n`);
  return { MAESTRO_LOOP_BIN: process.execPath, NODE_OPTIONS: `--import ${pathToFileURL(preload).href}` };
}
/** A loop that prints a digest and exits 10. */
const fakeLoop = (): Record<string, string> => nodeLoop(`console.log('ACTION w1 (fake): changed');\nprocess.exit(10);`);
/** A loop that exits 0 at once. */
const exit0Loop = (): Record<string, string> => nodeLoop('process.exit(0);');

/** Every env a real supervisor or installer ran with; the `after` hook below fails the file if any of them reached a notify command. */
const envsUsed: NodeJS.ProcessEnv[] = [];
/** The env for a spawned supervisor or installer: built clean (temp HOME, no user config, a recording notify stub), never from `process.env`. */
const envFor = (ledger: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const env = { ...cleanEnv(), LEDGER_ROOT: ledger, MAESTRO_PROJECT: 'proj', MAESTRO_EVENT_DIR: join(ledger, 'Events'), ...extra };
  envsUsed.push(env);
  return env;
};
after(() => { for (const env of envsUsed) assert.deepEqual(notifyCalls(env), [], 'a test supervisor sent a notification'); });

test('the real supervisor process saves the fake loop digest under the ledger root only', () => {
  const ledger = tempDir();
  const r = spawnSync(process.execPath, [SUPERVISOR], { encoding: 'utf8', env: envFor(ledger, { ...fakeLoop(), MAESTRO_SUPERVISOR_MAX_RUNS: '2' }) });
  assert.equal(r.status, 0, r.stderr);
  const dir = digestDir(ledger, 'proj');
  // Each saved digest is then moved into the inbox, which marks it seen.
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  assert.equal(files.length, 2);
  assert.equal(unseenDigests(dir).length, 0);
  assert.equal(digestBody(join(dir, files[0])), 'ACTION w1 (fake): changed');
  assert.ok(readInbox(join(ledger, 'Events')).length >= 1);
});

test('the supervisor refuses to start without a ledger root and writes nothing', () => {
  const r = spawnSync(process.execPath, [SUPERVISOR], { encoding: 'utf8', env: { ...envFor('x'), LEDGER_ROOT: '', ...fakeLoop(), MAESTRO_SUPERVISOR_MAX_RUNS: '1' } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no ledger root/);
});

test('install fills every placeholder, prints the launchctl commands, never runs them, and refuses while a loop holds the lock', () => {
  const ledger = tempDir();
  const out = join(tempDir(), 'x.plist');
  const ok = spawnSync(process.execPath, [INSTALL, '--out', out, '--allow-branch'], { encoding: 'utf8', env: envFor(ledger, { MAESTRO_LAUNCH_AGENTS_DIR: tempDir() }) });
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
  const refused = spawnSync(process.execPath, [INSTALL, '--out', out2, '--allow-branch'], { encoding: 'utf8', env: envFor(ledger, { MAESTRO_LAUNCH_AGENTS_DIR: tempDir() }) });
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
  const loop = nodeLoop(`process.on('SIGTERM', () => { appendFileSync(${JSON.stringify(marker)}, 'term\\n'); process.exit(143); });\nappendFileSync(${JSON.stringify(marker)}, 'started\\n');\nsetInterval(() => {}, 1000);\nawait new Promise(() => {});`);
  const { p, closed } = startSupervisor(envFor(tempDir(), loop));
  try {
    assert.equal(await waitFor(() => existsSync(marker)), true, 'the loop never started');
    p.kill('SIGTERM');
    assert.equal(await closed, 0);
    assert.match(readFileSync(marker, 'utf8'), /term/);
  } finally { killTree(p); }
});

test('a quiet-hours stop sleeps in quiet mode, a crash or refusal in backoff mode, and a clean exit in idle mode', async () => {
  const r = await drive([{ code: 3, stdout: 'QUIET-HOURS stop until 07:00 UTC' }, { code: 0 }, { code: 2, stderr: 'another event loop is running' }]);
  assert.deepEqual(r.modes, ['quiet', undefined, 'backoff']);
});

test('the real supervisor heartbeats while it waits, as itself, in idle mode', async () => {
  const ledger = tempDir();
  const { p, closed } = startSupervisor(envFor(ledger, exit0Loop()));
  try {
    const file = join(ledger, 'Events', 'heartbeat.json');
    const read = (): { pid?: number; mode?: string; at: string; sleepingUntil: string } | null => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
    assert.equal(await waitFor(() => read()?.mode === 'idle'), true, 'no idle heartbeat appeared');
    p.kill('SIGTERM');
    await closed;
    const beat = read();
    assert.ok(beat);
    assert.equal(beat.pid, p.pid);
    assert.equal(beat.mode, 'idle');
    assert.ok(Date.parse(beat.sleepingUntil) > Date.parse(beat.at));
  } finally { killTree(p); }
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

test('a hung loop (killed by the watchdog) is relaunched at once, with a log line and no back-off sleep', async () => {
  const r = await drive([{ code: null, hung: true }, { code: 0 }]);
  assert.deepEqual(r.slept, [DELAYS.idle]);
  assert.match(r.logs.join('\n'), /hung/);
  assert.equal(r.launches, 2);
});

test('the real supervisor launches the loop in serve mode', () => {
  const ledger = tempDir();
  const dir = tempDir();
  const loop = nodeLoop(`writeFileSync(${JSON.stringify(join(dir, 'args'))}, ['run', ...process.argv.slice(2)].join(' '));\nconsole.log('ACTION w1 (fake): x');\nprocess.exit(10);`);
  const r = spawnSync(process.execPath, [SUPERVISOR], { encoding: 'utf8', timeout: PATIENCE_MS, env: envFor(ledger, { ...loop, MAESTRO_SUPERVISOR_MAX_RUNS: '1' }) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(dir, 'args'), 'utf8').trim(), 'run --serve');
});

test('the real supervisor kills a loop that is alive but silent, then relaunches it', () => {
  const ledger = tempDir();
  const dir = tempDir();
  const ran = join(dir, 'ran');
  // The loop is node itself, steered by a preloaded module (`node run --serve` never gets as far as looking for a file named `run`).
  // The watchdog's clock starts when the supervisor spawns the loop, so the loop must be cheap to start: executing a freshly written
  // script can take minutes under macOS provenance checks, which is longer than any sensible grace, while node is already trusted.
  // NODE_OPTIONS reaches the supervisor too, so the module acts only when it is the loop (`node run --serve`). First launch: record that it ran, then stay alive and silent (a preload that never settles keeps node from looking for the file `run`, and the timer keeps node from exiting). Second launch: print a digest and exit 10.
  const preload = join(dir, 'hang-loop.mjs');
  writeFileSync(preload, `import { existsSync, writeFileSync } from 'node:fs';\nif (process.argv.includes('--serve')) {\n  if (existsSync(${JSON.stringify(ran)})) { console.log('ACTION w1 (fake): x'); process.exit(10); }\n  writeFileSync(${JSON.stringify(ran)}, '');\n  setInterval(() => {}, 1000);\n  await new Promise(() => {});\n}\n`);
  const r = spawnSync(process.execPath, [SUPERVISOR], { encoding: 'utf8', timeout: PATIENCE_MS, env: envFor(ledger, { MAESTRO_LOOP_BIN: process.execPath, NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`, MAESTRO_SUPERVISOR_MAX_RUNS: '2', MAESTRO_WATCHDOG_GRACE_MS: '4000', MAESTRO_WATCHDOG_INTERVAL_MS: '200' }) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(ran), true, 'the first launch never ran');
  assert.equal(r.stderr.match(/is hung/g)?.length, 1, 'exactly one launch is killed as hung');
  assert.equal(readdirSync(digestDir(ledger, 'proj')).filter((f) => f.endsWith('.md')).length, 1);
});

test('the real supervisor rotates its log when it is over the limit, keeping the old text in .1', async () => {
  const ledger = tempDir();
  const log = supervisorLogPath(ledger, 'proj');
  mkdirSync(dirname(log), { recursive: true });
  writeFileSync(log, 'old line\n'.repeat(200));
  const fd = openSync(log, 'a');
  const { p, closed } = startSupervisor(envFor(ledger, { ...exit0Loop(), MAESTRO_LOG_MAX_BYTES: '1000' }), ['ignore', fd, fd]);
  try {
    assert.equal(await waitFor(() => existsSync(`${log}.1`)), true, 'the log was never rotated');
    p.kill('SIGTERM');
    await closed;
    assert.match(readFileSync(`${log}.1`, 'utf8'), /^old line/);
    assert.ok(statSync(log).size < 1000);
  } finally { killTree(p); closeSync(fd); }
});

test('the real supervisor moves a digest that was already saved and unseen into the inbox when it starts', () => {
  const ledger = tempDir();
  const dir = digestDir(ledger, 'proj');
  saveDigest(dir, 'ACTION w9 (fake): left over from an older loop');
  const loop = nodeLoop('process.exit(10);');
  const r = spawnSync(process.execPath, [SUPERVISOR], { encoding: 'utf8', timeout: PATIENCE_MS, env: envFor(ledger, { ...loop, MAESTRO_SUPERVISOR_MAX_RUNS: '1' }) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(unseenDigests(dir).length, 0);
  assert.deepEqual(readInbox(join(ledger, 'Events')).map((e) => e.watch), ['w9']);
  assert.match(r.stderr, /moved 1 saved digest/);
});

test('the installer refuses while another maestro-loop plist is installed, but not for its own plist', () => {
  const ledger = tempDir();
  const agents = tempDir();
  const out = join(agents, `${LABEL}.plist`);
  writeFileSync(join(agents, 'com.example.maestro-loop-old.plist'), '<plist/>');
  const run = () => spawnSync(process.execPath, [INSTALL, '--out', out, '--allow-branch'], { encoding: 'utf8', env: envFor(ledger, { MAESTRO_LAUNCH_AGENTS_DIR: agents }) });
  const refused = run();
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /com\.example\.maestro-loop-old\.plist/);
  assert.equal(existsSync(out), false);
  assert.deepEqual(otherLoopPlists(agents, out).map((p) => p.split('/').pop()), ['com.example.maestro-loop-old.plist']);
  rmSync(join(agents, 'com.example.maestro-loop-old.plist'));
  assert.equal(run().status, 0);
  assert.equal(run().status, 0, 'installing again over its own plist is fine');
});

test('the installer refuses a checkout that is on a branch unless told otherwise; a detached one is the runtime worktree', () => {
  const repo = tempDir();
  const git = (...a: string[]) => spawnSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'chore: init');
  assert.equal(checkedOutBranch(repo), 'main');
  git('checkout', '-q', '--detach');
  assert.equal(checkedOutBranch(repo), null);
  assert.equal(checkedOutBranch(tempDir()), null);
  const ledger = tempDir();
  const install = (repoPath: string, ...flags: string[]) => spawnSync(process.execPath, [INSTALL, '--out', join(tempDir(), 'x.plist'), ...flags], { encoding: 'utf8', env: envFor(ledger, { MAESTRO_LAUNCH_AGENTS_DIR: tempDir(), MAESTRO_INSTALL_REPO: repoPath }) });
  assert.equal(install(repo).status, 0);
  git('checkout', '-q', 'main');
  const refused = install(repo);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /is on branch main.*git worktree add --detach/);
  assert.equal(install(repo, '--allow-branch').status, 0);
});

test('the installer will not replace an existing plist that points at a different checkout, unless --force', () => {
  const ledger = tempDir();
  const out = join(tempDir(), `${LABEL}.plist`);
  const install = (repoPath: string, ...flags: string[]) => spawnSync(process.execPath, [INSTALL, '--out', out, '--allow-branch', ...flags], { encoding: 'utf8', env: envFor(ledger, { MAESTRO_LAUNCH_AGENTS_DIR: tempDir(), MAESTRO_INSTALL_REPO: repoPath }) });
  const runtime = join(tempDir(), 'runtime');
  const scratch = join(tempDir(), 'scratch');
  assert.equal(install(runtime).status, 0);
  const before = readFileSync(out, 'utf8');
  assert.equal(install(runtime).status, 0, 'an identical rewrite is fine');
  const refused = install(scratch);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /already exists and differs/);
  assert.match(refused.stderr, /--force/);
  assert.equal(readFileSync(out, 'utf8'), before, 'the existing plist is untouched');
  assert.equal(install(scratch, '--force').status, 0);
  assert.match(readFileSync(out, 'utf8'), new RegExp(scratch));
});

/**
 * A real supervisor whose loop is `run --serve` and stays up (it never exits, as in production): node steered by a preloaded module that takes the
 * loop lock and writes a fresh `run` heartbeat. `seed` runs before the supervisor starts. Notify goes to the recording stub in `env`, never a real command.
 */
function serveSupervisor(seed: (events: string) => void) {
  const ledger = tempDir();
  const events = join(ledger, 'Events');
  mkdirSync(events, { recursive: true });
  seed(events);
  const preload = join(tempDir(), 'serve-loop.mjs');
  writeFileSync(preload, `import { writeFileSync } from 'node:fs';\nif (process.argv.includes('--serve')) {\n  const dir = ${JSON.stringify(events)};\n  writeFileSync(dir + '/loop.lock', String(process.pid));\n  const now = Date.now();\n  writeFileSync(dir + '/heartbeat.json', JSON.stringify({ pid: process.pid, at: new Date(now).toISOString(), tick: 1, watchesLive: 1, sleepingUntil: new Date(now + 3600_000).toISOString(), mode: 'run', lastError: '' }));\n  setInterval(() => {}, 1000);\n  await new Promise(() => {});\n}\n`);
  const env = cleanEnv({ LEDGER_ROOT: ledger, MAESTRO_PROJECT: 'proj', MAESTRO_EVENT_DIR: events, MAESTRO_LOOP_BIN: process.execPath, NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`, MAESTRO_WATCHDOG_INTERVAL_MS: '100', MAESTRO_ALERT_QUIET_HOURS: 'off' });
  return { ...startSupervisor(env), env, events };
}

test('while a serve loop stays up, the supervisor still texts a recovery and a PR event once each', async () => {
  const { p, closed, env } = serveSupervisor((events) => {
    // A DOWN text went out an hour ago and was never followed by a recovered one; a conflict has sat unseen for 20 minutes.
    writeFileSync(join(events, 'alerts.json'), JSON.stringify({ lastSentAt: Date.now() - 3600_000, alerted: [], badSince: Date.now() - 3600_000, badAlerted: true, restarts: [], restartAlerted: false, failures: 0 }));
    appendEvents(events, [{ watch: 'pr-watch', type: 'pr-watch', at: new Date(Date.now() - 20 * 60_000).toISOString(), summary: 'CONFLICT Fake-Org/fake-repo#12 needs a rebase', actionable: true, report: '' }]);
  });
  try {
    assert.equal(await waitFor(() => notifyCalls(env).length > 0), true, 'no text reached the notify command while the loop was up');
    await new Promise((r) => setTimeout(r, 1500));
    const calls = notifyCalls(env);
    assert.equal(calls.length, 1, calls.join(' | '));
    assert.match(calls[0] ?? '', /loop recovered/);
    assert.match(calls[0] ?? '', /fake-repo#12/);
  } finally { p.kill('SIGTERM'); await closed; killTree(p); }
});

test('a normal start with an empty inbox and a loop that stays up sends no text', async () => {
  const { p, closed, env, events } = serveSupervisor(() => {});
  try {
    // Ticks run every 100 ms here; wait until the tick has really run (it saves nothing when it has nothing to say), then a little longer.
    assert.equal(await waitFor(() => existsSync(join(events, 'supervisor.json'))), true, 'the supervisor never started');
    await new Promise((r) => setTimeout(r, 2000));
    assert.deepEqual(notifyCalls(env), []);
  } finally { p.kill('SIGTERM'); await closed; killTree(p); }
});
