#!/usr/bin/env node
/**
 * REVIEW NOTE: the push gate behind reference/git.md "Review-note gate". In a repo listed in `review_note_repos`, a push needs a
 * vault Reviews note for the exact head commit, so "reviewed locally before the push" is checked, not just asked for.
 *
 *   node scripts/review-note.ts check --repo <path> [--head <branch>] [--vault <root>]   exit 0 ok, 1 refused
 *   node scripts/review-note.ts new   --repo <path> [--head <branch>] [--vault <root>] [--slug <words>]   writes the stub, prints its path
 *   node scripts/review-note.ts push  --repo <path> [--remote origin] [--branch <b>] [--vault <root>]   check, then `git push <remote> <branch>`
 *
 * Note convention: `<vault>/Projects/<repo>/Reviews/<YYYY-MM-DD>-<slug>-review-<sha7>.md`, where <repo> is the origin repo's name and
 * <sha7> the first seven characters of the head commit. The note counts only when all three hold:
 *   1. the file name carries `-review-<sha7>.md`;
 *   2. its frontmatter has `head: <the full 40-character sha>`, so a note written for an older commit never matches;
 *   3. it has a `## Naming pass` section with real content (the files checked, scripts included, and what was renamed or why nothing was);
 *   4. when `reviewer_checklist` names an existing file (the org overlay's list of what its reviewers ask for), it also has a
 *      `## Reviewer checklist` section with real content: each item marked pass, fixed or not applicable.
 * A push after the review makes a new head, so the review is repeated. Not checked: that the review was good.
 *
 * `push` runs `git push` only after the check passes (never with --force: it passes no flag but `<remote> <branch>`). It is the push path
 * the playbooks call; git-guard.ts also asks on a raw `git push` in a gated repo with no note, so a skipped wrapper is still caught.
 * The gate list comes from the user config file only (`review_note_repos`); an environment variable cannot add or drop a repo.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gateApplies, headSha, repoSlug } from './pr-smells.ts';
import { REVIEWER_CHECKLIST, REVIEW_NOTE_REPOS, VAULT_ROOT } from './local-config.ts';

const git = (repo: string, ...args: string[]) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });

/** The repo's name for the vault folder: the origin's repo name, else the checkout's folder. */
export function repoName(repo: string): string {
  const slug = repoSlug(git(repo, 'remote', 'get-url', 'origin').stdout || '');
  if (slug) return slug.split('/')[1]!;
  return basename(git(repo, 'rev-parse', '--show-toplevel').stdout.trim() || repo);
}

/** The Reviews folder for a repo under a vault root. */
export const reviewsDir = (vault: string, repo: string): string => join(vault, 'Projects', repoName(repo), 'Reviews');

const PLACEHOLDER = /^(?:tbd|todo|n\/a|none|-|_tbd_|<.*>)$/i;

/** The real lines under a `## <title>` heading: placeholders, bare dashes, `<...>` stubs and HTML comments do not count. Undefined when the heading is missing. */
function sectionLines(text: string, title: string): string[] | undefined {
  const m = new RegExp(`^##\\s+${title}\\s*$`, 'im').exec(text);
  if (!m) return undefined;
  const body = text.slice(m.index + m[0].length).split(/^#{1,2}\s/m)[0]!;
  return body.split('\n').map((l) => l.replace(/^[-*\s]+/, '').trim()).filter((l) => l && !PLACEHOLDER.test(l) && !/^<!--.*-->$/.test(l));
}

/** Why a note does not count for `sha`: its frontmatter head, a Naming pass with real content and, when `checklist` is set, a Reviewer checklist with real content. */
export function noteProblems(text: string, sha: string, checklist = ''): string[] {
  const out: string[] = [];
  const fm = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
  const head = /^head:\s*"?([0-9a-f]{7,40})"?\s*$/im.exec(fm)?.[1];
  if (head !== sha) out.push(`frontmatter head is ${head ?? 'missing'}, not ${sha}`);
  for (const [title, needed] of [['Naming pass', true], ['Reviewer checklist', Boolean(checklist)]] as const) {
    if (!needed) continue;
    const lines = sectionLines(text, title);
    if (!lines) out.push(`no "## ${title}" section`);
    else if (lines.length === 0) out.push(`the "## ${title}" section is empty or still a placeholder`);
  }
  return out;
}

/** The notes in `dir` whose name carries this head's seven-character prefix. */
function candidates(dir: string, sha: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(`-review-${sha.slice(0, 7)}.md`)).map((f) => join(dir, f));
}

