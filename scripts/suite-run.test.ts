// Run: node --test scripts/suite-run.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { EVENT_DIR } from './local-config.ts';
import { listWatches, paths } from './lib/watch-registry.ts';
import { SUITE_WATCH_TTL_MS, jobDir, jobStatus, parseTap, registerWatch, startJob, statusLine, suiteEnv, suitesDir } from './suite-run.ts';
import type { JobStatus } from './suite-run.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const SCRIPT = join(ROOT, 'scripts', 'suite-run.ts');
/** Tests must never touch a live ledger. Run them with a throwaway HOME, MAESTRO_EVENT_DIR and MAESTRO_SUITE_DIR; whatever the code under test resolves by default must then sit under a temp dir, on any machine. */
/** realpath of a path that may not exist yet: resolve the nearest existing ancestor, then re-append the missing tail. */
const resolveMissing = (p: string): string => (existsSync(p) ? realpathSync(p) : join(resolveMissing(dirname(p)), basename(p)));
const underTemp = (p: string): boolean => { const root = realpathSync(tmpdir()); const real = resolveMissing(p); return real === root || real.startsWith(`${root}${sep}`); };
test('a default dir whose parents do not exist is judged without throwing, and a live-ledger path still fails', () => {
  const home = mkdtempSync(join(tmpdir(), 'suite-fixture-home-'));
  assert.ok(underTemp(join(home, '.local', 'state', 'the-maestro')), 'a missing dir under a temp HOME is under a temp dir');
  assert.equal(underTemp(join(ROOT, '.no-such-dir-maestro-340', 'x')), false, 'a missing dir outside tmp is reported as not under a temp dir');
});
test('the default event dir and suite dir resolve under a temp dir, so no registration can reach a live ledger', () => {
  assert.ok(underTemp(EVENT_DIR), `event dir ${EVENT_DIR} is not under a temp dir; run with MAESTRO_EVENT_DIR set to one`);
  assert.ok(underTemp(suitesDir()), `suite dir ${suitesDir()} is not under a temp dir; run with MAESTRO_SUITE_DIR set to one`);
});
test.after(() => {
  assert.ok(underTemp(EVENT_DIR), 'the event dir is still under a temp dir');
  assert.ok(underTemp(paths(EVENT_DIR).watches), 'watches.jsonl lives in the temp event dir');
  const leaked = existsSync(paths(EVENT_DIR).watches) ? readFileSync(paths(EVENT_DIR).watches, 'utf8').split('\n').filter((l) => l.includes('suite-fixture-')) : [];
  assert.deepEqual(leaked, [], 'every test registration targets its own temp event dir, none the default one');
});

/** The CLI's environment for a test: suites, events and the ledger root all in temp dirs. */
const cliEnv = (base: string, events: string): NodeJS.ProcessEnv => ({ ...process.env, MAESTRO_SUITE_DIR: base, MAESTRO_EVENT_DIR: events, LEDGER_ROOT: '', MAESTRO_LOCAL_CONFIG: '' });
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };

/** A committed fixture repo holding the given { file: text }; hooks are off so no global commit hook judges it. */
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'suite-fixture-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'feat: fixture']]) spawnSync('git', args, { cwd: dir, env: GIT_ENV });
  return dir;
}

/** Polls a job once per 200 ms until it is no longer running (a test may wait; the code under test never does). */
async function settled(id: string, base: string): Promise<JobStatus> {
  for (let i = 0; i < 300; i += 1) {
    const s = jobStatus(id, base);
    if (s.state !== 'running') return s;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`job ${id} still running`);
}

const PASSING = "import { test } from 'node:test';\ntest('env is isolated', () => { if (process.env.MAESTRO_NOTIFY_COMMAND !== '/usr/bin/true' || !process.env.HOME?.includes('suite-run-home')) throw new Error(`env leaked: ${process.env.HOME}`); });\ntest('plain pass', () => {});\n";
const FAILING = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('the broken one', () => assert.equal(1, 2));\n";

