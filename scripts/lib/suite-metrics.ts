/**
 * suite-metrics.ts: turn a test run's machine-readable report into the compact summary a reviewer reads, using the suite's own
 * timing. Pure functions only (no process, no filesystem except the baseline file helpers), so a fixture report tests all of it.
 *
 * Parsers: `parseJunit` (node's `--test-reporter=junit` and pytest's `--junitxml`) and `parseJestJson` (`jest --json`). Each yields
 * TestRecord[]; a new runner adds one parser that returns the same shape and a case in suite-summary.ts, nothing else.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';

export type Status = 'pass' | 'fail' | 'skip' | 'todo';

/** One test: a stable id (file, suites, name), its duration in ms, and the first error lines when it failed. */
export interface TestRecord { id: string; file: string; name: string; ms: number; status: Status; error?: string }

/** The per-test durations of a green run: what a later run is compared with. */
export interface Baseline { version: 1; runner: string; head: string; branch: string; writtenAt: string; tests: Record<string, number> }

export interface SummaryOptions {
  /** How many slowest tests to list. */
  top: number;
  /** How many failures to describe in full. */
  maxFailures: number;
  /** A test is a regression when it runs more than this many times its baseline... */
  factor: number;
  /** ...and is slower by at least this many ms (so 1ms to 3ms is not a finding). */
  minDeltaMs: number;
  /** Any test at or over this many ms is listed as slow, baseline or not. */
  absMs: number;
}

export const DEFAULT_OPTIONS: SummaryOptions = { top: 10, maxFailures: 5, factor: 2, minDeltaMs: 100, absMs: 5000 };

export interface Timed { id: string; ms: number }
export interface Regression extends Timed { baselineMs: number; ratio: number }
export interface Summary {
  counts: { total: number; pass: number; fail: number; skip: number; todo: number };
  /** Sum of every test's own duration; tests run in parallel, so this can exceed the wall time. */
  testMs: number;
  failures: { id: string; file: string; name: string; error: string }[];
  failuresTotal: number;
  slowest: Timed[];
  /** Null when there is no baseline to compare with: no regression section, not an error. */
  regressions: Regression[] | null;
  overThreshold: Timed[];
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Decodes the XML entities node and pytest emit, numeric ones included (a newline is `&#10;`). */
export function unescapeXml(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(lt|gt|amp|quot|apos));/gi, (_m, dec: string, hex: string, name: string) =>
    name ? ENTITIES[name.toLowerCase()] as string : String.fromCodePoint(dec ? Number(dec) : parseInt(hex, 16)));
}

const attrs = (text: string): Record<string, string> => Object.fromEntries([...text.matchAll(/([\w:.-]+)="([^"]*)"/g)].map((m) => [m[1] as string, unescapeXml(m[2] as string)]));

/** The first `n` non-blank lines of an error, each cut to 200 characters. */
export function firstLines(text: string, n = 4): string {
  return text.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() !== '').slice(0, n).map((l) => (l.length > 200 ? `${l.slice(0, 197)}...` : l)).join('\n');
}

const rel = (file: string, root: string): string => (file && root && file.startsWith('/') ? relative(root, file) : file);

/** Makes ids unique when two tests share one: the second becomes `id #2`. */
function uniqueIds(records: TestRecord[]): TestRecord[] {
  const seen = new Map<string, number>();
  return records.map((r) => {
    const n = (seen.get(r.id) ?? 0) + 1;
    seen.set(r.id, n);
    return n === 1 ? r : { ...r, id: `${r.id} #${n}` };
  });
}

/**
 * Records from a JUnit XML report. Node nests `<testsuite>` per `describe` and puts the file on each `<testcase>`, so the id is
 * `file > suites > name`; pytest has `classname` and no file, so the id is `classname::name`. `time` is in seconds.
 * `root` makes absolute file paths relative to the repo.
 */
