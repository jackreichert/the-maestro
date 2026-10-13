#!/usr/bin/env node
/**
 * suite-summary.ts: run a repo's test suite (and optionally its type check and the CI gates) in the foreground and print one compact
 * summary, so an Opus agent reads a result instead of running the suite itself.
 *
 *   suite-summary.ts [--repo <path>] [--runner node|jest|pytest] [--typecheck] [--gates --base <ref> --body-file <path> (--title <text> | --title-file <path>)]
 *                    [--json] [--write-baseline] [--top <n>] [--max-failures <n>] [--slow-factor <x>] [--slow-ms <ms>] [--min-delta-ms <ms>]
 *                    [--tests <glob>] [--cmd "<command with {out}>"] [--concurrency <n>] [--timeout-min <n>] [--baseline-name <name>]
 *
 * The suite runs with a machine-readable reporter (node `--test-reporter=junit`, `jest --json`, pytest `--junitxml`), which carries each
 * test's own duration. The summary: counts, the first failures with their first error lines, wall time, the slowest tests, and tests more
 * than 2x slower than the stored baseline or over an absolute threshold. The baseline is a per-test duration file written by
 * `--write-baseline` from a green run (use main); it lives in <suites dir>/baselines (MAESTRO_SUITE_DIR, else <event dir>/suites), keyed by
 * repo name and runner, never in the repo. No baseline means no regression section, not an error.
 *
 * `node` runs `node --test <glob>` in the same scrubbed environment as suite-run.ts (temporary home, event, status and suite dirs, no
 * notify command). `--cmd` replaces the runner's command; `{out}` is replaced by the report path.
 * Exit 0 green, 1 a test, the type check or a gate failed, 2 the runner itself failed (no report, a crash, a timeout, bad usage).
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { printJson } from './lib/json-out.ts';
import { withhold } from './lib/withhold.ts';
import { DEFAULT_OPTIONS, baselineFrom, formatSummary, parseJestJson, parseJunit, readBaseline, summarize, writeBaseline } from './lib/suite-metrics.ts';
import type { Baseline, Summary, SummaryOptions, TestRecord } from './lib/suite-metrics.ts';
import { suiteEnv, suitesDir } from './suite-run.ts';

export const EXIT = { green: 0, failed: 1, runner: 2 };
export type Runner = 'node' | 'jest' | 'pytest';
const RUNNERS: Runner[] = ['node', 'jest', 'pytest'];
const DEFAULT_TIMEOUT_MIN = 30;

/** One non-test step (type check, gates): ok, exit code, duration, and the last lines of its output when it failed. */
export interface Step { name: string; ok: boolean; exit: number | null; ms: number; tail: string[] }

export interface RunResult { exit: number | null; ms: number; log: string; timedOut: boolean }

/** Where a repo's baseline lives: <suites dir>/baselines/<repo>-<runner>.json. Worktrees share the main checkout's name. */
export function baselinePath(repo: string, runner: Runner, name?: string, env: NodeJS.ProcessEnv = process.env): string {
  const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repo, encoding: 'utf8' }).stdout?.trim() ?? '';
  const repoName = name || (common.endsWith('/.git') ? basename(dirname(common)) : basename(repo));
  return join(suitesDir(env), 'baselines', `${repoName.replace(/[^\w.-]/g, '_')}-${runner}.json`);
}

/** The command that produces a report at `out`, as [file, args]. `--cmd` wins; jest and pytest use the repo's own toolchain on PATH. */
export function runnerCommand(runner: Runner, out: string, o: { tests?: string; cmd?: string; concurrency?: number }): [string, string[]] {
  if (o.cmd) return ['/bin/sh', ['-c', o.cmd.replaceAll('{out}', out)]];
  if (runner === 'jest') return ['npx', ['jest', '--json', `--outputFile=${out}`]];
  if (runner === 'pytest') return ['python3', ['-m', 'pytest', '-q', `--junitxml=${out}`]];
  const conc = o.concurrency ? [`--test-concurrency=${o.concurrency}`] : [];
  return [process.execPath, ['--test', ...conc, '--test-reporter=junit', `--test-reporter-destination=${out}`, o.tests || 'scripts/**/*.test.ts']];
}