test('start returns before the suite finishes, then results.json carries counts, failing names, sha and times', async () => {
  const base = mkdtempSync(join(tmpdir(), 'suite-jobs-'));
  const repo = fixture({ 'a.test.ts': PASSING, 'b.test.ts': FAILING });
  const spec = startJob(repo, { tests: '*.test.ts', skipTsc: true, base });
  assert.ok(existsSync(join(jobDir(spec.id, base), 'job.json')));
  assert.ok(spec.workerPid > 0);
  const done = await settled(spec.id, base);
  assert.equal(done.state, 'done');
  const r = done.results;
  assert.ok(r);
  assert.equal(r.pass, false);
  assert.equal(r.head, spec.head);
  assert.equal(r.head, spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim());
  assert.equal(r.tests.pass, 2);
  assert.equal(r.tests.fail, 1);
  assert.equal(r.tests.cancelled, 0);
  assert.notEqual(r.tests.exit, 0);
  assert.deepEqual(r.tests.failing, ['the broken one']);
  assert.deepEqual(r.tsc, { exit: null, skipped: true });
  assert.equal(r.concurrency, 2);
  assert.equal(r.timedOut, false);
  assert.equal(r.killed, undefined);
  assert.ok(Date.parse(r.endedAt) >= Date.parse(r.startedAt));
  assert.match(statusLine(done), /FAIL at .*1 fail.*failing: the broken one/);
});

test('a clean suite passes, and the tests ran with the isolated env (a leak would fail the first test)', async () => {
  const base = mkdtempSync(join(tmpdir(), 'suite-jobs-'));
  const repo = fixture({ 'a.test.ts': PASSING });
  const done = await settled(startJob(repo, { tests: '*.test.ts', skipTsc: true, base }).id, base);
  assert.equal(done.results?.pass, true);
  assert.equal(done.results?.tests.fail, 0);
});

