#!/usr/bin/env node
/**
 * PR LEAKS: refuse a PR that adds an org name, a person's name, a customer name or a personal absolute path to a
 * generic, public skill. It reads the lines the diff adds (and the PR title and body) and reports `file:line label`
 * for each hit. It never prints the matched text, because a hit on a configured name would put that name in a
 * public log.
 *
 *   node scripts/pr-leaks.ts --repo <path> --base <ref> [--head <ref>] [--tree] [--terms-file <path>] [--strict]
 *
 * Runs in two places, so a writer cannot skip it: `pr-open.ts` (a repo that is this skill, or listed in
 * `leak_gate_repos`) and `ci-gates.ts` (the `gates` workflow). `--tree` scans every tracked file at --head instead
 * of a diff; use it to see what an allowlist entry would have to cover.
 *
 * Built-in checks (no setup): an absolute user-home path (`/Users/<name>/`, `/home/<name>/`, `C:\Users\<name>`), a
 * personal root (a home-relative dev container directory), the org term and its common typo, and the owner's first name. Those terms are
 * already public through the repository URL, so they live here and not in config.
 *
 * Configured checks: customer names. They are deployment-specific and must never be committed, so they come from
 * `leak_terms` (user config file or overlay config.md) locally and from the `LEAK_TERMS` secret in CI. Comma or
 * newline separated; a term matches case-insensitively as a substring, with spaces, hyphens and underscores
 * interchangeable (`Acme Care` also finds `acme-care` and `AcmeCare`).
 *
 * Missing terms: locally the run says so and checks built-ins only. In CI (`strict`) it fails unless
 * `LEAK_GATE_BUILTIN_ONLY=1` is set, and then it says in the log that customer names were not checked. It never
 * passes silently as if it had.
 *
 * Portable: this file imports only node built-ins, so a sibling repo copies it (and pr-leaks.test.ts) as is. The term list is the
 * `termsRaw` argument; the CLI reads it from the LEAK_TERMS environment variable or `--terms-file <path>`. Callers in the-maestro
 * (pr-open.ts, ci-gates.ts) pass it from local-config. The ALLOW table below is this repo's; a port starts it empty. The CI step
 * passes the LEAK_TERMS secret and LEAK_GATE_BUILTIN_ONLY variable as env, then runs
 * `node scripts/pr-leaks.ts --repo . --base $BASE_SHA --head <head> --strict` from a checkout of the base ref.
 *
 * This file builds its own search terms from fragments so the gate does not trip on itself.
 * Exit 0 clean, 1 a hit or an unusable term list, 2 bad usage or a git error.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ORG = ['ar', 'ya'].join('');
const TYPO = ['ay', 'ra'].join('');
const OWNER = ['ja', 'ck'].join('');
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MIN_TERM = 3;

export type Label = 'org-term' | 'person-name' | 'home-path' | 'personal-root' | 'configured-term';
export interface Hit { path: string; line: number; label: Label }
interface Pattern { label: Label; re: RegExp; ok?: (captured: string) => boolean }

/** Directory names that stand for "some user" in docs and fixtures, so a path through them names nobody. */
const PLACEHOLDER_USERS = new Set(['me', 'user', 'username', 'you', 'name', 'example', 'runner']);
const named = (captured: string): boolean => !PLACEHOLDER_USERS.has(captured.toLowerCase()) && !/^[<{$%~]/.test(captured);

/** The org term at a word start in any case (Org, ORG-tool, org_x), or as a camelCase part (xOrgY). "primaryArgs" does not match. */
const orgTerm = (word: string): RegExp[] => [new RegExp(`(?<![A-Za-z])${word}`, 'i'), new RegExp(`(?<=[a-z0-9_])${word[0]!.toUpperCase()}${word.slice(1)}`)];

const BUILTIN: Pattern[] = [
  ...orgTerm(ORG).map((re) => ({ label: 'org-term' as const, re })),
  ...orgTerm(TYPO).map((re) => ({ label: 'org-term' as const, re })),
  { label: 'person-name', re: new RegExp(`(?<![A-Za-z])${OWNER}(?![A-Za-z])`, 'i') },
  { label: 'home-path', re: /(?<![\w.-])\/(?:Users|home)\/([^/\s'"`<>:;,)\]}]+)/, ok: named },
  { label: 'home-path', re: /\b[A-Za-z]:[\\/]+Users[\\/]+([^\\/\s'"`<>:;,)\]}]+)/, ok: named },
  { label: 'personal-root', re: /(?:~|\$HOME|\$\{HOME\})\/dev-env\b/ },
];

/**
 * Text that is allowed to match a built-in, each entry narrow and with its reason. The text is blanked before the
 * line is scanned, so a line that also carries a real hit still fails. Read from the base ref in CI, so a PR
 * cannot widen it in the same change; the same holds for the gate itself.
 */
export interface Allow { label: Label; path: RegExp; text: RegExp; reason: string }
const RETRO_FILES = /^(?:scripts\/(?:lib\/journal\/(?:agent-retro|brief|help)|lib\/library\/composer)\.ts|scripts\/(?:lib\/journal\/agent-retro|journal-agent-retro)\.test\.ts|playbooks\/(?:retro-review|composer)\.md|reference\/brief\.md|README\.md)$/;
const J = OWNER[0]!.toUpperCase() + OWNER.slice(1);
export const ALLOW: Allow[] = [
  { label: 'person-name', path: /^/, text: new RegExp(`(?:Paste blocks for |Needs[ -])${J}\\b|needs-${OWNER}\\b`, 'g'), reason: 'The box names are persisted in generated ledger pages and parsed by their tests; renaming them is a data migration tracked separately.' },
  { label: 'person-name', path: /^/, text: new RegExp(`told-by-${OWNER}\\b`, 'g'), reason: 'The told-by evidence kind is stored in library pages already written; renaming it needs a migration.' },
  { label: 'person-name', path: RETRO_FILES, text: new RegExp(`\`${OWNER}\`|["']${OWNER}:|'${OWNER}'|\\b${OWNER}: |\\b${OWNER} \\d`, 'g'), reason: 'The retro lesson source is a stored value next to code and process; renaming it needs a migration.' },
  { label: 'person-name', path: /^scripts\/lib\/journal\/guidance\.ts$/, text: new RegExp(`\\((?:${OWNER}\\|him|${OWNER}\\|a decision)`, 'g'), reason: 'A regex of wordings that mark an item as parked; changing it changes which items are offered as work.' },
  { label: 'person-name', path: /^scripts\/lib\/boxes\.ts$/, text: new RegExp(`${OWNER} runs`, 'g'), reason: 'One alternative in the regex that tells a paste-block question from a decision; behaviour, not prose.' },
  { label: 'org-term', path: /^scripts\/lib\/pr-refs(?:\.test)?\.ts$/, text: new RegExp(`${ORG}-(?:<name>|\\$\\{word\\}|tool)`, 'g'), reason: 'A repo-name prefix convention in the PR ref resolver; making it a setting is tracked separately.' },
  { label: 'personal-root', path: /^(?:README\.md|reference\/(?:brief|local-config)\.md|playbooks\/event-types\/(?:notion|slack)-watch\.md|scripts\/(?:local-config|env-store-move|lib\/tag-watch)\.ts)$/, text: /~\/dev-env\/(?:\.env-store|skills\/)/g, reason: 'The default env_store_root and the default skill search roots; both are configurable and the rename is tracked separately.' },
];

/** The compiled configured terms, or the reason the list cannot be used. A term shorter than MIN_TERM would match almost anything. */
export function parseTerms(raw: string): { terms: RegExp[]; error: string } {
  const entries = raw.split(/[\n,]/).map((t) => t.trim()).filter((t) => t && !t.startsWith('#'));
  const short = entries.filter((t) => t.replace(/[\s_-]+/g, '').length < MIN_TERM);
  if (short.length) return { terms: [], error: `${short.length} configured term(s) are shorter than ${MIN_TERM} characters, which would match almost every line. Remove or lengthen them.` };
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { terms: entries.map((t) => new RegExp(t.split(/[\s_-]+/).map(esc).join('[\\s_-]*'), 'i')), error: '' };
}

/** Labels hit on one line of `path`, after blanking allowlisted text. Configured terms are checked against the unblanked line. */
export function scanLine(path: string, text: string, terms: RegExp[], allow: Allow[] = ALLOW): Label[] {
  const found = new Set<Label>();
  for (const p of BUILTIN) {
    let line = text;
    for (const a of allow) if (a.label === p.label && a.path.test(path)) line = line.replace(a.text, ' ');
    const re = new RegExp(p.re.source, `${p.re.flags.replace('g', '')}g`);
    for (let m = re.exec(line); m; m = re.exec(line)) if (!p.ok || p.ok(m[1] ?? '')) { found.add(p.label); break; }
  }
  if (terms.some((t) => t.test(text))) found.add('configured-term');
  return [...found];
}

/** The lines a unified diff (`-U0`) adds, with their new-side line numbers. Deletions and context are never read. */
export function addedLines(diff: string): { path: string; line: number; text: string }[] {
  const out: { path: string; line: number; text: string }[] = [];
  let path = '';
  let line = 0;
  let inHunk = false;
  for (const text of diff.split('\n')) {
    if (text.startsWith('diff --git ')) { inHunk = false; path = ''; continue; }
    if (!inHunk && text.startsWith('+++ ')) { const p = text.slice(4).replace(/\t.*$/, ''); path = p === '/dev/null' ? '' : p.replace(/^b\//, ''); continue; }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (h) { inHunk = true; line = Number(h[1]); continue; }
    if (!inHunk || !path) continue;
    if (text.startsWith('+')) { out.push({ path, line, text: text.slice(1) }); line += 1; }
    else if (!text.startsWith('-') && !text.startsWith('\\')) line += 1;
  }
  return out;
}

export interface LeakInput { repo: string; base: string; head: string; tree?: boolean; title?: string; body?: string; termsRaw: string; strict: boolean }
export interface LeakResult { problems: string[]; notes: string[]; hits: Hit[] }

/** Scans the diff (or the whole tree), the title and the body. Fails closed on an unusable term list, a missing CI list, or a git error. */
export function leakCheck(i: LeakInput): LeakResult {
  const parsed = parseTerms(i.termsRaw);
  if (parsed.error) return { problems: [parsed.error], notes: [], hits: [] };
  const notes: string[] = [];
  if (!parsed.terms.length) {
    if (i.strict && process.env.LEAK_GATE_BUILTIN_ONLY !== '1') {
      return { problems: ['LEAK_TERMS is not set, so customer names cannot be checked and the gate will not pass as if they had been. Set the LEAK_TERMS secret (names only, comma or newline separated), or set LEAK_GATE_BUILTIN_ONLY=1 to accept built-in checks alone.'], notes: [], hits: [] };
    }
    notes.push(i.strict
      ? 'LEAK_GATE_BUILTIN_ONLY=1: built-in checks only; customer names were NOT checked.'
      : 'no leak_terms configured: built-in checks only; customer names were NOT checked. Set leak_terms in the user config file or the overlay config.md.');
  }
  const range = i.tree ? ['diff', '-U0', '--no-color', '-M', EMPTY_TREE, i.head] : ['diff', '-U0', '--no-color', '-M', `${i.base}...${i.head}`];
  const r = spawnSync('git', ['-C', i.repo, '-c', 'core.quotePath=false', ...range], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) return { problems: [`git diff failed: ${(r.stderr || '').trim()}`], notes, hits: [] };
  const hits: Hit[] = [];
  for (const l of addedLines(r.stdout)) for (const label of scanLine(l.path, l.text, parsed.terms)) hits.push({ path: l.path, line: l.line, label });
  for (const [name, text] of [['PR title', i.title], ['PR body', i.body]] as const) {
    (text ?? '').split('\n').forEach((t, n) => { for (const label of scanLine(name, t, parsed.terms, [])) hits.push({ path: name, line: n + 1, label }); });
  }
  return { problems: hits.map((h) => `${h.path}:${h.line} ${h.label}`), notes, hits };
}

/** `owner/name` glob match, case-insensitive; `*` matches any run of characters. */
const globMatch = (glob: string, slug: string): boolean => new RegExp(`^${glob.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i').test(slug);

/** True when the repo's origin slug matches one of `globs` (`owner/name`, `*` allowed). An origin that cannot be read as a GitHub repo is not gated; the CI gate is the backstop. */
export function gateApplies(repo: string, globs: string[]): boolean {
  const url = spawnSync('git', ['-C', repo, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8' }).stdout || '';
  const slug = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim())?.[1] ?? '';
  return slug !== '' && globs.some((g) => globMatch(g, slug));
}

/** `origin/<base>` after a quiet fetch when it exists, else `base` as given (a sha or a local branch). */
export function resolveBase(repo: string, base: string): string {
  const git = (...a: string[]) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('fetch', '--quiet', 'origin', base);
  return git('rev-parse', '--verify', '--quiet', `origin/${base}^{commit}`).status === 0 ? `origin/${base}` : base;
}

/** Prints the result in the gate's `leaks: PASS|FAIL` shape; hit lines and notes go to stderr. Returns the failure count. */
export function report(res: LeakResult, log: (s: string) => void = console.log, err: (s: string) => void = console.error): number {
  log(`leaks: ${res.problems.length ? 'FAIL' : 'PASS'}`);
  for (const n of res.notes) err(`leaks: note: ${n}`);
  for (const p of res.problems) err(`leaks: ${p}`);
  return res.problems.length;
}

function main(argv: string[]): number {
  const get = (f: string): string => { const k = argv.indexOf(f); return k >= 0 ? (argv[k + 1] ?? '') : ''; };
  const repo = get('--repo');
  const base = get('--base');
  const tree = argv.includes('--tree');
  if (!repo || (!base && !tree)) { console.error('usage: node scripts/pr-leaks.ts --repo <path> --base <ref> [--head <ref>] [--tree] [--terms-file <path>] [--strict]'); return 2; }
  const file = get('--terms-file');
  let fromFile = '';
  try { fromFile = file ? readFileSync(file, 'utf8') : ''; } catch (e) { console.error(`pr-leaks: cannot read --terms-file: ${(e as Error).message}`); return 2; }
  const res = leakCheck({ repo, base: tree ? '' : resolveBase(repo, base), head: get('--head') || 'HEAD', tree, termsRaw: [fromFile, process.env.LEAK_TERMS ?? ''].join('\n'), strict: argv.includes('--strict') });
  return report(res) ? 1 : 0;
}

const isMain = (): boolean => { try { return realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url); } catch { return false; } };

if (process.argv[1] && isMain()) process.exit(main(process.argv.slice(2)));
