#!/usr/bin/env node
/**
 * suite-run.ts: run a worktree's type check and test suite as a detached job, so no agent ever waits on one.
 *
 *   suite-run.ts start <worktree> [--tests <glob>] [--skip-tsc] [--json]   spawn the job, print its id, return at once
 *   suite-run.ts status <job> [--json]                                      look once, never block
 *
 * `start` writes <suites dir>/<job>/job.json, spawns this script detached (`_worker`), and exits. The worker runs
 * `tsc --noEmit` (the worktree's own node_modules/.bin/tsc) and then `node --test`, and its last act is writing
 * <suites dir>/<job>/results.json (atomically): pass/fail/cancelled counts, failing test names, head sha, start and end
 * times and both exit codes. results.json appearing is the "suite is done" signal; the `suite-done` event type watches it.
 * The raw output stays in <suites dir>/<job>/output.log for a failure worth reading.
 *
 * The suites dir is MAESTRO_SUITE_DIR, else <event dir>/suites (local-config.ts), so a job lives beside the other loop state
 * and never inside the worktree it tests. A job id is <12 hex of the head sha>-<base36 start time>.
 *
 * The tests run with a throwaway HOME, no notify command (`/usr/bin/true`), no ledger, vault or event dir, and
 * `--test-concurrency=2`, so a suite run can neither notify a phone nor write real state.
 *
 * Exit codes of `status`: 0 finished and passed, 1 finished and failed (or the worker died), 4 still running, 2 usage.
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { EVENT_DIR } from './local-config.ts';
import { printJson } from './lib/json-out.ts';

export const DEFAULT_TESTS = 'scripts/**/*.test.ts';
export const TEST_CONCURRENCY = 2;
export const EXIT = { passed: 0, failed: 1, usage: 2, running: 4 };
const JOB_ID = /^[\w.-]+$/;

/** What `start` records for a job before the worker begins. */
export interface JobSpec {
  id: string;
  worktree: string;
  head: string;
  /** True when the worktree had uncommitted changes at start: the results describe the files on disk, not only the head commit. */
  dirty: boolean;
  tests: string;
  skipTsc: boolean;
  startedAt: string;
  workerPid: number;
}

/** One command's outcome: exit code, with `skipped` for a step the job was told not to run. */
export interface StepResult { exit: number | null; skipped?: boolean; note?: string }

/** What the worker writes last. `pass` means tsc passed (or was skipped by request) and every test passed. */
export interface Results {
  job: string;
  worktree: string;
  head: string;
  dirty: boolean;
  startedAt: string;
  endedAt: string;
  pass: boolean;
  tsc: StepResult;
  tests: StepResult & { pass: number; fail: number; cancelled: number; failing: string[] };
  concurrency: number;
}

/** Where jobs live: MAESTRO_SUITE_DIR, else <event dir>/suites. */
export const suitesDir = (env: NodeJS.ProcessEnv = process.env): string => env.MAESTRO_SUITE_DIR || join(EVENT_DIR, 'suites');

/** The job's directory. Throws for an id that could name a path outside the suites dir. */
export function jobDir(id: string, base: string = suitesDir()): string {
  if (!JOB_ID.test(id) || id === '.' || id === '..') throw new Error(`suite-run: "${id}" is not a job id`);
  return join(base, id);
}

const git = (cwd: string, args: string[]): { status: number | null; stdout: string } => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return { status: r.status, stdout: (r.stdout ?? '').trim() };
};

/** Writes JSON beside its final path and renames it in, so a reader never sees half a file. */
function writeAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

const readJson = <T>(path: string): T | null => {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return null; }
};

