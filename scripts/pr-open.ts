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
 * In a repo listed in pr_smells_repos it also refuses unless a smells run is recorded for the head commit
 * (pr-smells.ts record) and the body carries its `Smells:` line; docs-only diffs are exempt.
 * In this skill's own repo, and in any repo listed in leak_gate_repos, it also refuses a PR whose added lines, title or body carry an org
 * term, a personal path or a configured name (pr-leaks.ts); it reports file:line and never the matched text.
 * In a repo listed in review_note_repos it also refuses unless a vault Reviews note exists for the head commit (review-note.ts).
 *
 * Over budget: prints the pr-size summary and a split hint, exits 1, never calls gh, unless the
 * repo's origin matches `waive_size_gate_owners` (default none): then it prints a one-line waiver
 * note and carries on. Mixing code with mechanical files is never waived. Unreadable pr-size JSON
 * refuses instead of claiming that mix. The waiver comes from the user config file
 * (`waive_size_gate_owners`) only; an environment variable cannot set it, and there is no flag
 * for it. When it applies, gh is pinned to the origin repo with --repo. Within budget: runs gh in <path>. --draft
 * and --assignee @me are always added and cannot be turned off; no other gh flag passes through.
 * --dry-run prints the gh command instead of running it.
 * The review queue cap is not checked here: this script only ever opens drafts, which the cap never counts. It is enforced where a draft joins the queue,
 * by `pr-ready.ts` (reference/dispatch.md#review-queue-cap).
 * Exit 0 opened (or dry run), 1 refused (body, size gate or file token), 2 bad usage or a git/gh error, 3 the PR
 * opened but its file links could not be expanded (run pr-guide-links.ts).
 * The gh binary is `gh`, or the path in MAESTRO_GH_BIN (tests use a fake).
 *
 * Ledger link: once the PR exists, a `ref` row records `gh:pr:owner/repo#N` and the branch on the ledger row it is for, so
 * merge-sweep can close that row when the PR merges. The row is `--item <id>`, else MAESTRO_ITEM, else a ledger id in the
 * branch name (`feat/MAESTRO-6tq3-...`). `--vault <ledger root>` and `--project <name>` override the configured ledger.
 * A link that cannot be written is a warning on stderr; it never changes the exit code, because the PR is already open.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from './lib/journal/store.ts';
import { itemFor, linkRowToPr, parsePrUrl } from './lib/row-prs.ts';
import { bodyProblems, type BodyContext } from './pr-body.ts';
import { CONFIGURED_PROJECT, LEAK_GATE_REPOS, LEAK_TERMS, LEDGER_ROOT, ONE_PR_EXEMPT_HEADS, ONE_PR_KEY_PATTERN, ONE_PR_PER_TICKET, PROTECTED_BRANCHES, VAULT_ROOT, WAIVE_SIZE_GATE_OWNERS } from './local-config.ts';
import { checkOnePerTicket, listOpenPrs, ticketKey } from './pr-ticket-key.ts';
import { globToRegExp, resolveBase } from './pr-size.ts';
import { linkPr, tokenPaths, tokenProblems, hasLooseToken } from './pr-links.ts';
import { smellsProblems } from './pr-smells.ts';
import { gateApplies as leaksApply, leakCheck, report as leaksReport } from './pr-leaks.ts';

/** This skill's own repo: the leak gate always applies here. */
const LEAK_SELF_REPO = ['jackreichert', 'the-maestro'].join('/');
import { gate as reviewNoteGate, refusal as reviewNoteRefusal } from './review-note.ts';
import { toolCommand } from './lib/tool-bin.ts';

const PR_SIZE = fileURLToPath(new URL('./pr-size.ts', import.meta.url));
/** Parsed command line: `pass` holds the gh flags and values forwarded as given. */
export interface OpenArgs { repo: string; base: string; dryRun: boolean; pass: string[]; item?: string; vault?: string; project?: string }

const PASSTHROUGH: Record<string, string> = { '--title': '--title', '--body-file': '--body-file', '--head': '--head' };

function usage(msg?: string): never {
  if (msg) console.error(`pr-open: ${msg}`);
  console.error('usage: node scripts/pr-open.ts --repo <path> --base <branch> --title <t> --body-file <f> [--head <branch>] [--item <ledger id>] [--vault <ledger root>] [--project <name>] [--dry-run]');
  process.exit(2);
}

export function parseArgs(argv: string[]): OpenArgs {
  const o: OpenArgs = { repo: '', base: '', dryRun: false, pass: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--repo' || a === '--base') o[a === '--repo' ? 'repo' : 'base'] = argv[++i] ?? '';
    else if (a === '--item' || a === '--vault' || a === '--project') o[a.slice(2) as 'item' | 'vault' | 'project'] = argv[++i] ?? '';
    else if (Object.hasOwn(PASSTHROUGH, a)) {
      if (flagIndex(o.pass, a) >= 0) usage(`${a} given more than once`);
      o.pass.push(PASSTHROUGH[a], argv[++i] ?? '');
    }
    else usage(`unknown argument ${a} (draft and assignee are always set; use --repo, --base, --title, --body-file, --head, --item, --vault, --project, --dry-run)`);
  }
  if (!o.repo || !o.base) usage('--repo and --base are required');
  return o;
}

/** The gh argv: draft and assignee first, so they can never be dropped. */
export const ghArgs = ({ base, pass }: Pick<OpenArgs, 'base' | 'pass'>): string[] => ['pr', 'create', '--draft', '--assignee', '@me', '--base', base, ...pass];

/**
 * One PR per ticket (pr-ticket-key.ts): refuses when another open PR in the repo carries this branch's ticket key and is not a
 * twin, a stack parent or a release PR; a stack prints a warning. A gh failure refuses too, so the rule is never skipped silently.
 */
function onePerTicket(o: OpenArgs, body: string): void {
  if (!ONE_PR_PER_TICKET) return;
  const t = flagIndex(o.pass, '--title');
  const pr = { branch: branchOf(o), base: o.base, title: t >= 0 ? o.pass[t + 1] : '', body };
  const rules = { pattern: ONE_PR_KEY_PATTERN, exemptHeads: ONE_PR_EXEMPT_HEADS, protectedBases: PROTECTED_BRANCHES };
  try {
    // No key means nothing to look up, so gh is not called.
    const v = ticketKey(pr.branch, pr.title, rules.pattern) ? checkOnePerTicket(pr, listOpenPrs(o.repo), rules) : checkOnePerTicket(pr, [], rules);
    if (v.status === 'fail') { console.error(`pr-open: ${v.message}`); process.exit(1); }
    console.log(`pr-open: ${v.message}`);
  } catch (e) {
    console.error(`pr-open: refused, could not check the one-PR-per-ticket rule: ${(e as Error).message}. Fix gh access and retry; the rule can be turned off with one_pr_per_ticket: off in the user config.`);
    process.exit(2);
  }
}

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
  const ctx = diffContext(o);
  const problems = [...bodyProblems(body, undefined, ctx), ...smellsGate(o, body, ctx), ...reviewNoteProblems(o)];
  if (problems.length) {
    console.error(`pr-open: refused, the PR body ${problems.join('; ')}. Fix the body (see reference/git.md#pr-body); the rules are configurable in local-config.`);
    process.exit(1);
  }
  o.pass[i + 1] = path;
  return body;
}

