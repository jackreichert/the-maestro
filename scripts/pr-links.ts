/**
 * PR LINKS: turns `{{file:<path>}}` tokens in a PR body into links to that file in the PR's "Files changed" tab,
 * so a reviewer lands on the hunk the Reviewer guide points at. A token may carry a line anchor:
 * `{{file:path#R25}}` (one new-side line), `{{file:path#R25-R31}}` (a new-side range) or `{{file:path#L10-L12}}`
 * (old side). The PR number is not known until the PR exists, so authors write tokens and `pr-open.ts` (or
 * `pr-guide-links.ts` for an existing PR) expands them afterwards. See reference/git.md#reviewer-guide-links.
 *
 * Link format: `<pr url>/changes#diff-<sha256 hex of the path as in the diff><side><start>-<side><end>`, checked
 * against a real private-repo PR link (the hex equals sha256 of a changed path, the suffix was `R25-R31`). A line
 * outside the diff's hunks may not expand or scroll; link ranges inside changed hunks (`pr-guide-links.ts --hunks`).
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOKEN = /\{\{file:([^#}]+?)(?:#([^}]*))?\}\}/g;

/** A parsed line anchor: one side (`R` new, `L` old) and an inclusive line range. */
export interface Anchor { side: 'R' | 'L'; start: number; end: number }

/** Parses `R25`, `R25-R31` or `L10-L12`; returns an Anchor, or a message saying what is wrong with it. */
export function parseAnchor(raw: string): Anchor | string {
  const m = /^([RL])(\d+)(?:-([RL])(\d+))?$/.exec(raw);
  if (!m) return `"#${raw}" is not a line anchor; use #R25, #R25-R31 or #L10-L12`;
  const start = Number(m[2]);
  const end = m[4] === undefined ? start : Number(m[4]);
  if (m[3] !== undefined && m[3] !== m[1]) return `"#${raw}" mixes sides; a range stays on R (new) or L (old)`;
  if (start < 1) return `"#${raw}" starts at line 0; lines start at 1`;
  if (start > end) return `"#${raw}" runs backwards; the start must not be after the end`;
  return { side: m[1] as 'R' | 'L', start, end };
}

/** The `R25-R31` suffix GitHub reads after the diff id. */
const anchorSuffix = (a: Anchor): string => `${a.side}${a.start}` + (a.end === a.start ? '' : `-${a.side}${a.end}`);

/** Any `{{file:` left in a body: after expansion it means a token that could not be read, which must not slip through. */
export const hasLooseToken = (body: string): boolean => /\{\{file:/.test(body);

/** The anchor id GitHub gives a file's diff on the Files changed tab. */
export const diffAnchor = (path: string): string => `diff-${createHash('sha256').update(path).digest('hex')}`;

/** Result of expanding a body: the new text, and the token paths that are not in the PR's diff. */
export interface Expansion { body: string; unknown: string[]; invalid: string[]; expanded: number }

/** Replaces each file token with a markdown link; a path outside `changed` or a malformed anchor leaves the token as it is and is listed in `unknown` or `invalid`. Re-running on an expanded body changes nothing. */
export function expandTokens(body: string, prUrl: string, changed: string[]): Expansion {
  const known = new Set(changed);
  const unknown: string[] = [];
  const invalid: string[] = [];
  let expanded = 0;
  const out = body.replace(TOKEN, (token, path: string, raw: string | undefined) => {
    const anchor = raw === undefined ? undefined : parseAnchor(raw);
    if (typeof anchor === 'string') { invalid.push(`${path}: ${anchor}`); return token; }
    if (!known.has(path)) { unknown.push(path); return token; }
    expanded += 1;
    const text = anchor ? `${path}:${anchor.start}${anchor.end === anchor.start ? '' : `-${anchor.end}`}` : path;
    return `[${text}](${prUrl.replace(/\/$/, '')}/changes#${diffAnchor(path)}${anchor ? anchorSuffix(anchor) : ''})`;
  });
  return { body: out, unknown: [...new Set(unknown)], invalid, expanded };
}

/** One message per malformed token anchor in a body (empty when every anchor is valid). */
export const tokenProblems = (body: string): string[] =>
  [...body.matchAll(TOKEN)].flatMap((m) => {
    const a = m[2] === undefined ? undefined : parseAnchor(m[2]);
    return typeof a === 'string' ? [`${m[1]}: ${a}`] : [];
  });

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
  let info: { url: string; body: string; files: { path: string }[] };
  try { info = JSON.parse(view.stdout); } catch { return `gh pr view ${pr} returned something that is not JSON`; }
  const result = expandTokens(body ?? info.body, info.url, info.files.map((f) => f.path));
  if (result.invalid.length) return `these {{file:...}} anchors are malformed, so nothing was linked: ${result.invalid.join('; ')}`;
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
