/**
 * ONE PR PER TICKET: the check pr-open.ts runs before it creates a PR. Given the new PR's branch, base, title and body, and the
 * repo's other open PRs, it says whether the PR may open (reference/git.md, "One PR per ticket").
 *
 * The ticket key is the first `tracker_key_pattern` match in the branch name, else in the title. Another open PR "carries" the
 * key when its branch or title holds the same key as a whole token (MAESTRO-35 does not match MAESTRO-350). Outcomes:
 *   - pass: no key, no other PR with the key, a release head (`one_pr_exempt_heads`), or a twin;
 *   - warn: a stack, meaning the new base is the head branch of another open PR with the key. Allowed, with a nudge to cut a
 *     smaller ticket when a slice is its own unit of work;
 *   - fail: an independent second PR under the key.
 * A twin is a PR with the same key and the same head branch on a different base, or on a different protected base when the new
 * body names it on a `Twin: #N` (or `Twin: <PR url>`) line. It is the same change, promoted through the integration and release-candidate branches, so it counts as one PR.
 *
 * Pure except `listOpenPrs`, which asks gh (`gh pr list`) and is injected in tests. A gh failure throws; pr-open.ts refuses on it.
 */
import { spawnSync } from 'node:child_process';
import { toolCommand } from './lib/tool-bin.ts';
import { globToRegExp } from './pr-size.ts';

export interface OpenPr { number: number; title: string; headRefName: string; baseRefName: string; url: string }
export interface NewPr { branch: string; base: string; title: string; body: string }
export interface KeyRules { pattern: string; exemptHeads: string[]; protectedBases: string[] }
export type KeyVerdict = { status: 'pass' | 'warn' | 'fail'; key: string; message: string };

/** Every tracker key in `text`, in order, matched with the pattern's own case (the default is upper-case, so `utf-8` in a branch is not a key). */
export const keysIn = (text: string, pattern: string): string[] => [...text.matchAll(new RegExp(pattern, 'g'))].map((m) => m[0]);

/** The ticket key a PR is for: the branch name's first key, else the title's. */
export const ticketKey = (branch: string, title: string, pattern: string): string => keysIn(branch, pattern)[0] ?? keysIn(title, pattern)[0] ?? '';

const matches = (globs: string[], name: string): boolean => globs.some((g) => globToRegExp(g).test(name));
const carries = (pr: OpenPr, key: string, pattern: string): boolean => ticketKey(pr.headRefName, pr.title, pattern) === key;
const links = (body: string, pr: OpenPr): boolean => new RegExp(`^\\s*(?:[-*]\\s*)?Twin:\\s*(?:\\S*/pull/${pr.number}(?!\\d)|#${pr.number}(?!\\d))`, 'im').test(body);

/** Whether the new PR may open given the repo's other open PRs. */
export function checkOnePerTicket(pr: NewPr, open: OpenPr[], rules: KeyRules): KeyVerdict {
  const key = ticketKey(pr.branch, pr.title, rules.pattern);
  if (!key) return { status: 'pass', key, message: 'one-PR-per-ticket: no ticket key in the branch or title, so the rule was not checked.' };
  if (matches(rules.exemptHeads, pr.branch)) return { status: 'pass', key, message: `one-PR-per-ticket: ${pr.branch} is exempt (one_pr_exempt_heads).` };
  const others = open.filter((o) => !(o.headRefName === pr.branch && o.baseRefName === pr.base) && !matches(rules.exemptHeads, o.headRefName) && carries(o, key, rules.pattern));
  // A stack is a chain of open PRs, each based on the previous one's head: the PRs this one sits on, and the ones sitting on it.
  const mates = new Set<OpenPr>();
  for (let base = pr.base; ;) {
    const below = open.find((o) => o.headRefName === base && !mates.has(o));
    if (!below) break;
    mates.add(below);
    base = below.baseRefName;
  }
  for (const heads = [pr.branch]; heads.length;) {
    for (const above of open.filter((o) => o.baseRefName === heads[0] && !mates.has(o))) { mates.add(above); heads.push(above.headRefName); }
    heads.shift();
  }
  const stackMates = others.filter((o) => mates.has(o));
  const isTwin = (o: OpenPr): boolean => o.baseRefName !== pr.base && !mates.has(o)
    && (o.headRefName === pr.branch || (matches(rules.protectedBases, o.baseRefName) && matches(rules.protectedBases, pr.base) && links(pr.body, o)));
  const rivals = others.filter((o) => !mates.has(o) && !isTwin(o));
  if (rivals.length) {
    const list = rivals.map((o) => `#${o.number} (${o.headRefName} -> ${o.baseRefName}) ${o.url}`).join('; ');
    return { status: 'fail', key, message: `one-PR-per-ticket: refused, ${key} already has an open PR: ${list}. The rule is one PR per ticket: if this is a separate unit of work, file a smaller ticket and use its key. A develop/staging twin is the same change, so open it from the same head branch or add a \`Twin: #N\` line to the body; otherwise add the work to the existing PR.` };
  }
  if (stackMates.length) return { status: 'warn', key, message: `one-PR-per-ticket: warning, this PR is stacked under ${key} on #${stackMates[0].number}; if a slice is a separate unit of work, give it its own smaller ticket.` };
  return { status: 'pass', key, message: `one-PR-per-ticket: ${key} has no other open PR (twins excepted).` };
}

/** The repo's open PRs through gh, run in `repo` (so gh resolves its origin). Throws when gh fails or answers something unreadable. */
export function listOpenPrs(repo: string, env: NodeJS.ProcessEnv = process.env): OpenPr[] {
  const [cmd, args] = toolCommand('gh', ['pr', 'list', '--state', 'open', '--limit', '500', '--json', 'number,title,headRefName,baseRefName,url'], env);
  const r = spawnSync(cmd, args, { cwd: repo, encoding: 'utf8', env });
  if (r.status !== 0) throw new Error(`gh pr list failed: ${(r.stderr || '').trim() || `exit ${r.status}`}`);
  try {
    const list = JSON.parse(r.stdout) as unknown;
    if (!Array.isArray(list)) throw new Error('not a list');
    return list as OpenPr[];
  } catch (e) { throw new Error(`gh pr list gave unreadable output: ${(e as Error).message}`); }
}
