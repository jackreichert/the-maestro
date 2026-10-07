#!/usr/bin/env node
/**
 * PR OPEN: the only way agents and the orchestrator open a PR. Checks the body, runs the pr-size gate, then
 * `gh pr create --draft --assignee @me`, so the size budget and the reviewer guide are enforced, not just described.
 *
 *   node scripts/pr-open.ts --repo <path> --base <branch> --title <t> --body-file <f> [--head <branch>] [--dry-run]
 *
 * The body file is required and must hold a `## Context` and a `## Reviewer guide` section, each with real
 * content (not empty, not a placeholder such as TBD or TODO); otherwise exit 1 and gh is never called.
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
    else if (Object.hasOwn(PASSTHROUGH, a)) o.pass.push(PASSTHROUGH[a], argv[++i] ?? '');
    else usage(`unknown argument ${a} (draft and assignee are always set; use --repo, --base, --title, --body-file, --head, --dry-run)`);
  }
  if (!o.repo || !o.base) usage('--repo and --base are required');
  return o;
}

/** The gh argv: draft and assignee first, so they can never be dropped. */
export const ghArgs = ({ base, pass }: Pick<OpenArgs, 'base' | 'pass'>): string[] => ['pr', 'create', '--draft', '--assignee', '@me', '--base', base, ...pass];

const REQUIRED_SECTIONS = ['Context', 'Reviewer guide'];
const PLACEHOLDER = /^(?:[-*_\s.]*(?:tbd|todo|n\/a|none|fill (?:me )?in|wip)[-*_\s.]*|[-*_\s.]*)$/i;

/** The text under each `##` title, to the next `#` or `##` heading; fenced code and HTML comments are ignored. */
function sectionsOf(body: string): Map<string, string> {
  const out = new Map<string, string>();
  let current = '';
  let fence = '';
  for (const line of body.replace(/<!--[\s\S]*?-->/g, '').split('\n')) {
    const mark = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (mark && !fence) fence = mark[0];
    else if (mark && mark[0] === fence) fence = '';
    const heading = fence || mark ? null : /^(#{1,2})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = heading[1] === '##' ? heading[2].toLowerCase() : '';
      if (current) out.set(current, out.get(current) ?? '');
    } else if (current && !mark) out.set(current, `${out.get(current)}${line}\n`);
  }
  return out;
}

/** Problems that keep a PR body from opening: each required section must exist with non-placeholder content. */
export function bodyProblems(body: string): string[] {
  const sections = sectionsOf(body);
  return REQUIRED_SECTIONS.flatMap((name) => {
    const text = sections.get(name.toLowerCase());
    if (text === undefined) return [`missing a "## ${name}" section`];
    const filled = text.split('\n').some((l) => !PLACEHOLDER.test(l.trim()));
    return filled ? [] : [`"## ${name}" has no content (empty or a placeholder)`];
  });
}

/** Read and check the --body-file; the gh argument is rewritten to the absolute path that was checked. */
function checkBody(o: OpenArgs): void {
  const i = o.pass.indexOf('--body-file');
  if (i < 0 || !o.pass[i + 1]) {
    console.error('pr-open: refused, --body-file is required. The body needs a "## Context" and a "## Reviewer guide" section (see reference/git.md#pr-body).');
    process.exit(1);
  }
  const path = resolve(o.pass[i + 1]);
  let body: string;
  try { body = readFileSync(path, 'utf8'); } catch (e) { console.error(`pr-open: cannot read --body-file ${path}: ${(e as Error).message}`); process.exit(2); }
  const problems = bodyProblems(body);
  if (problems.length) {
    console.error(`pr-open: refused, the PR body ${problems.join('; ')}. Add a "## Context" and a "## Reviewer guide" section with real content (see reference/git.md#pr-body).`);
    process.exit(1);
  }
  o.pass[i + 1] = path;
}

function main(): void {
  const o = parseArgs(process.argv.slice(2));
  checkBody(o);
  const gate = spawnSync(process.execPath, [PR_SIZE, '--repo', o.repo, '--base', o.base, ...(headOf(o) ? ['--head', headOf(o)] : [])], { encoding: 'utf8' });
  process.stdout.write(gate.stdout || '');
  if (gate.status === 1) {
    console.error('pr-open: refused, the PR is over the size budget. Report a split plan (which files and lines go in which PR, in merge order) instead of opening; mechanical changes go in their own PR.');
    process.exit(1);
  }
  if (gate.status !== 0) { console.error(gate.stderr || 'pr-open: pr-size failed'); process.exit(2); }
  const gh = process.env.MAESTRO_GH_BIN || 'gh';
  const args = ghArgs(o);
  if (o.dryRun) { console.log(`${gh} ${args.join(' ')}`); return; }
  const r = spawnSync(gh, args, { cwd: o.repo, stdio: 'inherit' });
  process.exit(r.status ?? 2);
}

const headOf = (o: OpenArgs): string => { const i = o.pass.indexOf('--head'); return i >= 0 ? o.pass[i + 1] : ''; };

const isMain = () => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };

if (process.argv[1] && isMain()) main();