export interface GateResult { applies: boolean; ok: boolean; sha: string; dir: string; note?: string; problems: string[] }

/** Whether a push of `head` is allowed: the gate does not apply, or a valid note exists for the head commit. */
export function gate(repo: string, head = '', vault: string = VAULT_ROOT, globs: string[] = REVIEW_NOTE_REPOS, checklist: string = REVIEWER_CHECKLIST): GateResult {
  const sha = headSha(repo, head);
  if (!gateApplies(repo, globs)) return { applies: false, ok: true, sha, dir: '', problems: [] };
  if (!vault) return { applies: true, ok: false, sha, dir: '', problems: ['no vault is configured (vault_root), so no Reviews note can be found'] };
  const dir = reviewsDir(vault, repo);
  const found = candidates(dir, sha);
  const problems: string[] = [];
  for (const f of found) {
    const p = noteProblems(readFileSync(f, 'utf8'), sha, checklist);
    if (p.length === 0) return { applies: true, ok: true, sha, dir, note: f, problems: [] };
    problems.push(`${basename(f)}: ${p.join('; ')}`);
  }
  if (!found.length) problems.push(`no note named *-review-${sha.slice(0, 7)}.md in ${dir}`);
  return { applies: true, ok: false, sha, dir, problems };
}

/** The refusal text for a failed gate, with what to do next. */
export const refusal = (r: GateResult, repo: string): string =>
  `needs a valid vault Reviews note for head ${r.sha.slice(0, 7)} (${r.problems.join(' | ')}). Run the local review (naming pass over every touched file, the reviewer checklist), then: node scripts/review-note.ts new --repo ${repo} and fill it in.`;

/** Write the stub note for the head commit; refuses to overwrite one that exists. */
export function newNote(repo: string, head: string, vault: string, slug: string, today = new Date().toISOString().slice(0, 10), checklist: string = REVIEWER_CHECKLIST): string {
  const sha = headSha(repo, head);
  const dir = reviewsDir(vault, repo);
  const words = (slug || head || git(repo, 'branch', '--show-current').stdout.trim() || 'branch').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const path = join(dir, `${today}-${words}-review-${sha.slice(0, 7)}.md`);
  if (existsSync(path)) throw new Error(`${path} already exists`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `---\ntype: review\nhead: ${sha}\nrepo: ${repoName(repo)}\nverdict: pending\n---\n\n# Review of ${words} at ${sha.slice(0, 7)}\n\n## Naming pass\n<every touched file, scripts and fixtures included: variables, functions, parameters, flags; what was renamed, or why each is fine>\n\n## Reviewer checklist\n${checklist ? `<!-- read ${checklist} first -->\n` : ''}<each checklist item: pass, fixed or not applicable, one line each>\n\n## Findings\n<what the review found, what was fixed, what was left and why>\n`);
  return path;
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  const arg = (f: string): string => { const i = rest.indexOf(f); return i >= 0 ? (rest[i + 1] ?? '') : ''; };
  const repo = arg('--repo');
  if (!['check', 'new', 'push'].includes(cmd ?? '') || !repo) {
    console.error('usage: node scripts/review-note.ts check|new|push --repo <path> [--head <branch>] [--vault <root>] [--slug <words>] [--remote <r>] [--branch <b>]');
    return 2;
  }
  const vault = arg('--vault') || VAULT_ROOT;
  try {
    if (cmd === 'new') { console.log(newNote(repo, arg('--head'), vault, arg('--slug'))); return 0; }
    const branch = cmd === 'push' ? arg('--branch') || git(repo, 'branch', '--show-current').stdout.trim() : arg('--head');
    const r = gate(repo, branch, vault);
    if (!r.ok) { console.error(`review-note: refused, the push ${refusal(r, repo)}`); return 1; }
    console.log(r.applies ? `review-note: ok, ${r.note}` : 'review-note: gate does not apply to this repo');
    if (cmd === 'check') return 0;
    if (!branch) { console.error('review-note: push needs a branch (detached HEAD)'); return 2; }
    const p = spawnSync('git', ['-C', repo, 'push', arg('--remote') || 'origin', branch], { stdio: 'inherit' });
    return p.status ?? 2;
  } catch (e) { console.error(`review-note: ${(e as Error).message}`); return 2; }
}

const isMain = () => { try { return realpathSync(process.argv[1]!) === fileURLToPath(import.meta.url); } catch { return false; } };

if (process.argv[1] && isMain()) process.exit(main(process.argv.slice(2)));
