/**
 * PR HUNKS: the new-side line ranges a diff changes, per file, so a Reviewer guide can link `{{file:path#R25-R31}}`
 * to lines that are inside a changed hunk (a line outside the diff may not expand or scroll on the Files changed tab).
 * Reads a unified diff of any context size (`gh pr diff`, `git diff -U0`); a range is a run of consecutive added
 * lines, so context lines never widen it. A pure deletion has no new-side line and yields no range.
 */
import { spawnSync } from 'node:child_process';

/** An inclusive new-side line range. */
export interface Range { start: number; end: number }

/** `"b/caf\303\251.ts"` style paths git quotes when they hold non-ASCII bytes. */
function unquote(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  const bytes: number[] = [];
  const esc: Record<string, number> = { n: 10, t: 9, '"': 34, '\\': 92 };
  const inner = p.slice(1, -1);
  for (let i = 0; i < inner.length; i += 1) {
    const c = inner[i];
    if (c !== '\\') { bytes.push(...Buffer.from(c)); continue; }
    const oct = /^[0-7]{3}/.exec(inner.slice(i + 1));
    if (oct) { bytes.push(parseInt(oct[0], 8)); i += 3; } else { bytes.push(esc[inner[i + 1]] ?? inner.charCodeAt(i + 1)); i += 1; }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Changed new-side ranges per file path (the path as it is on the new side), in file and line order. */
export function changedRanges(diff: string): Map<string, Range[]> {
  const out = new Map<string, Range[]>();
  let path = '';
  let line = 0;
  let inHunk = false;
  let run: Range | null = null;
  const close = (): void => { if (run && path) out.get(path)!.push(run); run = null; };
  for (const text of diff.split('\n')) {
    if (text.startsWith('diff --git ')) { close(); inHunk = false; path = ''; continue; }
    if (!inHunk && text.startsWith('+++ ')) {
      const p = unquote(text.slice(4).replace(/\t.*$/, ''));
      path = p === '/dev/null' ? '' : p.replace(/^b\//, '');
      if (path && !out.has(path)) out.set(path, []);
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (h) { close(); inHunk = true; line = Number(h[1]); continue; }
    if (!inHunk) continue;
    if (text.startsWith('+')) { run = run ? { start: run.start, end: line } : { start: line, end: line }; line += 1; }
    else if (text.startsWith('-') || text.startsWith('\\')) close();
    else { close(); line += 1; }
  }
  close();
  for (const [p, r] of out) if (!r.length) out.delete(p);
  return out;
}

/** `{{file:path#R25-R31}}` lines, ready to paste into a guide; `only` limits them to one path. */
export function hunkTokens(ranges: Map<string, Range[]>, only?: string): string[] {
  return [...ranges].filter(([p]) => !only || p === only).flatMap(([p, rs]) =>
    rs.map((r) => `{{file:${p}#R${r.start}${r.end === r.start ? '' : `-R${r.end}`}}}`));
}

/** Runs `gh pr diff <pr>` in `repo`; returns the diff, or an error message. */
export function prDiff(repo: string, pr: number): { diff: string } | { error: string } {
  const r = spawnSync(process.env.MAESTRO_GH_BIN || 'gh', ['pr', 'diff', String(pr), '--color=never'], { cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? { diff: r.stdout } : { error: `gh pr diff ${pr} failed: ${(r.stderr || '').trim()}` };
}