/** The smells gate (reference/git.md#smells-gate); a git failure reading the head refuses rather than passing silently. */
function smellsGate(o: OpenArgs, body: string, ctx: BodyContext): string[] {
  try { return smellsProblems(o.repo, headOf(o), body, ctx.codeFiles); } catch (e) { return [(e as Error).message]; }
}

/**
 * The leak gate (reference/git.md#leak-gate): where it applies, a hit refuses before gh is called. Terms come from local-config only;
 * with none configured the run says that customer names were not checked, and carries on with the built-in checks.
 */
function leaksGate(o: OpenArgs, body: string): void {
  if (!leaksApply(o.repo, [LEAK_SELF_REPO, ...LEAK_GATE_REPOS])) return;
  const t = flagIndex(o.pass, '--title');
  const res = leakCheck({ repo: o.repo, base: resolveBase(o.repo, o.base), head: headOf(o) || 'HEAD', title: t >= 0 ? o.pass[t + 1] : '', body, termsRaw: LEAK_TERMS, strict: false });
  if (!leaksReport(res, (s) => console.log(`pr-open: ${s}`), (s) => console.error(`pr-open: ${s}`))) return;
  console.error('pr-open: refused, the PR adds text that must not be in a public skill (file:line, or commit:<sha8>, and kind above; a commit message or identity cannot be edited in place, so say so and ask before rewording the commit). Genericise it; a stored name that cannot change goes in the narrow allowlist in pr-leaks.ts, with a reason.');
  process.exit(1);
}

