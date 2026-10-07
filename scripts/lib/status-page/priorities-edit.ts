/**
 * Editing `priorities.md` in place, for the Podium's reorder, add and delete.
 *
 * The file is the source of truth and the user edits it by hand too, so nothing here keeps a copy: each edit reads the file,
 * applies one operation, and writes the whole file back through a temp file and a rename. Lines the editor does not own (a
 * heading, a comment, prose) stay exactly where they are; an item line keeps its own bullet, indent and checkbox as it moves.
 * An operation names the text it expects at the index it acts on, so a list that was edited by hand since the page was drawn
 * is refused as a conflict instead of acting on the wrong line. The cap (`max`) refuses an add to a full list; a list already
 * over it may still be reordered and shortened.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATE_LINE, ITEM_LINE, PRIORITIES_FILE, parsePriorities, parsePriority } from './priorities.ts';
import type { Priority } from './priorities.ts';

export type Edit =
  | { op: 'move'; from: number; to: number; text: string }
  | { op: 'add'; text: string; stream?: string }
  | { op: 'delete'; index: number; text: string };

/** `invalid` text cannot be stored, `conflict` the list is not what the caller saw, `cap` it is full, `busy` the file kept changing under the edit. */
export type RefusalCode = 'invalid' | 'conflict' | 'cap' | 'busy';
export class EditRefused extends Error {
  readonly code: RefusalCode;
  constructor(code: RefusalCode, message: string) { super(message); this.name = 'EditRefused'; this.code = code; }
}

export interface EditResult { date: string; items: Priority[]; over: boolean; summary: string }
export interface EditOptions {
  max: number;
  /** Called between the read and the final re-check; a test uses it to play a hand edit landing in that window. */
  afterRead?: () => void;
}

export const MAX_TEXT = 200;
export const MAX_STREAM = 40;
const TRIES = 3;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f<>]+$/;
const SAFE_STREAM = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;
const refuse = (code: RefusalCode, message: string): never => { throw new EditRefused(code, message); };

/** One priority's line body (`text` or `text | Stream`). */
const bodyOf = (p: Priority): string => `${p.text}${p.stream ? ` | ${p.stream}` : ''}`;

/**
 * The priority a caller asked to add, normalised, or a refusal. The text must survive a trip through the file unchanged (no ` | `
 * inside, no leading checkbox), stay one short line, and carry no control character or angle bracket, so nothing it holds can be
 * read as markup by the Markdown page.
 */
export function checkPriority(rawText: string, rawStream: string | undefined): Priority {
  if (/[\u0000-\u001f\u007f]/.test(rawText)) return refuse('invalid', 'a priority is one line of plain text: no control characters');
  const text = rawText.replace(/\s+/g, ' ').trim();
  if (!text || text.length > MAX_TEXT) return refuse('invalid', `a priority is 1 to ${MAX_TEXT} characters`);
  if (!SAFE_TEXT.test(text)) return refuse('invalid', 'a priority is plain text: no angle brackets');
  if (rawStream !== undefined && (rawStream.length > MAX_STREAM || !SAFE_STREAM.test(rawStream) || rawStream !== rawStream.trim())) return refuse('invalid', `a stream is up to ${MAX_STREAM} letters, digits, spaces, dots, dashes or underscores`);
  const p: Priority = rawStream ? { text, stream: rawStream } : { text };
  const line = ITEM_LINE.exec(`- ${bodyOf(p)}`);
  const back = line ? parsePriority(line[5] ?? '') : null;
  if (!back || back.text !== p.text || back.stream !== p.stream) return refuse('invalid', 'that text would not read back the same from the file (a " | " or a leading checkbox)');
  return p;
}

interface Slot { index: number; indent: string; marker: string; gap: string; check: string; body: string }

/** The item lines of a file, in order, with where each sits. */
function slotsOf(lines: string[]): Slot[] {
  const out: Slot[] = [];
  lines.forEach((line, index) => {
    const m = ITEM_LINE.exec(line);
    if (m) out.push({ index, indent: m[1] ?? '', marker: m[2] ?? '-', gap: m[3] ?? ' ', check: m[4] ?? '', body: m[5] ?? '' });
  });
  return out;
}

