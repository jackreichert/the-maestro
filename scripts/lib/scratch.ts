/**
 * SCRATCH TRIAGE: lists the files in <scripts_dir>/scratch with a proposal for each. Propose only:
 * nothing here moves, edits or deletes a file.
 *
 * Heuristic (the thresholds are constants below, documented in README.md):
 *   idle   = whole days since the file was last modified
 *   uses   = ledger rows whose text names the file
 *   promote          uses >= 2 and idle >= PROMOTE_MIN_IDLE_DAYS   (it keeps coming back: make it a helper)
 *   delete-candidate idle > DELETE_IDLE_DAYS                       (nobody has touched it)
 *   keep             everything else
 */
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const PROMOTE_MIN_IDLE_DAYS = 3;
export const PROMOTE_MIN_USES = 2;
export const DELETE_IDLE_DAYS = 14;
const DAY_MS = 86400000;
const HEADER_BYTES = 2000;

/** The purpose line: the first comment line of the header, comment marker stripped. Empty if none. */
export function headerPurpose(text: string): string {
  let inBlock = false;
  for (const raw of text.split('\n').slice(0, 8)) {
    const line = raw.trim();
    if (!line || line.startsWith('#!')) continue;
    const m: string[] | null = line.match(/^(?:#|\/\/|--|\/\*+|\*)\s?(.*?)(?:\*\/)?$/) ?? (inBlock ? [line, line] : null);
    if (!m) return '';
    const body = m[1] ?? '';
    // A bare opening delimiter (`/*`, `/**`) or a lone closing one carries no text: read on.
    if (!body.trim() && /^\/\*|^\*\/$/.test(line)) {
      inBlock = !line.endsWith('*/');
      continue;
    }
    return body.trim();
  }
  return '';
}

/** `promote`, `delete-candidate` or `keep` for one file. */
export function propose({ idleDays, uses }: { idleDays: number; uses: number }): 'promote' | 'delete-candidate' | 'keep' {
  if (uses >= PROMOTE_MIN_USES && idleDays >= PROMOTE_MIN_IDLE_DAYS) return 'promote';
  if (idleDays > DELETE_IDLE_DAYS) return 'delete-candidate';
  return 'keep';
}

/** At most the first HEADER_BYTES of a file as text, read without loading the rest. */
function readHead(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(HEADER_BYTES);
    return buf.toString('utf8', 0, readSync(fd, buf, 0, HEADER_BYTES, 0));
  } finally {
    closeSync(fd);
  }
}

/** Rows for every regular file in <shelf>/scratch, oldest first. `ledgerTexts` is the text of the ledger rows to count uses in. */
export interface ScratchRow { name: string; idleDays: number; uses: number; purpose: string; proposal: ReturnType<typeof propose> }

export function scratchRows(shelf: string, ledgerTexts: string[] = [], now: number = Date.now()): ScratchRow[] {
  const dir = join(shelf, 'scratch');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith('.'))
    .map((e) => {
      const path = join(dir, e.name);
      const idleDays = Math.max(0, Math.floor((now - statSync(path).mtimeMs) / DAY_MS));
      const uses = ledgerTexts.filter((t) => t.includes(e.name)).length;
      const purpose = headerPurpose(readHead(path));
      return { name: e.name, idleDays, uses, purpose, proposal: propose({ idleDays, uses }) };
    })
    .sort((a, b) => b.idleDays - a.idleDays || a.name.localeCompare(b.name));
}

/** The printable table, one line per file, or a one-line note when there is nothing to list. */
export function scratchReport(shelf: string, ledgerTexts?: string[], now?: number): string[] {
  const rows = scratchRows(shelf, ledgerTexts, now);
  if (!rows.length) return [`scratch: nothing in ${join(shelf, 'scratch')}.`];
  return [
    `scratch: ${rows.length} file(s) in ${join(shelf, 'scratch')} (proposals only; nothing is moved or deleted)`,
    '  name | idle days | ledger uses | purpose | proposal',
    ...rows.map((r) => `  ${r.name} | ${r.idleDays} | ${r.uses} | ${r.purpose || '(no header)'} | ${r.proposal}`),
  ];
}