/** Starts a detached job for `worktree` and returns its spec at once. Throws when the path is not a git worktree. */
export function startJob(worktree: string, opts: { tests?: string; skipTsc?: boolean; base?: string; now?: Date } = {}): JobSpec {
  const root = resolve(worktree);
  const head = git(root, ['rev-parse', 'HEAD']);
  if (head.status !== 0 || !head.stdout) throw new Error(`suite-run: ${root} is not a git worktree with a commit`);
  const now = opts.now ?? new Date();
  const id = `${head.stdout.slice(0, 12)}-${now.getTime().toString(36)}`;
  const dir = jobDir(id, opts.base);
  mkdirSync(dir, { recursive: true });
  const spec: JobSpec = {
    id, worktree: root, head: head.stdout, dirty: git(root, ['status', '--porcelain']).stdout !== '',
    tests: opts.tests || DEFAULT_TESTS, skipTsc: Boolean(opts.skipTsc), startedAt: now.toISOString(), workerPid: 0,
  };
  // job.json goes down before the worker starts, so a worker never reads a missing spec; the pid is filled in right after the spawn.
  writeAtomic(join(dir, 'job.json'), spec);
  const log = openSync(join(dir, 'output.log'), 'a');
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '_worker', dir], { cwd: root, detached: true, stdio: ['ignore', log, log], env: process.env });
    child.unref();
    spec.workerPid = child.pid ?? 0;
  } finally { closeSync(log); }
  writeAtomic(join(dir, 'job.json'), spec);
  return spec;
}