test('tsc is run from the worktree: a type error fails the job, a clean tree passes, a missing tsc fails loudly', async () => {
  const base = mkdtempSync(join(tmpdir(), 'suite-jobs-'));
  const files = { 'a.test.ts': PASSING, 'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: 'nodenext', moduleResolution: 'nodenext', allowImportingTsExtensions: true, types: ['node'], skipLibCheck: true }, include: ['*.ts'] }) };
  const clean = fixture(files);
  const bad = fixture({ ...files, 'bad.ts': 'export const n: number = "text";\n' });
  const bare = fixture(files);
  for (const dir of [clean, bad]) symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
  const run = async (dir: string) => (await settled(startJob(dir, { tests: '*.test.ts', base }).id, base)).results;
  const cleanResults = await run(clean);
  assert.equal(cleanResults?.pass, true);
  assert.equal(cleanResults?.typecheck, 'tsc --noEmit');
  const failed = await run(bad);
  assert.equal(failed?.pass, false);
  assert.notEqual(failed?.tsc.exit, 0);
  assert.equal(failed?.tests.fail, 0);
  const missing = await run(bare);
  assert.equal(missing?.pass, false);
  assert.equal(missing?.tsc.exit, 127);
  assert.match(missing?.tsc.note ?? '', /--skip-tsc/);
});

test('status: unknown job, a worker that died without results, and bad ids', () => {
  const base = mkdtempSync(join(tmpdir(), 'suite-jobs-'));
  assert.equal(jobStatus('nope', base).state, 'unknown');
  mkdirSync(join(base, 'dead-1'));
  writeFileSync(join(base, 'dead-1', 'job.json'), JSON.stringify({ id: 'dead-1', workerPid: 0 }));
  assert.equal(jobStatus('dead-1', base).state, 'lost');
  assert.match(statusLine(jobStatus('dead-1', base)), /lost/);
  for (const id of ['../x', 'a/b', '', '..', '.']) assert.throws(() => jobDir(id, base), /not a job id/, id);
});

test('inside a job, the event, suite and status dirs the env points at exist, so a suite that stats them does not hit ENOENT', async () => {
  const base = mkdtempSync(join(tmpdir(), 'suite-jobs-'));
  const probe = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { existsSync } from 'node:fs';\ntest('job dirs exist', () => { for (const k of ['MAESTRO_EVENT_DIR', 'MAESTRO_SUITE_DIR', 'MAESTRO_STATUS_DIR']) assert.ok(existsSync(process.env[k] as string), `${k} is missing: ${process.env[k]}`); });\n";
  const repo = fixture({ 'a.test.ts': probe });
  const spec = startJob(repo, { tests: '*.test.ts', skipTsc: true, base });
  const done = await settled(spec.id, base);
  assert.deepEqual(done.results?.tests.failing, []);
  assert.equal(done.results?.tests.pass, 1);
});

test('suiteEnv keeps the suite away from real state', () => {
  const env = suiteEnv('/tmp/h', { HOME: '/Users/real', LEDGER_ROOT: '/real/ledger', PATH: '/bin' });
  assert.equal(env.HOME, '/tmp/h');
  assert.equal(env.MAESTRO_NOTIFY_COMMAND, '/usr/bin/true');
  assert.equal(env.LEDGER_ROOT, '');
  assert.equal(env.PATH, '/bin');
  assert.equal('NODE_TEST_CONTEXT' in suiteEnv('/tmp/h', { NODE_TEST_CONTEXT: 'child-v8' }), false);
});

test('parseTap reads counts and names, once each, from node TAP output', () => {
  const tap = 'TAP version 13\n    not ok 1 - inner one\n  not ok 2 - outer one\nnot ok 3 - /x/a.test.ts # failed\nnot ok 4 - todo one # TODO later\nnot ok 5 - skipped one # SKIP\n# tests 5\n# pass 2\n# fail 2\n# cancelled 1\n';
  assert.deepEqual(parseTap(tap), { pass: 2, fail: 2, cancelled: 1, failing: ['inner one', 'outer one', '/x/a.test.ts'] });
  assert.deepEqual(parseTap(''), { pass: 0, fail: 0, cancelled: 0, failing: [] });
});

test('the CLI: start prints a job id and returns; status exits 4 while running or 0/1 when finished; no args is usage', async () => {
  const base = mkdtempSync(join(tmpdir(), 'suite-jobs-'));
  const repo = fixture({ 'a.test.ts': PASSING });
  const events = mkdtempSync(join(tmpdir(), 'suite-events-'));
  const env = cliEnv(base, events);
  const started = spawnSync(process.execPath, [SCRIPT, 'start', repo, '--tests', '*.test.ts', '--skip-tsc', '--json'], { encoding: 'utf8', env });
  assert.equal(started.status, 0, started.stderr);
  const { job, watch } = JSON.parse(started.stdout) as { job: string; watch: string };
  assert.equal(watch, `suite-${job}`);
  const [w, ...others] = listWatches(events);
  assert.equal(others.length, 0);
  assert.deepEqual([w?.id, w?.type, w?.target, w?.notify], [`suite-${job}`, 'suite-done', job, false]);
  assert.equal(Date.parse(w?.expires ?? '') - Date.parse(w?.created ?? ''), SUITE_WATCH_TTL_MS);
  assert.match(w?.report ?? '', /fresh reviewer/);
  await settled(job, base);
  const status = spawnSync(process.execPath, [SCRIPT, 'status', job], { encoding: 'utf8', env });
  assert.equal(status.status, 0, status.stdout + status.stderr);
  assert.match(status.stdout, /PASS/);
  assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env }).status, 2);
});