/** Runs a command in its own process group (killed whole on timeout) with output to `log`. */
export function runCommand(file: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; log: string; timeoutMs: number }): Promise<RunResult> {
  const start = Date.now();
  const fd = openSync(opts.log, 'w');
  return new Promise((done) => {
    let timedOut = false;
    const child = spawn(file, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ['ignore', fd, fd] });
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-(child.pid as number), 'SIGKILL'); } catch { /* already gone */ } }, opts.timeoutMs);
    let settled = false;
    // A failed spawn emits `error` and then `close`; settling once keeps the second from closing the fd again.
    const end = (exit: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      closeSync(fd);
      done({ exit, ms: Date.now() - start, log: opts.log, timedOut });
    };
    // Killing this script must not orphan the suite: stop its process group, then exit as a runner error.
    const onSignal = (): void => { try { process.kill(-(child.pid as number), 'SIGKILL'); } catch { /* already gone */ } process.exit(EXIT.runner); };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    child.once('error', () => end(127));
    child.once('close', (code) => end(code ?? 1));
  });
}

const tail = (log: string, n = 12): string[] => { try { return readFileSync(log, 'utf8').split('\n').filter((l) => l.trim()).slice(-n); } catch { return []; } };

async function runStep(name: string, file: string, args: string[], cwd: string, dir: string, timeoutMs: number): Promise<Step> {
  const r = await runCommand(file, args, { cwd, env: process.env, log: join(dir, `${name}.log`), timeoutMs });
  return { name, ok: r.exit === 0, exit: r.exit, ms: r.ms, tail: r.exit === 0 ? [] : tail(r.log) };
}

const hasTypecheck = (repo: string): boolean => {
  try { return typeof (JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { scripts?: { typecheck?: unknown } }).scripts?.typecheck === 'string'; } catch { return false; }
};

/** The records in a finished run's report, or null with the reason when there is no usable report. */
export function readReport(runner: Runner, out: string, repo: string): { records: TestRecord[] } | { error: string } {
  if (!existsSync(out)) return { error: 'the runner wrote no report' };
  try {
    const text = readFileSync(out, 'utf8');
    const records = runner === 'jest' ? parseJestJson(text, repo) : parseJunit(text, repo);
    return records.length ? { records } : { error: 'the report holds no tests (a glob that matched nothing counts as a failure)' };
  } catch (e) { return { error: `the report did not parse: ${(e as Error).message}` }; }
}

export interface Output {
  ok: boolean;
  exit: number;
  runner: Runner;
  repo: string;
  head: string;
  dirty: boolean;
  wallMs: number;
  steps: Step[];
  summary: Summary | null;
  baseline: { path: string; present: boolean; written: boolean; note?: string };
  error?: string;
}

/** The text a reviewer reads. */
export function formatOutput(out: Output, baseline: Baseline | null, o: SummaryOptions): string {
  const head = `suite-summary: ${out.runner} in ${basename(out.repo)} at ${out.head.slice(0, 10)}${out.dirty ? ' (dirty tree)' : ''}: ${out.error ? 'RUNNER ERROR' : out.ok ? 'PASS' : 'FAIL'}; wall ${(out.wallMs / 1000).toFixed(1)}s`;
  const lines = [head];
  if (out.error) lines.push(`error: ${out.error}`);
  for (const s of out.steps) lines.push(`${s.name}: ${s.ok ? 'ok' : `FAILED (exit ${s.exit})`} (${(s.ms / 1000).toFixed(1)}s)`, ...s.tail.map((l) => `  | ${l}`));
  if (out.summary) lines.push('', formatSummary(out.summary, baseline, o));
  lines.push('', `baseline: ${out.baseline.written ? `written to ${out.baseline.path}` : out.baseline.present ? `read from ${out.baseline.path}` : 'none'}${out.baseline.note ? ` (${out.baseline.note})` : ''}`);
  return lines.join('\n');
}