/** The review-note gate (reference/git.md#review-note-gate): in a `review_note_repos` repo a PR opens only for a head commit with a vault Reviews note. */
function reviewNoteProblems(o: OpenArgs): string[] {
  try { const r = reviewNoteGate(o.repo, headOf(o)); return r.ok ? [] : [reviewNoteRefusal(r, o.repo)]; } catch (e) { return [(e as Error).message]; }
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

export type SizeMix = 'mixed' | 'clean' | 'unreadable';

/** Classify pr-size --json. Missing numbers are unreadable, not a mix. */
export const classifySizeJson = (stdout: string): SizeMix => {
  try {
    const j = JSON.parse(stdout) as { code?: { files?: number }; mechanical?: { files?: number } };
    const code = j.code?.files;
    const mechanical = j.mechanical?.files;
    if (typeof code !== 'number' || typeof mechanical !== 'number') return 'unreadable';
    return code > 0 && mechanical > 0 ? 'mixed' : 'clean';
  } catch {
    return 'unreadable';
  }
};

/** The reviewability rule no size waiver lifts. Unreadable JSON is not reported as a mix. */
function sizeMix(o: OpenArgs): SizeMix {
  const head = headOf(o);
  const r = spawnSync(process.execPath, [PR_SIZE, '--repo', o.repo, '--base', o.base, '--json', ...(head ? ['--head', head] : [])], { encoding: 'utf8' });
  return classifySizeJson(r.stdout || '');
}

function main(): void {
  const o = parseArgs(process.argv.slice(2));
  const body = checkBody(o);
  leaksGate(o, body);
  onePerTicket(o, body);
  const gate = spawnSync(process.execPath, [PR_SIZE, '--repo', o.repo, '--base', o.base, ...(headOf(o) ? ['--head', headOf(o)] : [])], { encoding: 'utf8' });
  process.stdout.write(gate.stdout || '');
  const overBudget = gate.status === 1;
  const waivedSlug = overBudget ? sizeGateWaiver(o.repo) : '';
  const mix = overBudget && waivedSlug ? sizeMix(o) : 'clean';
  if (overBudget && waivedSlug && mix === 'unreadable') {
    console.error('pr-open: refused, pr-size did not return readable JSON, so the waiver cannot tell code from mechanical files.');
    process.exit(1);
  } else if (overBudget && waivedSlug && mix === 'mixed') {
    console.error('pr-open: refused, the PR mixes code with mechanical files. The waiver (waive_size_gate_owners) lifts the size limits only; mechanical changes (lockfiles, generated files, pure renames) still go in their own PR.');
    process.exit(1);
  } else if (overBudget && waivedSlug) {
    console.log(`pr-open: size limits waived for ${waivedSlug} (waive_size_gate_owners); the summary above is informational. The rule that mechanical changes go in their own PR still applies.`);
  } else if (overBudget) {
    console.error('pr-open: refused, the PR is over the size budget. Report a split plan (which files and lines go in which PR, in merge order) instead of opening; mechanical changes go in their own PR.');
    process.exit(1);
  } else if (gate.status !== 0) { console.error(gate.stderr || 'pr-open: pr-size failed'); process.exit(2); }
  checkLinkPaths(o, body);
  const gh = process.env.MAESTRO_GH_BIN || 'gh';
  // A waiver was decided for the origin's github.com slug, so gh is pinned to that same repo and host (never GH_REPO, GH_HOST, an upstream remote or a gh default).
  const args = waivedSlug ? [...ghArgs(o), '--repo', `github.com/${waivedSlug}`] : ghArgs(o);
  const ghEnv = waivedSlug ? { ...process.env, GH_REPO: '' } : process.env;
  if (o.dryRun) { console.log(`${gh} ${args.join(' ')}`); return; }
  const [ghCmd, ghArgv] = toolCommand('gh', args);
  const r = spawnSync(ghCmd, ghArgv, { cwd: o.repo, stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8', env: ghEnv });
  process.stdout.write(r.stdout || '');
  if (r.status !== 0) process.exit(r.status ?? 2);
  recordLink(o, r.stdout || '');
  if (!hasLooseToken(body)) return;
  const pr = /\/pull\/(\d+)/.exec(r.stdout || '')?.[1];
  const err = pr ? linkPr(o.repo, Number(pr), body) : 'gh did not print the PR url';
  if (err) { console.error(`pr-open: the PR is open, but its file links were not expanded: ${err}. Fix and run pr-guide-links.ts ${o.repo} ${pr ?? '<pr-number>'}.`); process.exit(3); }
}

/** The branch the PR is from: `--head`, else the one checked out in --repo. */
function branchOf(o: OpenArgs): string {
  return headOf(o) || spawnSync('git', ['-C', o.repo, 'branch', '--show-current'], { encoding: 'utf8' }).stdout.trim();
}

/** Link the new PR to its ledger row (see the header). Best effort: every failure is a stderr warning. */
function recordLink(o: OpenArgs, ghOut: string): void {
  try {
    const branch = branchOf(o);
    const item = itemFor(o.item, process.env.MAESTRO_ITEM, branch);
    const pr = parsePrUrl(ghOut);
    const vault = o.vault || LEDGER_ROOT || VAULT_ROOT;
    const project = o.project || CONFIGURED_PROJECT;
    if (!item) { if (o.item || process.env.MAESTRO_ITEM) console.error(`pr-open: the PR is open, but the ledger id ${JSON.stringify(o.item || process.env.MAESTRO_ITEM)} is not a well-formed id, so no row was linked.`); return; }
    if (!pr) { console.error('pr-open: the PR is open, but gh did not print a github.com pull URL, so the ledger row was not linked.'); return; }
    if (!vault || !project) { console.error('pr-open: the PR is open, but no ledger is configured (--vault and --project, or LEDGER_ROOT and project), so the row was not linked.'); return; }
    const store = openStore({ vault, project, dryRun: false });
    const result = linkRowToPr(store, item, pr, branch, { now: () => new Date().toISOString(), today: () => new Date().toISOString().slice(0, 10) });
    if (result === 'not-open') console.error(`pr-open: the PR is open, but ledger row ${item} is not an open row, so it was not linked.`);
    else console.log(`pr-open: ${result === 'linked' ? 'linked' : 'already linked'} ${pr.repo}#${pr.number} to ledger row ${item}`);
  } catch (e) { console.error(`pr-open: the PR is open, but linking the ledger row failed: ${(e as Error).message}`); }
}

const originUrl = (repo: string): string => spawnSync('git', ['-C', repo, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).stdout || '';

/** `owner/name` from a github.com origin url (https, ssh or scp form), host anchored; '' for anything else. */
export function githubSlug(url: string): string {
  return /^(?:https?:\/\/(?:[^@/\s]+@)?|ssh:\/\/git@|git@)github\.com[:/]([^/\s?#]+\/[^/\s?#]+?)(?:\.git)?\/?$/i.exec(url.trim())?.[1] ?? '';
}

/** The `owner/name` the size gate is waived for, or '' when it is not. Fails closed: no setting, or an origin that is not a github.com url, means the gate holds. */
export function sizeGateWaiver(repo: string, globs: string[] = WAIVE_SIZE_GATE_OWNERS): string {
  const slug = githubSlug(originUrl(repo));
  return slug && globs.some((g) => globToRegExp(g.toLowerCase()).test(slug.toLowerCase())) ? slug : '';
}

/** Refuses before creating anything when a `{{file:...}}` token names a path that is not in the diff. */
function checkLinkPaths(o: OpenArgs, body: string): void {
  const wanted = [...new Set(tokenPaths(body))];
  if ((body.match(/\{\{file:/g) ?? []).length !== tokenPaths(body).length) {
    console.error('pr-open: refused, a {{file:...}} token could not be read. A token is {{file:path}}, {{file:path#R42}} or {{file:path#R42-R50}} with the closing braces.');
    process.exit(1);
  }
  const problems = tokenProblems(body);
  if (problems.length) {
    console.error(`pr-open: refused, a {{file:...}} anchor is malformed: ${problems.join('; ')}`);
    process.exit(1);
  }
  if (!wanted.length) return;
  const head = headOf(o) || 'HEAD';
  const r = spawnSync('git', ['-C', o.repo, '-c', 'core.quotePath=false', 'diff', '--name-only', '-z', '-M', `${resolveBase(o.repo, o.base)}...${head}`], { encoding: 'utf8' });
  const changed = new Set((r.stdout || '').split('\0').filter(Boolean));
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
