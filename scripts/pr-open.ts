#!/usr/bin/env node
/**
 * PR OPEN: the only way agents and the orchestrator open a PR. Checks the body, runs the pr-size gate, then
 * `gh pr create --draft --assignee @me`, so the size budget and the reviewer guide are enforced, not just described.
 *
 *   node scripts/pr-open.ts --repo <path> --base <branch> --title <t> --body-file <f> [--head <branch>] [--dry-run]
 *
 * The body file is required and must pass the body rules in pr-body.ts (the sections in pr_body_sections with
 * real content, a Risk line, a fenced verify command, a diagram when stacked or wide, no forbidden content);
 * otherwise exit 1 and gh is never called.
 * File tokens: `{{file:<path>}}` in the body become links to that file in the PR's Files changed tab once the PR
 * exists (pr-links.ts); a path outside the diff refuses before anything is created.
 *
 * Over budget (or code mixed with mechanical files): prints the pr-size summary and a split hint, exits 1,
 * never calls gh. Within budget: runs gh in <path>. --draft and --assignee @me are always added and cannot
 * be turned off; no other gh flag passes through. --dry-run prints the gh command instead of running it.
 * Exit 0 opened (or dry run), 1 refused by the gate, 2 bad usage or a git/gh error.
 * The gh binary is `gh`, or the path in MAESTRO_GH_BIN (tests use a fake).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bodyProblems, type BodyContext } from './pr-body.ts';
import { PROTECTED_BRANCHES } from './local-config.ts';
import { globToRegExp, resolveBase } from './pr-size.ts';
import { linkPr, tokenPaths } from './pr-links.ts';

const PR_SIZE = fileURLToPath(new URL('./pr-size.ts', import.meta.url));
/** Parsed command line: `pass` holds the gh flags and values forwarded as given. */
export interface OpenArgs { repo: string; base: string; dryRun: boolean; pass: string[] }

const PASSTHROUGH: Record<string, string> = { '--title': '--title', '--body-file': '--body-file', '--head': '--head' };

function usage(msg?: string): never {
  if (msg) console.error(`pr-open: ${msg}`);
  console.error('usage: node scripts/pr-open.ts --repo <path> --base <branch> --title <t> --body-file <f> [--head <branch>] [--dry-run]');
  process.exit(2);
}

export function parseArgs(argv: string[]): OpenArgs {
  const o: OpenArgs = { repo: '', base: '', dryRun: false, pass: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--repo' || a === '--base') o[a === '--repo' ? 'repo' : 'base'] = argv[++i] ?? '';
    else if (Object.hasOwn(PASSTHROUGH, a)) {
      if (flagIndex(o.pass, a) >= 0) usage(`${a} given more than once`);
      o.pass.push(PASSTHROUGH[a], argv[++i] ?? '');
    }
    else usage(`unknown argument ${a} (draft and assignee are always set; use --repo, --base, --title, --body-file, --head, --dry-run)`);
  }
  if (!o.repo || !o.base) usage('--repo and --base are required');
  return o;
}

/** The gh argv: draft and assignee first, so they can never be dropped. */
export const ghArgs = ({ base, pass }: Pick<OpenArgs, 'base' | 'pass'>): string[] => ['pr', 'create', '--draft', '--assignee', '@me', '--base', base, ...pass];

/** Read and check the --body-file; the gh argument is rewritten to the absolute path that was checked. */
function checkBody(o: OpenArgs): string {
  const i = flagIndex(o.pass, '--body-file');
  if (i < 0 || !o.pass[i + 1]) {
    console.error('pr-open: refused, --body-file is required. The body needs the sections in pr_body_sections, by default Context, Reviewer guide, Risk and blast radius, Rollback / flag and How to verify locally (see reference/git.md#pr-body).');
    process.exit(1);
  }
  const path = resolve(o.pass[i + 1]);
  let body: string;
  try { body = readFileSync(path, 'utf8'); } catch (e) { console.error(`pr-open: cannot read --body-file ${path}: ${(e as Error).message}`); process.exit(2); }
  const problems = bodyProblems(body, undefined, diffContext(o));
  if (problems.length) {
    console.error(`pr-open: refused, the PR body ${problems.join('; ')}. Fix the body (see reference/git.md#pr-body); the rules are configurable in local-config.`);
    process.exit(1);
  }
  o.pass[i + 1] = path;
  return body;
}

