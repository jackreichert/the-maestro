#!/usr/bin/env node
/**
 * PR SMELLS: the record behind the pr-open.ts smells gate (reference/git.md, "Smells gate").
 * After a report-only smells run (mithril-lite-review or mithril smells) on the branch, record it here; pr-open.ts
 * then refuses to open a PR for a repo in `pr_smells_repos` unless the run is recorded for the exact head commit
 * and the PR body carries the same one-line summary.
 *
 *   node scripts/pr-smells.ts record --repo <path> [--head <branch>] --summary "<findings, fixed, deliberately left>"
 *   node scripts/pr-smells.ts show   --repo <path> [--head <branch>]
 *
 * The record is an attestation that the run happened, kept in the repo's git directory (never committed). It names
 * the head commit, so a push after the run invalidates it and the run is repeated. Exit 0 ok, 1 no record, 2 usage or git error.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { globToRegExp } from './pr-size.ts';
import { PR_SMELLS_REPOS } from './local-config.ts';

/** What was recorded for one head commit. */
export interface SmellsRecord { head: string; summary: string; at: string }

const git = (repo: string, ...args: string[]) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });

/** `owner/name` from a GitHub remote url (https or ssh), or '' when it is not one. */
export function repoSlug(url: string): string {
  return /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim())?.[1] ?? '';
}

/** True when the repo's origin matches one of the `pr_smells_repos` globs (`owner/name`, `*` allowed). An origin that cannot be read as a GitHub repo counts as gated once any glob is set, so the gate never fails open. */
export function gateApplies(repo: string, globs: string[] = PR_SMELLS_REPOS): boolean {
  if (!globs.length) return false;
  const slug = repoSlug(git(repo, 'remote', 'get-url', 'origin').stdout || '');
  return slug === '' || globs.some((g) => globToRegExp(g.toLowerCase()).test(slug.toLowerCase()));
}

/** The full sha of `head` (a branch, or HEAD when empty). */
export function headSha(repo: string, head = ''): string {
  const r = git(repo, 'rev-parse', '--verify', '--quiet', `${head || 'HEAD'}^{commit}`);
  if (r.status !== 0) throw new Error(`cannot resolve ${head || 'HEAD'} in ${repo}`);
  return r.stdout.trim();
}

/** Where records live: shared by every worktree of the repo, outside the working tree. */
function storePath(repo: string): string {
  const r = git(repo, 'rev-parse', '--git-common-dir');
  if (r.status !== 0) throw new Error(`not a git repository: ${repo}`);
  return resolve(repo, r.stdout.trim(), 'maestro-smells.json');
}

function readAll(path: string): Record<string, SmellsRecord> {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, SmellsRecord>;
}

/** Record a smells run for the head commit; returns the record. An empty summary is refused. */
export function recordSmells(repo: string, summary: string, head = '', now = new Date()): SmellsRecord {
  const text = summary.replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('--summary is required: say what the run found, what was fixed and what was deliberately left');
  const rec: SmellsRecord = { head: headSha(repo, head), summary: text, at: now.toISOString() };
  const path = storePath(repo);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...readAll(path), [rec.head]: rec }, null, 2)}\n`);
  return rec;
}

/** The record for the head commit, or undefined when the run was never recorded for exactly this commit. */
export function recordFor(repo: string, head = ''): SmellsRecord | undefined {
  return readAll(storePath(repo))[headSha(repo, head)];
}

/** The body line a recorded run requires. */
export const smellsLine = (rec: SmellsRecord): string => `Smells: ${rec.summary}`;

/** Why the PR may not open, or [] when the repo is outside the gate, the diff has no code, or the run is recorded and in the body. */
export function smellsProblems(repo: string, head: string, body: string, codeFiles: number, globs: string[] = PR_SMELLS_REPOS): string[] {
  if (codeFiles === 0 || !gateApplies(repo, globs)) return [];
  const rec = recordFor(repo, head);
  if (!rec) return [`needs a recorded smells run and none is recorded for this head commit. Run a report-only smells review (mithril-lite-review or /mithril smells) on the diff, fix what is worth fixing, then: node scripts/pr-smells.ts record --repo ${repo} --summary "<findings, fixed, deliberately left>"`];
  return body.split('\n').some((l) => l.trim() === smellsLine(rec)) ? [] : [`must carry the recorded run on a line of its own: ${smellsLine(rec)}`];
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  const arg = (flag: string): string => { const i = rest.indexOf(flag); return i >= 0 ? (rest[i + 1] ?? '') : ''; };
  const repo = arg('--repo');
  if ((cmd !== 'record' && cmd !== 'show') || !repo) {
    console.error('usage: node scripts/pr-smells.ts record|show --repo <path> [--head <branch>] [--summary "<text>"]');
    return 2;
  }
  try {
    if (cmd === 'record') { console.log(smellsLine(recordSmells(repo, arg('--summary'), arg('--head')))); return 0; }
    const rec = recordFor(repo, arg('--head'));
    if (!rec) { console.error('pr-smells: no smells run is recorded for this head commit'); return 1; }
    console.log(smellsLine(rec));
    return 0;
  } catch (e) { console.error(`pr-smells: ${(e as Error).message}`); return 2; }
}

const isMain = () => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };

if (process.argv[1] && isMain()) process.exit(main(process.argv.slice(2)));