test('zero tests is a FAIL with a note, never a PASS: a glob matching nothing, and a non-node repo', async () => {
  const base = mkdtempSync(join(tmpdir(), 'suite-jobs-'));
  const repo = fixture({ 'a.test.ts': PASSING });
  const nothing = (await settled(startJob(repo, { tests: 'nope/*.test.ts', skipTsc: true, base }).id, base)).results;
  assert.equal(nothing?.pass, false);
  assert.equal(nothing?.tests.empty, true);
  assert.match(nothing?.tests.note ?? '', /no tests ran.*--cmd/);
  const other = fixture({ 'main.py': 'print(1)\n' });
  const py = await settled(startJob(other, { skipTsc: true, base }).id, base);
  assert.equal(py.results?.pass, false);
  assert.match(statusLine(py), /FAIL.*0 ran, which is a failure/);
});

test('--cmd replaces node --test: the command exit code decides, and zero parsed tests is fine', async () => {
  const base = mkdtempSync(join(tmpdir(), 'suite-jobs-'));
  const repo = fixture({ 'main.py': 'print(1)\n' });
  const ok = await settled(startJob(repo, { cmd: 'python3 main.py', skipTsc: true, base }).id, base);
  assert.equal(ok.results?.pass, true);
  assert.equal(ok.results?.tests.cmd, 'python3 main.py');
  assert.match(statusLine(ok), /PASS.*custom command exit 0/);
  const bad = await settled(startJob(repo, { cmd: 'exit 3', skipTsc: true, base }).id, base);
  assert.equal(bad.results?.pass, false);
  assert.equal(bad.results?.tests.exit, 3);
  const events = mkdtempSync(join(tmpdir(), 'suite-events-'));
  const cli = spawnSync(process.execPath, [SCRIPT, 'start', repo, '--cmd', 'true', '--skip-tsc', '--no-watch', '--json'], { encoding: 'utf8', env: cliEnv(base, events) });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal((JSON.parse(cli.stdout) as { watch: unknown }).watch, null);
  assert.deepEqual(listWatches(events), [], '--no-watch registers nothing');
  assert.equal((await settled((JSON.parse(cli.stdout) as { job: string }).job, base)).results?.pass, true);
});

test('a package.json typecheck script is what runs (and is recorded); without one it is tsc --noEmit; --skip-tsc records skipped', async () => {
  const base = mkdtempSync(join(tmpdir(), 'suite-jobs-'));
  const pkg = (typecheck: string) => JSON.stringify({ name: 'fx', private: true, scripts: { typecheck } });
  const run = async (files: Record<string, string>, skipTsc = false) => (await settled(startJob(fixture({ 'a.test.ts': PASSING, ...files }), { tests: '*.test.ts', skipTsc, base }).id, base)).results;
  const failing = await run({ 'package.json': pkg('node -e "process.exit(7)"') });
  assert.equal(failing?.typecheck, 'npm run typecheck');
  assert.equal(failing?.tsc.exit, 7);
  assert.equal(failing?.pass, false);
  const passing = await run({ 'package.json': pkg('node -e "process.exit(0)"') });
  assert.equal(passing?.typecheck, 'npm run typecheck');
  assert.equal(passing?.pass, true, 'no node_modules/.bin/tsc is needed when the repo has its own script');
  const noScript = await run({ 'package.json': JSON.stringify({ name: 'fx', scripts: { test: 'x' } }) });
  assert.equal(noScript?.typecheck, 'tsc --noEmit');
  assert.equal(noScript?.tsc.exit, 127);
  assert.equal((await run({ 'package.json': pkg('exit 7') }, true))?.typecheck, 'skipped');
});

/** A fixture whose one test records its pid and HOME in `mark`, then hangs forever. */
function hangingRepo(mark: string): string {
  return fixture({ 'hang.test.ts': `import { test } from 'node:test';\nimport { writeFileSync } from 'node:fs';\ntest('hangs', async () => { writeFileSync(${JSON.stringify(mark)}, process.pid + '\\n' + process.env.HOME); setInterval(() => {}, 1000); await new Promise(() => {}); });\n` });
}

