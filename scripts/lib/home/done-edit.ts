/**
 * Pure text edits for the "What done looks like" section of a vault note: read the section raw, replace it (or add it) and bump the
 * frontmatter date. The section is the heading line up to the next `## ` heading, the same bounds `done.ts` reads, so what the page shows
 * and what an edit replaces are the same lines. No disk access here; `web/done-write.ts` owns the file.
 */
import { createHash } from 'node:crypto';
import { DONE_HEADING } from './done.ts';

export const DONE_TEXT_MAX = 8000;
const HEADING = '## What done looks like';

/** [start, end) of the section's body lines (after the heading, before the next `## `), or null when the heading is absent. */
function bounds(lines: string[]): { at: number; end: number } | null {
  const at = lines.findIndex((l) => DONE_HEADING.test(l));
  if (at === -1) return null;
  const next = lines.slice(at + 1).findIndex((l) => /^## /.test(l));
  return { at, end: next === -1 ? lines.length : at + 1 + next };
}

const split = (text: string): string[] => text.replace(/\r\n?/g, '\n').split('\n');

/** The section's own text without the heading, trimmed of blank lines at both ends; '' when absent or empty. */
export function readDoneSection(note: string): string {
  const lines = split(note);
  const b = bounds(lines);
  return b ? lines.slice(b.at + 1, b.end).join('\n').trim() : '';
}

/** A short digest of the section as it stands, so a save can refuse when the note changed since the editor opened. */
export const doneRev = (note: string): string => createHash('sha1').update(readDoneSection(note)).digest('hex').slice(0, 12);

/** Why `text` may not be written as a section body, or null. A `## ` line would end the section early or add a heading. */
export function doneTextProblem(text: string): string | null {
  if (!text.trim()) return 'Write what done looks like first. An empty definition would delete it.';
  if (text.length > DONE_TEXT_MAX) return `That is longer than ${DONE_TEXT_MAX} characters.`;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return 'Control characters cannot be saved.';
  if (split(text).some((l) => /^## /.test(l))) return 'A line starting with "## " would end this section. Use ### or a list instead.';
  return null;
}

/** `note` with the done section's body replaced by `text` (the heading added at the end when the note has none); everything else is untouched. */
export function replaceDoneSection(note: string, text: string): string {
  const crlf = note.includes('\r\n');
  const lines = split(note);
  const body = split(text.trim());
  const b = bounds(lines);
  let out: string[];
  if (b) {
    const rest = lines.slice(b.end);
    out = [...lines.slice(0, b.at + 1), '', ...body, ...(rest.length ? ['', ...rest] : [''])];
  } else {
    const head = lines.slice();
    while (head.length && head[head.length - 1] === '') head.pop();
    out = [...head, '', HEADING, '', ...body, ''];
  }
  const joined = out.join('\n');
  return crlf ? joined.replace(/\n/g, '\r\n') : joined;
}

/** The frontmatter's `updated:` (or `last-updated:`) set to `day`; the note unchanged when it has neither. Line endings are kept. */
export function bumpUpdated(note: string, day: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---(?=\r?\n|$)/.exec(note);
  if (!m) return note;
  const fm = m[0].replace(/^((?:last-)?updated:[ \t]*)(["']?)\d{4}-\d{2}-\d{2}\2/m, (_all, k: string, q: string) => `${k}${q}${day}${q}`);
  return fm + note.slice(m[0].length);
}