/** One finished test run's counts and failing names, from node's TAP output. Nested failures count once by name. */
export function parseTap(text: string): { pass: number; fail: number; cancelled: number; failing: string[] } {
  const total = (name: string): number => Number(new RegExp(`^# ${name} (\\d+)$`, 'm').exec(text)?.[1] ?? 0);
  const failing = [...new Set([...text.matchAll(/^\s*not ok \d+ - (.+?)(?:\s+# .*)?$/gm)].map((m) => (m[1] as string).trim()))];
  return { pass: total('pass'), fail: total('fail'), cancelled: total('cancelled'), failing };
}

/** The environment the suite's own processes get: nothing that can reach real state or send a notification. */
export function suiteEnv(home: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // NODE_TEST_CONTEXT is set inside a `node --test` child: inherited, it turns the suite's own `node --test` into a silent child reporter that reports nothing.
  const { NODE_TEST_CONTEXT: _inherited, ...rest } = base;
  return {
    ...rest,
    HOME: home,
    MAESTRO_NOTIFY_COMMAND: '/usr/bin/true',
    MAESTRO_LOCAL_CONFIG: '',
    MAESTRO_EVENT_DIR: join(home, 'events'),
    MAESTRO_SUITE_DIR: join(home, 'suites'),
    LEDGER_ROOT: '',
    VAULT_ROOT: '',
    MAESTRO_STATUS_DIR: join(home, 'status'),
    NODE_COMPILE_CACHE: join(home, 'compile-cache'),
    GIT_ALLOW_PROTOCOL: 'file',
  };
}

function runTsc(spec: JobSpec, env: NodeJS.ProcessEnv): StepResult {
  if (spec.skipTsc) return { exit: null, skipped: true };
  const tsc = join(spec.worktree, 'node_modules', '.bin', 'tsc');
  if (!existsSync(tsc)) return { exit: 127, note: `no ${tsc}; install dependencies or pass --skip-tsc` };
  const r = spawnSync(tsc, ['--noEmit'], { cwd: spec.worktree, env, stdio: ['ignore', 'inherit', 'inherit'] });
  return { exit: r.status ?? 1 };
}

function runTests(spec: JobSpec, env: NodeJS.ProcessEnv, dir: string): Results['tests'] {
  const tap = join(dir, 'tests.tap');
  const out = openSync(tap, 'w');
  let status: number | null;
  try {
    status = spawnSync(process.execPath, ['--test', `--test-concurrency=${TEST_CONCURRENCY}`, '--test-reporter=tap', spec.tests], { cwd: spec.worktree, env, stdio: ['ignore', out, 'inherit'] }).status;
  } finally { closeSync(out); }
  return { exit: status ?? 1, ...parseTap(readFileSync(tap, 'utf8')) };
}

/** The detached half of `start`: runs both steps, then writes results.json. A crash before that leaves no results, which `status` reports as lost. */
export function runWorker(dir: string): Results {
  const spec = readJson<JobSpec>(join(dir, 'job.json'));
  if (!spec) throw new Error(`suite-run: no job.json in ${dir}`);
  const home = mkdtempSync(join(tmpdir(), 'suite-run-home-'));
  const env = suiteEnv(home);
  try {
    const tsc = runTsc(spec, env);
    const tests = runTests(spec, env, dir);
    const pass = (tsc.exit === 0 || tsc.skipped === true) && tests.exit === 0 && tests.fail === 0 && tests.cancelled === 0;
    const results: Results = { job: spec.id, worktree: spec.worktree, head: spec.head, dirty: spec.dirty, startedAt: spec.startedAt, endedAt: new Date().toISOString(), pass, tsc, tests, concurrency: TEST_CONCURRENCY };
    writeAtomic(join(dir, 'results.json'), results);
    return results;
  } finally { rmSync(home, { recursive: true, force: true }); }
}

/** A job's state: `running`, `done` (results present), `lost` (the worker is gone and wrote none), or `unknown` (no such job). */
export interface JobStatus { state: 'running' | 'done' | 'lost' | 'unknown'; job: string; results?: Results; spec?: JobSpec }

const alive = (pid: number): boolean => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

/** One look at a job. Never waits. */
export function jobStatus(id: string, base: string = suitesDir()): JobStatus {
  const dir = jobDir(id, base);
  const results = readJson<Results>(join(dir, 'results.json'));
  if (results) return { state: 'done', job: id, results };
  const spec = readJson<JobSpec>(join(dir, 'job.json'));
  if (!spec) return { state: existsSync(dir) ? 'running' : 'unknown', job: id };
  return { state: alive(spec.workerPid) ? 'running' : 'lost', job: id, spec };
}

/** One line for a status: what a person or a cheap model reads. */
export function statusLine(s: JobStatus): string {
  if (s.state === 'unknown') return `suite ${s.job}: no such job`;
  if (s.state === 'running') return `suite ${s.job}: running`;
  if (s.state === 'lost') return `suite ${s.job}: lost (the worker exited without results; see output.log)`;
  const r = s.results as Results;
  const tsc = r.tsc.skipped ? 'tsc skipped' : `tsc ${r.tsc.exit === 0 ? 'ok' : `exit ${r.tsc.exit}`}`;
  const failing = r.tests.failing.length ? `; failing: ${r.tests.failing.slice(0, 5).join(' | ')}${r.tests.failing.length > 5 ? ` (+${r.tests.failing.length - 5} more)` : ''}` : '';
  return `suite ${s.job}: ${r.pass ? 'PASS' : 'FAIL'} at ${r.head.slice(0, 12)}${r.dirty ? ' (dirty tree)' : ''}; ${tsc}; tests ${r.tests.pass} pass, ${r.tests.fail} fail, ${r.tests.cancelled} cancelled${failing}`;
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  if (cmd === '_worker') { runWorker(rest[0] as string); return 0; }
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { tests: { type: 'string' }, 'skip-tsc': { type: 'boolean' }, json: { type: 'boolean' } } });
  const target = positionals[0];
  if ((cmd !== 'start' && cmd !== 'status') || !target) {
    console.error('usage: suite-run.ts start <worktree> [--tests <glob>] [--skip-tsc] [--json] | status <job> [--json]');
    return EXIT.usage;
  }
  if (cmd === 'start') {
    const spec = startJob(target, { tests: values.tests, skipTsc: values['skip-tsc'] });
    if (values.json) printJson({ job: spec.id, dir: jobDir(spec.id), head: spec.head }); else console.log(`${spec.id}\nresults: ${join(jobDir(spec.id), 'results.json')}`);
    return 0;
  }
  const s = jobStatus(target);
  if (values.json) printJson(s); else console.log(statusLine(s));
  return s.state === 'running' ? EXIT.running : s.state === 'done' && s.results?.pass ? EXIT.passed : s.state === 'unknown' ? EXIT.usage : EXIT.failed;
}

const isMain = (): boolean => { try { return realpathSync(process.argv[1] as string) === fileURLToPath(import.meta.url); } catch { return false; } };

if (process.argv[1] && isMain()) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error((e as Error).message); process.exitCode = EXIT.usage; }
}