/** An item line for entry number `n` (0-based) in the style of `slot`: numbered markers are renumbered, bullets are kept. */
function lineFor(slot: Slot, n: number, entry: { check: string; body: string }): string {
  const numbered = /^\d+([.)])$/.exec(slot.marker);
  const marker = numbered ? `${n + 1}${numbered[1]}` : slot.marker;
  return `${slot.indent}${marker}${slot.gap}${entry.check}${entry.body}`;
}

/** Applies `edit` to the file text: the new text and a one-line summary, or a refusal. Pure. */
function plan(raw: string, today: string, edit: Edit, max: number): { text: string; summary: string } {
  const lines = raw === '' ? [] : raw.split('\n');
  const isToday = parsePriorities(raw).date === today;
  const slots = slotsOf(lines);
  let entries = isToday ? slots.map((s) => ({ check: s.check, body: s.body })) : [];
  const at = (i: number): Priority | undefined => (Number.isInteger(i) && entries[i] ? parsePriority(entries[i]?.body ?? '') : undefined);
  const stale = 'the list on disk is not what this page showed; it has been reloaded';
  let summary = '';
  if (edit.op === 'add') {
    const p = checkPriority(edit.text, edit.stream);
    if (entries.length >= max) return refuse('cap', `Priorities are full (${entries.length} of ${max}): remove one first.`);
    entries.push({ check: '', body: bodyOf(p) });
    summary = `added priority ${entries.length}: ${p.text}`;
  } else if (edit.op === 'delete') {
    if (at(edit.index)?.text !== edit.text) return refuse('conflict', stale);
    entries.splice(edit.index, 1);
    summary = `removed priority ${edit.index + 1}: ${edit.text}`;
  } else {
    if (at(edit.from)?.text !== edit.text || !Number.isInteger(edit.to) || edit.to < 0 || edit.to >= entries.length) return refuse('conflict', stale);
    const [moved] = entries.splice(edit.from, 1);
    entries.splice(edit.to, 0, moved ?? { check: '', body: '' });
    summary = `moved priority ${edit.from + 1} to ${edit.to + 1}: ${edit.text}`;
  }
  const last = slots[slots.length - 1];
  const style = last ?? { index: -1, indent: '', marker: '-', gap: ' ', check: '', body: '' };
  const out: string[] = [];
  let k = 0;
  let afterLast = -1;
  let dateAt = -1;
  lines.forEach((line, i) => {
    const slot = slots.find((s) => s.index === i);
    if (slot) {
      if (k < entries.length) { out.push(lineFor(slot, k, entries[k] ?? { check: '', body: '' })); k += 1; afterLast = out.length; }
    } else if (DATE_LINE.test(line)) {
      dateAt = out.length;
      out.push(line.replace(/^(\s*date\s*:\s*)\S+/i, `$1${today}`));
    } else out.push(line);
  });
  const extra = entries.slice(k).map((e, j) => lineFor(style, k + j, e));
  if (dateAt === -1) { out.unshift(`date: ${today}`); dateAt = 0; if (afterLast !== -1) afterLast += 1; }
  out.splice(afterLast === -1 ? dateAt + 1 : afterLast, 0, ...extra);
  if (out[out.length - 1] !== '') out.push('');
  return { text: out.join('\n'), summary };
}

/** Writes `text` over `path` through a temp file beside it and a rename, keeping the file's mode and following a symlink. */
function writeAtomic(path: string, text: string): void {
  const target = existsSync(path) ? realpathSync(path) : path;
  const tmp = `${target}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    writeFileSync(tmp, text, { mode: existsSync(target) ? statSync(target).mode & 0o777 : 0o644 });
    renameSync(tmp, target);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw e;
  }
}

const readRaw = (path: string): string => (existsSync(path) ? readFileSync(path, 'utf8') : '');

/**
 * Reads the file, applies one edit and writes it back. If the file changed between the read and the write (a hand edit
 * saved in that window) the edit is planned again against the new text, up to a few times, before it gives up as `busy`.
 */
export function editPriorities(statusDir: string, today: string, edit: Edit, o: EditOptions): EditResult {
  const path = join(statusDir, PRIORITIES_FILE);
  for (let attempt = 0; attempt < TRIES; attempt += 1) {
    const raw = readRaw(path);
    const { text, summary } = plan(raw, today, edit, o.max);
    o.afterRead?.();
    if (readRaw(path) !== raw) continue;
    writeAtomic(path, text);
    const { date, items } = parsePriorities(text);
    return { date, items, over: items.length > o.max, summary };
  }
  return refuse('busy', 'priorities.md kept changing while it was being saved; try again');
}