const git = (cwd: string, args: string[]): string => (spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout ?? '').trim();

interface Cli {
  repo: string; runner: Runner; typecheck: boolean; gates: boolean; json: boolean; writeBaseline: boolean; options: SummaryOptions;
  tests?: string; cmd?: string; concurrency?: number; timeoutMin: number; baselineName?: string; gateArgs: string[];
}

/** Parses argv; throws a usage message for a bad flag or value. */
export function parseCli(argv: string[]): Cli {
  const { values: v } = parseArgs({ args: argv, options: {
    repo: { type: 'string' }, runner: { type: 'string' }, typecheck: { type: 'boolean' }, gates: { type: 'boolean' }, json: { type: 'boolean' }, 'write-baseline': { type: 'boolean' },
    top: { type: 'string' }, 'max-failures': { type: 'string' }, 'slow-factor': { type: 'string' }, 'slow-ms': { type: 'string' }, 'min-delta-ms': { type: 'string' },
    tests: { type: 'string' }, cmd: { type: 'string' }, concurrency: { type: 'string' }, 'timeout-min': { type: 'string' }, 'baseline-name': { type: 'string' },
    base: { type: 'string' }, 'body-file': { type: 'string' }, title: { type: 'string' }, 'title-file': { type: 'string' }, head: { type: 'string' }, 'base-name': { type: 'string' },
  } });
  const num = (name: string, fallback: number): number => {
    const raw = v[name as keyof typeof v] as string | undefined;
    if (raw === undefined) return fallback;
    if (!(Number(raw) > 0)) throw new Error(`--${name} needs a positive number, got "${raw}"`);
    return Number(raw);
  };
  const runner = (v.runner ?? 'node') as Runner;
  if (!RUNNERS.includes(runner)) throw new Error(`--runner must be one of ${RUNNERS.join(', ')}, got "${v.runner}"`);
  const gateArgs = (['base', 'body-file', 'title', 'title-file', 'head', 'base-name'] as const).flatMap((k) => (v[k] === undefined ? [] : [`--${k}`, v[k] as string]));
  if (v.gates && !(v.base && v['body-file'] && (v.title || v['title-file']))) throw new Error('--gates needs --base, --body-file and --title or --title-file (passed on to ci-gates.ts)');
  const options: SummaryOptions = { top: num('top', DEFAULT_OPTIONS.top), maxFailures: num('max-failures', DEFAULT_OPTIONS.maxFailures), factor: num('slow-factor', DEFAULT_OPTIONS.factor), minDeltaMs: num('min-delta-ms', DEFAULT_OPTIONS.minDeltaMs), absMs: num('slow-ms', DEFAULT_OPTIONS.absMs) };
  return { repo: realpathSync(resolve(v.repo ?? process.cwd())), runner, typecheck: Boolean(v.typecheck), gates: Boolean(v.gates), json: Boolean(v.json), writeBaseline: Boolean(v['write-baseline']), options,
    tests: v.tests, cmd: v.cmd, concurrency: v.concurrency ? num('concurrency', 1) : undefined, timeoutMin: num('timeout-min', DEFAULT_TIMEOUT_MIN), baselineName: v['baseline-name'], gateArgs };
}

