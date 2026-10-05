/**
 * What the user writes into the status page by hand, and how the generator keeps it.
 *
 * Three kinds of edit, found by line shape in the page text:
 *   - an answer: a `> answer: <text>` line under an ask line (`- [ ] \`id\` ...`, or an ask's table row);
 *     `> answer <id>: <text>` names the ask itself, wherever it stands
 *   - a tick: `- [x]` on an ask line
 *   - a priorities edit: the list items under `## Today's priorities`
 * An edit is unprocessed while it differs from the baseline: the page as the status watcher last saw it (seen.ts).
 * The generator carries unprocessed edits into the page it writes, so regenerating never clobbers an edit the
 * watcher has not reported yet. Pure: files are read and written by generate.ts and the status-watch event type.
 */

/** The fields a person can change. `priorities` is null when the page has no priorities section. */
export interface InlineFields {
  answers: Record<string, string>;
  ticks: Record<string, boolean>;
  priorities: string[] | null;
}

export const PRIORITIES_HEADING = "## Today's priorities";
const ID = '[a-z0-9]{4,6}';
const ASK_LINE = new RegExp(`^- \\[([ xX])\\] \`(${ID})\``);
const TABLE_ROW = new RegExp(`^\\| \`(${ID})\` \\|`);
const ANSWER = new RegExp(`^\\s*>\\s*answer(?:\\s+\`?(${ID})\`?)?\\s*:\\s?(.*)$`, 'i');
const QUOTE = /^\s*>\s?(.*)$/;
const LIST_ITEM = /^\s*(?:[-*]|\d+[.)])\s+(\S.*?)\s*$/;
/** The per-stream counts the generator appends to a priority: not the user's words, so never compared. */
const COUNTS = /\s+_\[(?:([^:\]]+):)?[^\]]*\]_\s*$/;

/** A priority line as the user would set it: the words, plus ` | Stream` when the generator's counts suffix names one (so a reorder keeps the mapping). */
function priorityText(raw: string): string {
  const stream = raw.match(COUNTS)?.[1]?.trim();
  const text = squash(raw.replace(COUNTS, ''));
  return stream ? `${text} | ${stream}` : text;
}

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** The priorities block (lines between the priorities heading and the next `## `), or null if the page has none. */
export function prioritiesBlock(lines: string[]): { start: number; end: number } | null {
  const h = lines.findIndex((l) => l.trim() === PRIORITIES_HEADING);
  if (h === -1) return null;
  let end = lines.findIndex((l, i) => i > h && /^## /.test(l));
  if (end === -1) end = lines.length;
  return { start: h + 1, end };
}

/** Every answer, tick and priority in a page. */
export function extractFields(page: string): InlineFields {
  const lines = page.split('\n');
  const fields: InlineFields = { answers: {}, ticks: {}, priorities: null };
  let current = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (/^#{1,6} /.test(line)) { current = ''; continue; }
    const ask = line.match(ASK_LINE);
    if (ask) { current = ask[2] as string; fields.ticks[current] = ask[1] !== ' '; continue; }
    const row = line.match(TABLE_ROW);
    if (row) { current = row[1] as string; continue; }
    const ans = line.match(ANSWER);
    if (!ans) continue;
    const id = ans[1] ?? current;
    const parts = [ans[2] ?? ''];
    while (QUOTE.test(lines[i + 1] ?? '') && !ANSWER.test(lines[i + 1] as string)) parts.push((lines[++i] as string).match(QUOTE)?.[1] ?? '');
    const text = squash(parts.join(' '));
    if (id && text) fields.answers[id] = text;
  }
  const block = prioritiesBlock(lines);
  if (block) fields.priorities = lines.slice(block.start, block.end).flatMap((l) => (LIST_ITEM.test(l) ? [priorityText(l.match(LIST_ITEM)?.[1] ?? '')] : []));
  return fields;
}

/** What differs from the baseline: answers new or changed, asks newly ticked, and priorities when they changed. */
export interface Unprocessed { answers: Record<string, string>; ticks: string[]; priorities: string[] | null }

/**
 * Edits in `current` the baseline has not reported. `seenPriorities` is the list as last rendered or reported (it
 * changes when the generator writes a new list, which is not an edit); undefined means nothing is known, so no edit is claimed.
 */
export function unprocessed(current: InlineFields, baseline: InlineFields | null, seenPriorities: string[] | null | undefined): Unprocessed {
  const base = baseline ?? { answers: {}, ticks: {}, priorities: null };
  const answers = Object.fromEntries(Object.entries(current.answers).filter(([id, text]) => base.answers[id] !== text));
  const ticks = Object.entries(current.ticks).filter(([id, on]) => on && !base.ticks[id]).map(([id]) => id);
  const seen = seenPriorities === undefined ? base.priorities : seenPriorities;
  const edited = current.priorities !== null && seen !== null && JSON.stringify(current.priorities) !== JSON.stringify(seen);
  return { answers, ticks, priorities: edited ? current.priorities : null };
}

export const countUnprocessed = (u: Unprocessed): number => Object.keys(u.answers).length + u.ticks.length + (u.priorities ? 1 : 0);

const replyLines = (id: string, text: string, ticked: boolean, note = ''): string[] => [`- [${ticked ? 'x' : ' '}] \`${id}\`${note}`, `  > answer: ${text}`];

/**
 * `page` with the unprocessed edits written back in: answers into the stubs of their asks, ticks onto their boxes, the
 * user's priorities block in place of the generated one. An edit whose ask is no longer on the board goes under a
 * final `## Unprocessed answers` section, so it stays visible until the watcher reports it.
 */
export function carryInline(page: string, u: Unprocessed, currentPage: string): string {
  if (!countUnprocessed(u)) return page;
  const lines = page.split('\n');
  const orphans: string[] = [];
  for (const id of new Set([...Object.keys(u.answers), ...u.ticks])) {
    const at = lines.findIndex((l) => l.match(ASK_LINE)?.[2] === id);
    const text = u.answers[id] ?? '';
    const ticked = u.ticks.includes(id);
    if (at === -1) { orphans.push(...replyLines(id, text, ticked, ' (no longer on the board)')); continue; }
    if (ticked) lines[at] = (lines[at] as string).replace('- [ ]', '- [x]');
    if (text) {
      const stub = /^\s*>\s*answer\s*:\s*$/i.test(lines[at + 1] ?? '');
      if (stub) lines[at + 1] = `  > answer: ${text}`; else lines.splice(at + 1, 0, `  > answer: ${text}`);
    }
  }
  if (u.priorities) {
    const mine = prioritiesBlock(lines);
    const theirs = prioritiesBlock(currentPage.split('\n'));
    if (mine && theirs) lines.splice(mine.start, mine.end - mine.start, ...currentPage.split('\n').slice(theirs.start, theirs.end));
  }
  const body = lines.join('\n');
  return orphans.length ? `${body.replace(/\n*$/, '\n')}\n## Unprocessed answers\n\n${orphans.join('\n')}\n` : body;
}
