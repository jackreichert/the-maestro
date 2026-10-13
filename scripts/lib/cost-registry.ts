/**
 * The experiment registry: a markdown table inside a notes file, one row per cost experiment. This module reads rows out of the text
 * and (for the daily proposer) adds a row to it. It touches no file, so callers decide where the text lives.
 */

export interface RegistryRow { id: string; practice: string; hypothesis: string; metric: string; threshold: string; start: string; status: string; result: string }

const COLUMNS = ['id', 'practice', 'hypothesis', 'metric', 'threshold', 'start', 'status', 'result'] as const;
const HEADER = /^\|\s*Id\s*\|\s*Practice\s*\|/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The id of the experiment proposed for `date` (YYYY-MM-DD). One id per day is what makes writing a row idempotent. */
export const experimentId = (date: string): string => `cx-${date}`;

const cells = (line: string): string[] => line.split('|').slice(1, -1).map((c) => c.trim());

/** Where the registry table starts and ends in `lines`: the header index and the index after its last row, or null when there is no table. */
function tableSpan(lines: string[]): { header: number; end: number } | null {
  const header = lines.findIndex((l) => HEADER.test(l));
  if (header < 0) return null;
  let end = header + 2;   // the header and its alignment row
  while (end < lines.length && lines[end]?.trim().startsWith('|')) end += 1;
  return { header, end };
}

/** Every row of the registry table, in file order. An absent table is no rows. */
export function parseRegistry(text: string): RegistryRow[] {
  const lines = text.split('\n');
  const span = tableSpan(lines);
  if (!span) return [];
  return lines.slice(span.header + 2, span.end).map(cells).filter((c) => c.length >= COLUMNS.length && c[0]).map((c) => Object.fromEntries(COLUMNS.map((k, i) => [k, c[i] ?? ''])) as unknown as RegistryRow);
}

/** A cell as it must be written: one line, no pipe (a pipe would split the cell). */
const cell = (s: string): string => s.replace(/\s+/g, ' ').replace(/\|/g, '/').trim() || '-';

/**
 * `text` with `row` added as the last registry row, or `text` unchanged when a row with that id already exists (so a rerun the same day
 * adds nothing). Null when the text has no registry table: the caller must say so rather than write one blind.
 */
export function addRegistryRow(text: string, row: RegistryRow): string | null {
  const lines = text.split('\n');
  const span = tableSpan(lines);
  if (!span) return null;
  // Any line in the table whose first cell is the id counts, even a row too short to parse: a hand-edit must not allow a second row.
  if (lines.slice(span.header + 2, span.end).some((l) => cells(l)[0] === row.id)) return text;
  lines.splice(span.end, 0, `| ${COLUMNS.map((k) => cell(row[k])).join(' | ')} |`);
  return lines.join('\n');
}

export const isDay = (s: string): boolean => DAY.test(s);