const gone = async (pid: number): Promise<boolean> => {
  for (let i = 0; i < 50; i += 1) {
    try { process.kill(pid, 0); } catch { return true; }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

/** Waits (bounded) for the hanging test to write its mark; returns its pid and HOME. */
async function marked(mark: string): Promise<{ pid: number; home: string }> {
  for (let i = 0; i < 100; i += 1) {
    if (existsSync(mark)) { const [pid, home] = readFileSync(mark, 'utf8').split('\n'); if (home) return { pid: Number(pid), home }; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('the hanging test never started');
}

/** A bounded wait for results.json, so a regression that hangs the worker fails this test instead of the run. */
async function results(id: string, base: string, seconds = 20): Promise<NonNullable<JobStatus['results']>> {
  for (let i = 0; i < seconds * 5; i += 1) {
    const r = jobStatus(id, base).results;
    if (r) return r;
    await new Promise((r2) => setTimeout(r2, 200));
  }
  throw new Error(`no results.json for ${id} after ${seconds}s`);
}

const reap = (...pids: number[]): void => { for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } } };

test('a hung job is killed at --timeout-min: process group gone, temp HOME removed, results.json says timedOut and FAIL', async () => {
  const base = mkdtempSync(join(tmpdir(), 'suite-jobs-'));
  const mark = join(mkdtempSync(join(tmpdir(), 'suite-mark-')), 'mark');
  const spec = startJob(hangingRepo(mark), { tests: '*.test.ts', skipTsc: true, timeoutMin: 0.05, base });
  let pid = 0;
  try {
    const started = await marked(mark);
    pid = started.pid;
    const r = await results(spec.id, base);
    assert.equal(r.timedOut, true);
    assert.equal(r.pass, false);
    assert.match(statusLine(jobStatus(spec.id, base)), /FAIL.*timed out/);
    assert.equal(await gone(pid), true, 'the test process must not outlive the job');
    assert.equal(existsSync(started.home), false, 'the temp HOME is removed');
  } finally { reap(pid, spec.workerPid); }
});

test('SIGTERM to the worker kills its children, removes the temp HOME and still writes results.json with a killed note', async () => {
  const base = mkdtempSync(join(tmpdir(), 'suite-jobs-'));
  const mark = join(mkdtempSync(join(tmpdir(), 'suite-mark-')), 'mark');
  const spec = startJob(hangingRepo(mark), { tests: '*.test.ts', skipTsc: true, base });
  let pid = 0;
  try {
    const started = await marked(mark);
    pid = started.pid;
    process.kill(spec.workerPid, 'SIGTERM');
    const r = await results(spec.id, base);
    assert.match(r.killed ?? '', /SIGTERM/);
    assert.equal(r.pass, false);
    assert.equal(r.timedOut, false);
    assert.match(statusLine(jobStatus(spec.id, base)), /FAIL.*killed/);
    assert.equal(await gone(pid), true, 'the test process must not outlive the worker');
    assert.equal(existsSync(started.home), false);
  } finally { reap(pid, spec.workerPid); }
});

test('--timeout-min is validated on the CLI', () => {
  const repo = fixture({ 'a.test.ts': PASSING });
  const env = cliEnv(mkdtempSync(join(tmpdir(), 'suite-jobs-')), mkdtempSync(join(tmpdir(), 'suite-events-')));
  assert.equal(spawnSync(process.execPath, [SCRIPT, 'start', repo, '--timeout-min', '0', '--skip-tsc'], { encoding: 'utf8', env }).status, 2);
});

test('registerWatch writes a suite-done watch into the given event dir only, and refuses a second one for the same job', () => {
  const base = mkdtempSync(join(tmpdir(), 'suite-jobs-'));
  const events = mkdtempSync(join(tmpdir(), 'suite-events-'));
  const spec = startJob(fixture({ 'a.test.ts': PASSING }), { tests: '*.test.ts', skipTsc: true, base });
  assert.equal(registerWatch(spec, events), `suite-${spec.id}`);
  assert.equal(listWatches(events).length, 1);
  assert.throws(() => registerWatch(spec, events), /already exists/);
});