/** Runs everything the flags ask for and returns the output plus the baseline it was compared with. */
export async function run(cli: Cli): Promise<{ out: Output; baseline: Baseline | null }> {
  const start = Date.now();
  const work = mkdtempSync(join(tmpdir(), 'suite-summary-'));
  const timeoutMs = cli.timeoutMin * 60_000;
  const bpath = baselinePath(cli.repo, cli.runner, cli.baselineName);
  const baseline = readBaseline(bpath);
  const out: Output = { ok: false, exit: EXIT.runner, runner: cli.runner, repo: cli.repo, head: git(cli.repo, ['rev-parse', 'HEAD']), dirty: git(cli.repo, ['status', '--porcelain']) !== '', wallMs: 0, steps: [], summary: null, baseline: { path: bpath, present: baseline !== null, written: false } };
  try {
    if (cli.typecheck && hasTypecheck(cli.repo)) out.steps.push(await runStep('typecheck', 'npm', ['run', 'typecheck'], cli.repo, work, timeoutMs));
    if (cli.gates) {
      const gates = join(dirname(fileURLToPath(import.meta.url)), 'ci-gates.ts');
      const step = await runStep('gates', process.execPath, [gates, '--repo', cli.repo, ...cli.gateArgs], cli.repo, work, timeoutMs);
      out.steps.push(step);
      if (step.exit === 2) { out.error = `ci-gates.ts could not run: ${step.tail.join(' ')}`; return { out, baseline }; }
    }
    const report = join(work, 'report');
    const home = mkdtempSync(join(work, 'home-'));
    const env = cli.runner === 'node' && !cli.cmd ? suiteEnv(home) : process.env;
    if (cli.runner === 'node' && !cli.cmd) for (const k of ['MAESTRO_EVENT_DIR', 'MAESTRO_SUITE_DIR', 'MAESTRO_STATUS_DIR']) mkdirSync(env[k] as string, { recursive: true });
    const [file, args] = runnerCommand(cli.runner, report, cli);
    const r = await runCommand(file, args, { cwd: cli.repo, env, log: join(work, 'runner.log'), timeoutMs });
    const parsed = readReport(cli.runner, report, cli.repo);
    if (r.timedOut) out.error = `the runner timed out after ${cli.timeoutMin} minutes and was killed`;
    else if ('error' in parsed) out.error = `${parsed.error}; runner exit ${r.exit}; last output: ${tail(r.log, 5).join(' | ')}`;
    if ('error' in parsed || r.timedOut) return { out, baseline };
    out.summary = summarize(parsed.records, baseline, cli.options);
    // A non-zero exit with no failing test is the runner breaking (a crash, a bad flag), not the suite failing.
    if (r.exit !== 0 && out.summary.counts.fail === 0) { out.error = `the runner exited ${r.exit} with no failing test; last output: ${tail(r.log, 5).join(' | ')}`; return { out, baseline }; }
    out.ok = out.summary.counts.fail === 0 && r.exit === 0 && out.steps.every((s) => s.ok);
    out.exit = out.ok ? EXIT.green : EXIT.failed;
    if (cli.writeBaseline) {
      if (!out.ok) out.baseline.note = 'not written: the run is not green';
      else {
        writeBaseline(bpath, baselineFrom(parsed.records, { runner: cli.runner, head: out.head, branch: git(cli.repo, ['rev-parse', '--abbrev-ref', 'HEAD']) }));
        out.baseline.written = true;
        out.baseline.present = true;
        out.baseline.note = out.dirty ? 'dirty tree' : undefined;
      }
    }
    return { out, baseline };
  } finally {
    out.wallMs = Date.now() - start;
    rmSync(work, { recursive: true, force: true });
  }
}

const isMain = (): boolean => { try { return realpathSync(process.argv[1] as string) === fileURLToPath(import.meta.url); } catch { return false; } };

if (process.argv[1] && isMain()) {
  let cli: Cli;
  try { cli = parseCli(process.argv.slice(2)); } catch (e) { console.error(`suite-summary: ${(e as Error).message}`); process.exit(EXIT.runner); }
  run(cli).then(({ out, baseline }) => {
    if (cli.json) printJson({ ...out, regressionsBaseline: baseline ? { head: baseline.head, writtenAt: baseline.writtenAt } : null });
    else console.log(withhold(formatOutput(out, baseline, cli.options)));
    process.exitCode = out.exit;
  }, (e: unknown) => { console.error(`suite-summary: ${(e as Error).message}`); process.exitCode = EXIT.runner; });
}