export function parseJunit(xml: string, root = ''): TestRecord[] {
  const out: TestRecord[] = [];
  const suites: string[] = [];
  let cur: (TestRecord & { _a: Record<string, string> }) | null = null;
  const finish = (): void => {
    if (!cur) return;
    const { _a, ...record } = cur;
    const file = rel(_a.file ?? '', root);
    const path = file ? [file, ...suites] : [_a.classname ?? ''];
    out.push({ ...record, file: file || (_a.classname ?? ''), id: `${path.join(' > ')}${file ? ' > ' : '::'}${_a.name ?? ''}` });
    cur = null;
  };
  // Attribute values are quoted and node leaves a raw `>` inside them (diff output has them), so a quoted run is skipped whole.
  const tag = /<(\/?)(testsuite|testcase|failure|error|skipped)\b((?:[^>"]|"[^"]*")*?)(\/?)>/g;
  for (let m = tag.exec(xml); m; m = tag.exec(xml)) {
    const [, closing, name, rest, selfClosed] = m as unknown as [string, string, string, string, string];
    if (name === 'testsuite') {
      if (closing) suites.pop(); else if (!selfClosed) suites.push(attrs(rest).name ?? '');
    } else if (name === 'testcase') {
      if (closing) { finish(); continue; }
      const a = attrs(rest);
      cur = { id: '', file: '', name: a.name ?? '', ms: Number(a.time ?? 0) * 1000, status: 'pass', _a: a };
      if (selfClosed) finish();
    } else if (cur && !closing) {
      const a = attrs(rest);
      if (name === 'skipped') { cur.status = a.type === 'todo' ? 'todo' : 'skip'; continue; }
      let body = '';
      if (!selfClosed) {
        const end = xml.indexOf(`</${name}>`, tag.lastIndex);
        body = unescapeXml(xml.slice(tag.lastIndex, end < 0 ? undefined : end));
        if (end >= 0) tag.lastIndex = end + name.length + 3;
      }
      cur.status = 'fail';
      cur.error = firstLines(a.message || body) || firstLines(body);
    }
  }
  return uniqueIds(out);
}

interface JestAssertion { ancestorTitles?: string[]; title?: string; fullName?: string; status?: string; duration?: number | null; failureMessages?: string[] }
interface JestFile { name?: string; status?: string; message?: string; assertionResults?: JestAssertion[] }

/** Records from `jest --json`. A test file that failed to run (no assertions, status failed) becomes one failing record named for the file. */
export function parseJestJson(text: string, root = ''): TestRecord[] {
  const report = JSON.parse(text) as { testResults?: JestFile[] };
  const out: TestRecord[] = [];
  for (const f of report.testResults ?? []) {
    const file = rel(f.name ?? '', root);
    const asserted = f.assertionResults ?? [];
    if (asserted.length === 0 && f.status === 'failed') out.push({ id: `${file} > (file failed to run)`, file, name: '(file failed to run)', ms: 0, status: 'fail', error: firstLines(f.message ?? '') });
    for (const a of asserted) {
      const status: Status = a.status === 'passed' ? 'pass' : a.status === 'failed' ? 'fail' : a.status === 'todo' ? 'todo' : 'skip';
      const name = a.title ?? a.fullName ?? '';
      out.push({ id: [file, ...(a.ancestorTitles ?? []), name].join(' > '), file, name, ms: a.duration ?? 0, status, ...(status === 'fail' ? { error: firstLines((a.failureMessages ?? []).join('\n').replace(/\u001b\[[0-9;]*m/g, '')) } : {}) });
    }
  }
  return uniqueIds(out);
}

/** Counts, failures, slowest tests, and (with a baseline) regressions and over-threshold tests. */
export function summarize(records: TestRecord[], baseline: Baseline | null, options: Partial<SummaryOptions> = {}): Summary {
  const o = { ...DEFAULT_OPTIONS, ...options };
  const count = (s: Status): number => records.filter((r) => r.status === s).length;
  const timed: Timed[] = records.filter((r) => r.status === 'pass' || r.status === 'fail').map((r) => ({ id: r.id, ms: r.ms }));
  const failed = records.filter((r) => r.status === 'fail');
  const regressions = baseline === null ? null : timed.flatMap((t): Regression[] => {
    const was = baseline.tests[t.id];
    return was !== undefined && was > 0 && t.ms > o.factor * was && t.ms - was >= o.minDeltaMs ? [{ ...t, baselineMs: was, ratio: t.ms / was }] : [];
  }).sort((a, b) => (b.ms - b.baselineMs) - (a.ms - a.baselineMs));
  return {
    counts: { total: records.length, pass: count('pass'), fail: failed.length, skip: count('skip'), todo: count('todo') },
    testMs: timed.reduce((sum, t) => sum + t.ms, 0),
    failures: failed.slice(0, o.maxFailures).map((r) => ({ id: r.id, file: r.file, name: r.name, error: r.error ?? '' })),
    failuresTotal: failed.length,
    slowest: [...timed].sort((a, b) => b.ms - a.ms).slice(0, o.top),
    regressions,
    overThreshold: timed.filter((t) => t.ms >= o.absMs).sort((a, b) => b.ms - a.ms),
  };
}

/** A baseline from a run's passing tests. */
export function baselineFrom(records: TestRecord[], meta: { runner: string; head: string; branch: string; now?: Date }): Baseline {
  const tests: Record<string, number> = {};
  for (const r of records) if (r.status === 'pass') tests[r.id] = Math.round(r.ms * 100) / 100;
  return { version: 1, runner: meta.runner, head: meta.head, branch: meta.branch, writtenAt: (meta.now ?? new Date()).toISOString(), tests };
}

/** The stored baseline, or null when there is none or it is unreadable: a missing baseline is not an error. */
export function readBaseline(path: string): Baseline | null {
  try {
    const b = JSON.parse(readFileSync(path, 'utf8')) as Baseline;
    return b && b.version === 1 && b.tests && typeof b.tests === 'object' ? b : null;
  } catch { return null; }
}

/** Writes the baseline beside its path and renames it in, so a reader never sees half a file. */
export function writeBaseline(path: string, baseline: Baseline): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(baseline)}\n`);
  renameSync(tmp, path);
}

const secs = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);

/** The summary as the short text a reviewer reads. `baseline` is only used to say which run the regressions were measured against. */
export function formatSummary(s: Summary, baseline: Baseline | null, o: SummaryOptions = DEFAULT_OPTIONS): string {
  const c = s.counts;
  const lines = [`tests: ${c.total} total, ${c.pass} pass, ${c.fail} fail, ${c.skip} skip, ${c.todo} todo; test time ${secs(s.testMs)}`];
  if (s.failuresTotal) {
    lines.push('', `failures (${s.failures.length} of ${s.failuresTotal}):`);
    for (const f of s.failures) lines.push(`  FAIL ${f.id}`, ...f.error.split('\n').map((l) => `       ${l}`));
  }
  lines.push('', `slowest ${s.slowest.length}:`, ...s.slowest.map((t) => `  ${secs(t.ms).padStart(7)}  ${t.id}`));
  if (s.regressions === null) lines.push('', 'regressions: no baseline (write one from a green main run with --write-baseline)');
  else {
    lines.push('', `regressions vs baseline (${baseline ? `${baseline.head.slice(0, 10)}, ${baseline.writtenAt.slice(0, 10)}` : 'unknown'}; over ${o.factor}x and ${o.minDeltaMs}ms): ${s.regressions.length || 'none'}`);
    lines.push(...s.regressions.slice(0, o.top).map((r) => `  ${secs(r.baselineMs)} -> ${secs(r.ms)} (${r.ratio.toFixed(1)}x)  ${r.id}`));
  }
  if (s.overThreshold.length) {
    const listed = new Set(s.slowest.map((t) => t.id));
    const more = s.overThreshold.filter((t) => !listed.has(t.id)).slice(0, o.top);
    lines.push('', `over ${secs(o.absMs)}: ${s.overThreshold.length}${more.length ? ' (the slowest are listed above; also:)' : ' (all listed above)'}`, ...more.map((t) => `  ${secs(t.ms).padStart(7)}  ${t.id}`));
  }
  return lines.join('\n');
}

/** Runs `fn` once and returns its value with the elapsed ms: the building block for a timing probe written as an ordinary test. */
export function timeProbe<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

/** Throws when `fn` takes longer than `limitMs`, naming the measured time; returns the value otherwise. */
export function assertWithin<T>(limitMs: number, fn: () => T, label = 'probe'): T {
  const { value, ms } = timeProbe(fn);
  if (ms > limitMs) throw new Error(`${label}: took ${ms.toFixed(1)}ms, limit ${limitMs}ms`);
  return value;
}
