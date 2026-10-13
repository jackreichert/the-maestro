#!/usr/bin/env node
/**
 * FIXTURE NAMES: refuse a commit whose staged test or fixture file adds a configured private
 * org/repo token. The token list is the same `private-patterns.txt` the pre-push hook greps
 * (`grep -qiE -f` on added lines). That hook runs only at push, so a bad fixture can already
 * be a commit. `scripts/lib/secret-scan.ts` looks for credential and PHI shapes, not this list,
 * and nothing on the commit path calls either check.
 *
 *   node scripts/fixture-names.ts [--repo <path>] [--patterns <file>]
 *
 * `--patterns` overrides the list (tests pass a stub). Otherwise `MAESTRO_PRIVATE_PATTERNS`,
 * otherwise `<hooks>/private-patterns.txt` from `git rev-parse --git-path hooks` (the directory
 * the pre-push hook lives in). A missing, empty or unreadable list exits non-zero: the check
 * fails closed. A hit prints the staged path and the label `private-name`, never the match.
 *
 * Exit 0 when no staged test or fixture adds a configured name, 1 when one does or the list
 * or the staged diff cannot be used, 2 on bad usage.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIST_UNREADABLE = 'fixture-names: configured name list cannot be read';
const LIST_UNUSABLE = 'fixture-names: configured name list cannot be applied';
const DIFF_UNREADABLE = 'fixture-names: staged diff cannot be read';
const LABEL = 'private-name';

const TEST_DIRS = new Set(['test', 'tests', '__tests__', '__mocks__', 'e2e']);
const FIXTURE_DIRS = new Set(['fixture', 'fixtures', '__fixtures__']);

/** A staged path this check reads: a test, or a fixture file. Not every path that contains the letters. */
export function isTestOrFixture(file: string): boolean {
  const path = file.replaceAll('\\', '/');
  const parts = path.split('/');
  if (parts.some((p) => TEST_DIRS.has(p) || FIXTURE_DIRS.has(p))) return true;
  const base = parts[parts.length - 1] ?? path;
  return /\.(?:test|spec)\.[^/]+$/.test(base)
    || /_test\.[^/]+$/.test(base)
    || /\.cases\.[cm]?[jt]s$/.test(base)
    || base === 'conftest.py'
    || /\.fixtures?\./i.test(base)
    || /^fixtures?\./i.test(base)
    || /\.fixtures?$/i.test(base);
}

export interface Hit { path: string; label: typeof LABEL }
export type Scan =
  | { status: 'pass' }
  | { status: 'refuse'; hits: Hit[] }
  | { status: 'closed'; message: string };

/** Non-empty lines of the pattern file, or undefined when it cannot be read or has none. Blank lines are dropped: `grep -f` treats one as a pattern that matches every line. */
export function loadPatterns(file: string): string[] | undefined {
  try {
    if (!statSync(file).isFile()) return undefined;
    const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.length > 0);
    return lines.length ? lines : undefined;
  } catch {
    return undefined;
  }
}

/** The pattern file beside the hooks the repo actually runs, or undefined when that path cannot be resolved. */
export function defaultPatternsFile(repo: string): string | undefined {
  const r = git(repo, 'rev-parse', '--git-path', 'hooks');
  if (r.status !== 0) return undefined;
  const hooks = r.stdout.trim();
  if (!hooks) return undefined;
  return isAbsolute(hooks) ? join(hooks, 'private-patterns.txt') : join(repo, hooks, 'private-patterns.txt');
}

/**
 * Added lines of staged test and fixture files, scanned with the same `grep -iE` the pre-push
 * hook uses. A source file is ignored. Context lines and deletions are ignored.
 */
export function scanStaged(repo: string, patternsFile: string): Scan {
  const patterns = loadPatterns(patternsFile);
  if (!patterns) return { status: 'closed', message: LIST_UNREADABLE };
  const names = git(repo, 'diff', '--cached', '-z', '--name-only', '--diff-filter=ACMRT');
  if (names.status !== 0) return { status: 'closed', message: DIFF_UNREADABLE };
  const hits: Hit[] = [];
  for (const path of names.stdout.split('\0').filter((p) => p && isTestOrFixture(p))) {
    const diff = git(repo, 'diff', '--cached', '-U0', '--', path);
    if (diff.status !== 0) return { status: 'closed', message: DIFF_UNREADABLE };
    const added = diff.stdout.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)).join('\n');
    const found = grepPatterns(patterns, added);
    if (found === 'error') return { status: 'closed', message: LIST_UNUSABLE };
    if (found === 'yes') hits.push({ path, label: LABEL });
  }
  return hits.length ? { status: 'refuse', hits } : { status: 'pass' };
}

function grepPatterns(patterns: string[], text: string): 'yes' | 'no' | 'error' {
  if (!text) return 'no';
  const r = spawnSync('grep', ['-qiE', ...patterns.flatMap((p) => ['-e', p])], { input: text, encoding: 'utf8' });
  if (r.error || r.status === null || r.status === 2) return 'error';
  return r.status === 0 ? 'yes' : 'no';
}

function git(repo: string, ...args: string[]): { status: number | null; stdout: string } {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '' };
}

function patternsFile(repo: string, flag: string | undefined): string | undefined {
  if (flag !== undefined) return flag;
  if (process.env.MAESTRO_PRIVATE_PATTERNS !== undefined) return process.env.MAESTRO_PRIVATE_PATTERNS;
  return defaultPatternsFile(repo);
}

function main(argv: string[]): number {
  let repo = process.cwd();
  let flag: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      console.log('node scripts/fixture-names.ts [--repo <path>] [--patterns <file>]');
      return 0;
    }
    if (a === '--repo' || a === '--patterns') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) {
        console.error(`fixture-names: ${a} needs a path`);
        return 2;
      }
      if (a === '--repo') repo = v;
      else flag = v;
      continue;
    }
    console.error('fixture-names: unknown argument');
    return 2;
  }
  const file = patternsFile(repo, flag);
  const scan = file ? scanStaged(repo, file) : { status: 'closed' as const, message: LIST_UNREADABLE };
  if (scan.status === 'closed') {
    console.error(scan.message);
    return 1;
  }
  if (scan.status === 'refuse') {
    for (const hit of scan.hits) console.error(`fixture-names: ${hit.path}: ${hit.label}`);
    return 1;
  }
  return 0;
}

const isMain = (): boolean => { try { return realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url); } catch { return false; } };
if (isMain()) process.exitCode = main(process.argv.slice(2));
