/**
 * Staleness of library pages: a page is stale when a file its facts cite as evidence changed in git after the page was verified.
 * Evidence is read from the facts themselves (`(verified YYYY-MM-DD, <evidence>)`), so no new field is needed. Pure apart from the
 * injected `Git`; library-check.ts passes the real one and tests pass a fake.
 *
 * Three outcomes per page: `stale` (a cited file changed since `verified-at`), `fresh` (every cited file was looked at and none changed),
 * `unchecked` (nothing could be looked at: no evidence file, no repo checkout, or no `verified-at` date). `unchecked` is reported, never
 * counted as fresh, so a page cannot read as current because the check could not run.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { LibraryPage } from './pages.ts';

/** Asks git for the commits that touched `files` after `since` in the checkout at `cwd`; `since` is a sha (range `sha..HEAD`) or a date. Returns changed file names, or null when git could not answer. */
export type Git = (cwd: string, since: { sha: string } | { date: string }, files: string[]) => string[] | null;

export interface PageStaleness {
  path: string;
  state: 'stale' | 'fresh' | 'unchecked';
  /** Why a page is `unchecked`, or the evidence files that changed for a `stale` one. */
  detail: string;
}

const FACT_EVIDENCE = /\(verified \d{4}-\d{2}-\d{2}, ([^)]*)\)/;
const PATHISH = /(?:~\/|\/|\.\/)?[\w.@+-]+(?:\/[\w.@+-]+)*\.[A-Za-z0-9]{1,8}(?=:\d|[\s,;.)]|$)/g;

/** The file paths cited as evidence in a page's Facts section, without line suffixes, in first-seen order. */
export function evidencePaths(page: Pick<LibraryPage, 'body'>): string[] {
  const out = new Set<string>();
  let inFacts = false;
  for (const line of page.body.split('\n')) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) { inFacts = (h[1] as string).toLowerCase() === 'facts'; continue; }
    if (!inFacts) continue;
    const ev = line.match(FACT_EVIDENCE)?.[1];
    if (!ev) continue;
    for (const m of ev.matchAll(PATHISH)) {
      const p = m[0].replace(/[.,;]+$/, '');
      if (p.includes('/') || /\.(ts|tsx|js|mjs|py|sh|tf|sql|ya?ml|json|md)$/i.test(p)) out.add(p);
    }
  }
  return [...out];
}

/** Where a repo's checkout lives under the code root: `<root>/<repo>`, else `<root>/skills/<repo>`; null when neither is a directory. */
export function repoDir(codeRoot: string, repo: string): string | null {
  for (const d of [join(codeRoot, repo), join(codeRoot, 'skills', repo)]) {
    try { if (statSync(d).isDirectory()) return d; } catch { /* next */ }
  }
  return null;
}

/** The sha or date a page was verified at: `YYYY-MM-DD@sha` gives the sha, a bare date the end of that day (a same-day edit is not counted). */
export function sinceOf(verifiedAtRaw: string): { sha: string } | { date: string } | null {
  const m = verifiedAtRaw.match(/^(\d{4}-\d{2}-\d{2})(?:@([0-9a-f]{7,40}))?$/);
  if (!m) return null;
  return m[2] ? { sha: m[2] } : { date: `${m[1]}T23:59:59` };
}

/** Whether each page's cited evidence changed since it was verified (its `verified-at` field, date plus any `@sha`). */
export function checkStaleness(pages: LibraryPage[], codeRoot: string | null, git: Git): PageStaleness[] {
  return pages.map((page): PageStaleness => {
    const unchecked = (detail: string): PageStaleness => ({ path: page.path, state: 'unchecked', detail });
    const since = sinceOf(page.verifiedRaw);
    if (!since) return unchecked('no usable verified-at date');
    const cited = evidencePaths(page);
    if (!cited.length) return unchecked('no evidence file path in the facts');
    if (!codeRoot) return unchecked('no code root (set MAESTRO_CONTAINER_ROOT or pass --code-root)');
    const cwd = repoDir(codeRoot, page.repo);
    const resolved = cited.map((c) => (c.startsWith('~/') ? join(homedir(), c.slice(2)) : isAbsolute(c) ? c : cwd ? resolve(cwd, c) : '')).filter((f) => f && existsSync(f));
    if (!resolved.length) return unchecked(cwd ? 'no cited evidence file exists in the checkout' : `no checkout of ${page.repo} under the code root`);
    const changed: string[] = [];
    let looked = 0;
    for (const f of resolved) {
      const root = f.startsWith(`${cwd ?? '\0'}/`) ? (cwd as string) : join(f, '..');
      const hit = git(root, since, [f]);
      if (hit === null) continue;
      looked += 1;
      if (hit.length) changed.push(f);
    }
    if (changed.length) return { path: page.path, state: 'stale', detail: `changed since ${'sha' in since ? since.sha : (since.date.slice(0, 10))}: ${changed.map((f) => (cwd && f.startsWith(`${cwd}/`) ? f.slice(cwd.length + 1) : f)).join(', ')}` };
    return looked ? { path: page.path, state: 'fresh', detail: '' } : unchecked('git could not answer for any cited file (not a checkout, or an unknown sha)');
  });
}

/** The real `Git`: null for a file git does not track (or a cwd that is not a checkout, or an unknown sha), else the files with a commit after `since`. */
export const realGit: Git = (cwd, since, files) => {
  const run = (args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    return files.filter((f) => {
      run(['ls-files', '--error-unmatch', '--', f]);
      return run(['log', '--format=%h', ...('sha' in since ? [`${since.sha}..HEAD`] : [`--after=${since.date}`]), '--', f]).trim() !== '';
    });
  } catch { return null; }
};
