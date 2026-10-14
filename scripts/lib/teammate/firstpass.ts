/**
 * The scripted first pass and the scripted dependency install for a prepared review worktree, so the reviewing agent starts from facts instead of
 * rediscovering them: the PR body, what bots already said, the CI rollup, the changed files with the test command of the package each belongs to,
 * and a worktree with dependencies installed when the PR needs them run. Nothing here writes to GitHub; `gh` is only asked to `pr view`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Runner } from './worktree.ts';

export interface Pkg { dir: string; test: string | null; files: number }
export interface FirstPass {
  title: string; body: string;
  botFindings: { author: string; where: string; text: string }[];
  ci: { total: number; failing: string[]; pending: number };
  changed: string[]; packages: Pkg[];
}

const clip = (s: unknown, n: number): string => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : '');
export const isBot = (login: string): boolean => /\[bot\]$/i.test(login) || login.toLowerCase() === 'copilot-pull-request-reviewer';

/** The nearest package.json at or above `file` inside `root`: its directory (relative, '.' for root) and its test script. */
export function packageOf(root: string, file: string): { dir: string; test: string | null } | null {
  let dir = dirname(file);
  for (;;) {
    const pj = join(root, dir, 'package.json');
    if (existsSync(pj)) {
      try { const t = (JSON.parse(readFileSync(pj, 'utf8')) as { scripts?: { test?: unknown } }).scripts?.test; return { dir, test: typeof t === 'string' ? t : null }; } catch { return { dir, test: null }; }
    }
    if (dir === '.' || dir === '/' || dir === '') return null;
    dir = dirname(dir);
  }
}

/** Reads the PR through `gh pr view` and the worktree's package.json files. Throws when gh cannot read the PR. */
export function firstPass(o: { repo: string; pr: number; path: string; run: Runner }): FirstPass {
  const r = o.run('gh', ['pr', 'view', String(o.pr), '--repo', o.repo, '--json', 'title,body,files,comments,reviews,statusCheckRollup']);
  if (r.status !== 0) throw new Error(`gh pr view failed: ${r.stderr.split('\n')[0]?.slice(0, 200)}`);
  const v = JSON.parse(r.stdout) as {
    title?: string; body?: string; files?: { path?: string }[];
    comments?: { author?: { login?: string }; body?: string }[]; reviews?: { author?: { login?: string }; body?: string; state?: string }[];
    statusCheckRollup?: { name?: string; context?: string; conclusion?: string; state?: string; status?: string }[];
  };
  const botFindings = [
    ...(v.comments ?? []).map((c) => ({ author: c.author?.login ?? '', where: 'comment', text: clip(c.body, 400) })),
    ...(v.reviews ?? []).map((c) => ({ author: c.author?.login ?? '', where: `review ${c.state ?? ''}`.trim(), text: clip(c.body, 400) })),
  ].filter((f) => isBot(f.author) && f.text).slice(0, 12);
  const checks = v.statusCheckRollup ?? [];
  const failing = checks.filter((c) => /FAIL|ERROR|TIMED_OUT|CANCELLED/i.test(`${c.conclusion ?? ''} ${c.state ?? ''}`)).map((c) => c.name ?? c.context ?? '?');
  const pending = checks.filter((c) => c.status && c.status !== 'COMPLETED' || /PENDING/i.test(c.state ?? '')).length;
  const changed = (v.files ?? []).map((f) => f.path ?? '').filter(Boolean);
  const byDir = new Map<string, Pkg>();
  for (const f of changed) {
    const p = packageOf(resolve(o.path), f);
    if (!p) continue;
    const cur = byDir.get(p.dir) ?? { dir: p.dir, test: p.test, files: 0 };
    cur.files += 1;
    byDir.set(p.dir, cur);
  }
  return { title: clip(v.title, 200), body: clip(v.body, 3000), botFindings, ci: { total: checks.length, failing, pending }, changed: changed.slice(0, 200), packages: [...byDir.values()] };
}

/** What `installDeps` asks of the system: run a command with an environment in a directory. */
export type Exec = (cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => { status: number | null; stdout: string; stderr: string };

/**
 * `npm ci` in the package directory of each changed package that has a lockfile, with browser downloads skipped and, when the container folder has an
 * `.npmrc`, that file named as the user config (its contents are never read here). Then `git status`: npm can flip file mode bits on tracked files,
 * and the caller must see that before the worktree is removed.
 */
export function installDeps(o: { path: string; packages: readonly Pkg[]; containerRoot: string; exec: Exec; env?: NodeJS.ProcessEnv }): { installed: string[]; skipped: string[]; failed: { dir: string; error: string }[]; dirty: string[] } {
  const npmrc = join(resolve(o.containerRoot), '.npmrc');
  const env: NodeJS.ProcessEnv = { ...(o.env ?? process.env), PUPPETEER_SKIP_DOWNLOAD: '1', ...(existsSync(npmrc) && !(o.env ?? process.env).NPM_CONFIG_USERCONFIG ? { NPM_CONFIG_USERCONFIG: npmrc } : {}) };
  const installed: string[] = []; const skipped: string[] = []; const failed: { dir: string; error: string }[] = [];
  for (const p of o.packages) {
    const dir = resolve(o.path, p.dir);
    if (dir !== resolve(o.path) && !dir.startsWith(`${resolve(o.path)}/`)) { skipped.push(p.dir); continue; }
    if (!existsSync(join(dir, 'package-lock.json'))) { skipped.push(p.dir); continue; }
    const r = o.exec('npm', ['ci', '--no-audit', '--no-fund'], dir, env);
    if (r.status === 0) installed.push(p.dir); else failed.push({ dir: p.dir, error: (r.stderr || r.stdout).split('\n').find((l) => l.trim())?.slice(0, 200) ?? 'npm ci failed' });
  }
  const st = o.exec('git', ['status', '--porcelain'], o.path, env);
  return { installed, skipped, failed, dirty: st.stdout.split('\n').filter(Boolean).slice(0, 50) };
}