/** What the diff says about the PR: whether it targets a non-default branch (stacked) and how many code files it changes. */
function diffContext(o: OpenArgs): BodyContext {
  const head = headOf(o);
  const r = spawnSync(process.execPath, [PR_SIZE, '--repo', o.repo, '--base', o.base, '--json', ...(head ? ['--head', head] : [])], { encoding: 'utf8' });
  let codeFiles = 0;
  try { codeFiles = (JSON.parse(r.stdout) as { code: { files: number } }).code.files; } catch { /* the size gate reports the real error next */ }
  const t = flagIndex(o.pass, '--title');
  return { stacked: !PROTECTED_BRANCHES.some((g) => globToRegExp(g).test(o.base)), codeFiles, title: t >= 0 ? o.pass[t + 1] : '' };
}

function main(): void {
  const o = parseArgs(process.argv.slice(2));
  const body = checkBody(o);
  const gate = spawnSync(process.execPath, [PR_SIZE, '--repo', o.repo, '--base', o.base, ...(headOf(o) ? ['--head', headOf(o)] : [])], { encoding: 'utf8' });
  process.stdout.write(gate.stdout || '');
  if (gate.status === 1) {
    console.error('pr-open: refused, the PR is over the size budget. Report a split plan (which files and lines go in which PR, in merge order) instead of opening; mechanical changes go in their own PR.');
    process.exit(1);
  }
  if (gate.status !== 0) { console.error(gate.stderr || 'pr-open: pr-size failed'); process.exit(2); }
  checkLinkPaths(o, body);
  const gh = process.env.MAESTRO_GH_BIN || 'gh';
  const args = ghArgs(o);
  if (o.dryRun) { console.log(`${gh} ${args.join(' ')}`); return; }
  const r = spawnSync(gh, args, { cwd: o.repo, stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8' });
  process.stdout.write(r.stdout || '');
  if (r.status !== 0) process.exit(r.status ?? 2);
  const pr = /\/pull\/(\d+)/.exec(r.stdout || '')?.[1];
  const err = pr && /\{\{file:/.test(body) ? linkPr(o.repo, Number(pr), body) : '';
  if (err) { console.error(`pr-open: the PR is open, but its file links were not expanded: ${err}. Fix and run pr-guide-links.ts ${o.repo} ${pr}.`); process.exit(1); }
}

/** Refuses before creating anything when a `{{file:...}}` token names a path that is not in the diff. */
function checkLinkPaths(o: OpenArgs, body: string): void {
  const wanted = [...new Set(tokenPaths(body))];
  if (!wanted.length) return;
  const head = headOf(o) || 'HEAD';
  const r = spawnSync('git', ['-C', o.repo, 'diff', '--name-only', '-M', `${resolveBase(o.repo, o.base)}...${head}`], { encoding: 'utf8' });
  const changed = new Set((r.stdout || '').split('\n').filter(Boolean));
  const missing = wanted.filter((p) => !changed.has(p));
  if (r.status !== 0 || missing.length) {
    console.error(r.status !== 0 ? `pr-open: cannot list the diff to check the {{file:...}} tokens: ${r.stderr.trim()}` : `pr-open: refused, these {{file:...}} paths are not in the diff: ${missing.join(', ')}. Link only files this PR changes (see reference/git.md#reviewer-guide-links).`);
    process.exit(r.status !== 0 ? 2 : 1);
  }
}

/** Index of a flag among the flag positions of `pass` (even indices), never a value that looks like one. */
const flagIndex = (pass: string[], flag: string): number => pass.findIndex((v, j) => j % 2 === 0 && v === flag);

const headOf = (o: OpenArgs): string => { const i = flagIndex(o.pass, '--head'); return i >= 0 ? o.pass[i + 1] : ''; };

const isMain = () => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };

if (process.argv[1] && isMain()) main();
