import { existsSync, mkdirSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { scanText } from '../secret-scan.ts';
import type { LedgerRow } from '../ledger-core.ts';

/**
 * Linking a durable brief to a ledger row. A brief that lives only in chat is gone when the terminal closes, and a cut agent cannot
 * be re-dispatched from nothing. `journal.ts start --brief <path>` copies a file that exists into that folder; `--brief-file -`
 * saves the text under `<ledger>/Projects/<project>/Journal/Briefs/` first. Both end in the `brief` row `journal.ts brief <id>`
 * already writes, so an item with a brief link is a briefed item and `done` asks for its agent retro: one concept, not two.
 */

/** A brief is a prompt, not a transcript: past this the file is refused rather than stored. */
export const BRIEF_MAX_BYTES = 256 * 1024;

/** The PHI rules a brief is refused for: they are the ones that identify one patient. */
const BRIEF_REFUSED_PHI = new Set(['ssn', 'date-of-birth', 'medical-record-number']);

/** Where saved briefs live for a project's ledger. */
export const briefsDir = (vault: string, project: string): string => join(vault, 'Projects', project, 'Journal', 'Briefs');

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'brief';

/** The first problem with a brief's text (empty, too large, or carrying the shape of a credential), or null. Never names the matched text. */
export function briefTextProblem(text: string): string | null {
  if (!text.trim()) return 'the brief is empty';
  if (Buffer.byteLength(text) > BRIEF_MAX_BYTES) return `the brief is over ${BRIEF_MAX_BYTES / 1024} KB`;
  // Secrets, and the identifiers that name a patient: a brief legitimately carries emails, phone numbers and names, which the broader PHI rules would refuse.
  const hit = scanText(text).find((f) => f.class === 'secret' || BRIEF_REFUSED_PHI.has(f.rule));
  return hit ? `the brief looks like it holds ${hit.class === 'secret' ? 'a secret' : 'patient data'} (${hit.rule}); remove it and link the file again` : null;
}

/** Saves `text` as a brief file under `dir` and returns its absolute path. The name is the day, the id when known, and a slug of the title; an existing file is never overwritten. */
export function saveBrief(dir: string, text: string, opts: { day: string; title: string; id?: string }): string {
  const problem = briefTextProblem(text);
  if (problem) throw new Error(problem);
  mkdirSync(dir, { recursive: true });
  const base = `${opts.day}-${opts.id ? `${opts.id}-` : ''}${slug(opts.title)}`;
  for (let n = 0; ; n++) {
    const file = join(dir, `${base}${n ? `-${n + 1}` : ''}.md`);
    if (existsSync(file)) { if (readFileSync(file, 'utf8') === text) return file; continue; }
    writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`, { flag: 'wx' });
    return file;
  }
}

/** The absolute path of an existing brief file that passes the same checks as a saved one, or throws saying why not. A relative path is resolved against `cwd`. */
export function linkableBrief(path: string, cwd: string): string {
  const file = isAbsolute(path) ? path : resolve(cwd, path);
  if (!existsSync(file)) throw new Error(`no brief file at ${file}`);
  const st = statSync(file);
  if (st.isDirectory()) throw new Error(`${file} is a directory, not a brief file`);
  if (!st.isFile()) throw new Error(`no brief file at ${file}`);
  if (st.size > BRIEF_MAX_BYTES) throw new Error(`${file}: the brief is over ${BRIEF_MAX_BYTES / 1024} KB`);
  const problem = briefTextProblem(readFileSync(file, 'utf8'));
  if (problem) throw new Error(`${file}: ${problem}`);
  return file;
}

/** The brief path already recorded on `rows` for an item, newest first; undefined when none. */
export const briefOf = (rows: readonly LedgerRow[], id: string): string | undefined =>
  [...rows].reverse().find((r) => r.kind === 'brief' && r.briefs === id && typeof r.brief === 'string')?.brief;

/** The `brief` row that links `file` to item `id`; the caller stamps the id, time and usage marks. */
export const briefLinkRow = (id: string, file: string, extra: Partial<LedgerRow> = {}): Partial<LedgerRow> =>
  ({ ...extra, kind: 'brief', briefs: id, brief: file, text: `brief ${id} linked: ${file}` });

/** Standard input as text, read in chunks and stopped one byte past the cap, so an endless or huge stream cannot exhaust memory; the caller's size check then refuses it. */
export function readBriefStdin(): string {
  const chunks: Buffer[] = [];
  let total = 0;
  const buf = Buffer.alloc(64 * 1024);
  while (total <= BRIEF_MAX_BYTES) {
    let n = 0;
    try { n = readSync(0, buf, 0, buf.length, null); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'EAGAIN') continue; if ((e as NodeJS.ErrnoException).code === 'EOF') break; throw e; }
    if (!n) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
    total += n;
  }
  return Buffer.concat(chunks).toString('utf8');
}
