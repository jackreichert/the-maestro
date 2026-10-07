/**
 * PR LINKS: turns `{{file:<path>}}` and `{{file:<path>#R42}}` tokens in a PR body into links to that file in
 * the PR's "Files changed" tab, so a reviewer lands on the hunk the Reviewer guide points at. The PR number is not
 * known until the PR exists, so authors write tokens and `pr-open.ts` (or `pr-guide-links.ts` for an existing PR)
 * expands them afterwards. See reference/git.md#reviewer-guide-links.
 *
 * Anchor format: `<pr url>/files#diff-<sha256 hex of the file path>`. The hash was checked against a real PR page
 * (the hex of a changed path appears as a diff id on the rendered files page). A line suffix (`R42`) was NOT
 * verified, so a token with a line links to the file and shows the line as text (`path:42`).
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOKEN = /\{\{file:([^#}\s]+)(?:#([RL])(\d+))?\}\}/g;

/** The anchor id GitHub gives a file's diff on the Files changed tab. */
export const diffAnchor = (path: string): string => `diff-${createHash('sha256').update(path).digest('hex')}`;

/** Result of expanding a body: the new text, and the token paths that are not in the PR's diff. */
export interface Expansion { body: string; unknown: string[]; expanded: number }

/** Replaces each file token with a markdown link; a path outside `changed` is left as it is and listed in `unknown`. Re-running on an expanded body changes nothing. */
export function expandTokens(body: string, prUrl: string, changed: string[]): Expansion {
  const known = new Set(changed);
  const unknown: string[] = [];
  let expanded = 0;
  const out = body.replace(TOKEN, (token, path: string, _side: string | undefined, line: string | undefined) => {
    if (!known.has(path)) { unknown.push(path); return token; }
    expanded += 1;
    return `[${path}${line ? `:${line}` : ''}](${prUrl.replace(/\/$/, '')}/files#${diffAnchor(path)})`;
  });
  return { body: out, unknown: [...new Set(unknown)], expanded };
}

/** The token paths in a body, in order of appearance. */
export const tokenPaths = (body: string): string[] => [...body.matchAll(TOKEN)].map((m) => m[1]);

const gh = (): string => process.env.MAESTRO_GH_BIN || 'gh';

/**
 * Expands the tokens in a PR's body and writes it back with `gh pr edit --body-file`. Returns an error message
 * when a token names a path outside the diff (nothing is written then), otherwise '' (also when there was nothing to do).
 * `body` is the text to expand; omit it to read the PR's current body.
 */
export function linkPr(repo: string, pr: number, body?: string): string {
  const view = spawnSync(gh(), ['pr', 'view', String(pr), '--json', 'url,body,files'], { cwd: repo, encoding: 'utf8' });
  if (view.status !== 0) return `gh pr view ${pr} failed: ${view.stderr.trim()}`;
  const info = JSON.parse(view.stdout) as { url: string; body: string; files: { path: string }[] };
  const result = expandTokens(body ?? info.body, info.url, info.files.map((f) => f.path));
  if (result.unknown.length) return `these {{file:...}} paths are not in the PR's diff, so nothing was linked: ${result.unknown.join(', ')}`;
  if (!result.expanded) return '';
  const dir = mkdtempSync(join(tmpdir(), 'pr-links-'));
  try {
    const file = join(dir, 'body.md');
    writeFileSync(file, result.body);
    const edit = spawnSync(gh(), ['pr', 'edit', String(pr), '--body-file', file], { cwd: repo, encoding: 'utf8' });
    return edit.status === 0 ? '' : `gh pr edit ${pr} failed: ${edit.stderr.trim()}`;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
