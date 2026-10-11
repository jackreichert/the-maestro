#!/usr/bin/env node
/**
 * session-start-compact.ts: the SessionStart hook for the `compact` and `clear` sources. Whatever it prints becomes session
 * context, so the board, the Start-here page and the cold-start page (current work, decisions pending, library pointers) are re-read from disk instead of
 * summarized. Any other source prints nothing (the plain `prime` hook covers startup and resume).
 * The hook is an optional, fail-open fallback: the same state is on disk (`cold-start.ts generate`, `journal.ts start-here`), so a
 * session that never runs it loses nothing it cannot read.
 *
 *   session-start-compact.ts [--project <name>] [--vault <ledger-root>]
 *
 * Input is the hook's JSON on stdin (`source`). Output is capped at about 5k tokens; a part that cannot run is named and skipped,
 * never fatal (a missing `cold-start.ts`, for one). Always exits 0.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { floorWarnings, readAutocompact } from '../lib/autocompact.ts';
import { scanText } from '../lib/library/scan.ts';

const JOURNAL = join(dirname(fileURLToPath(import.meta.url)), '..', 'journal.ts');
const COLD_START = join(dirname(fileURLToPath(import.meta.url)), '..', 'cold-start.ts');
export const SOURCES = ['compact', 'clear'];
/** About 5k tokens at four characters each. */
export const MAX_CHARS = 20_000;

export const WITHHELD = '[withheld: secret shape]';

/** The body with every line the secret scan flags replaced by a marker, so a secret-shaped stream name or id the board printed never becomes session context. */
function withhold(body: string): string {
  const hits = new Set(scanText(body).map((h) => h.line));
  return hits.size ? body.split('\n').map((l, i) => (hits.has(i + 1) ? WITHHELD : l)).join('\n') : body;
}

/** Joins the parts under their headings, withholds secret-shaped lines, and cuts at the cap, saying so. */
export function assemble(parts: { title: string; body: string }[], max: number = MAX_CHARS): string {
  const text = parts.map((p) => `== ${p.title} ==\n${withhold(p.body.trim())}`).join('\n\n');
  return text.length <= max ? text : `${text.slice(0, max)}\n… cut at ${max} characters; \`journal.ts start-here\` and \`library-brief\` have the rest.`;
}

export type Run = (args: string[]) => { ok: boolean; out: string };
/** Runs `cold-start.ts generate`; optional, so a checkout without it (or a failing run) only loses that part. */
export type ColdRun = () => { ok: boolean; out: string };

/** The context for a source: empty for any but compact and clear. */
export function context(source: string, run: Run, cold?: ColdRun, warnings: string[] = []): string {
  if (!SOURCES.includes(source)) return '';
  const prime = run(['prime', '--source', source, '--no-update-check']);
  const parts: { title: string; body: string }[] = warnings.length ? [{ title: 'Autocompact', body: warnings.map((w) => `!! ${w}`).join('\n') }] : [];
  parts.push({ title: 'Board (journal.ts prime)', body: prime.ok ? prime.out : `prime failed: ${prime.out.split('\n').pop()}` });
  const page = cold ? safely(cold) : { ok: false, out: 'cold-start is not available in this checkout' };
  if (page.ok && page.out.trim()) parts.push({ title: 'Cold start', body: page.out });
  else parts.push({ title: 'Cold start', body: `skipped: ${page.out.split('\n').pop() || 'no output'}. \`cold-start.ts generate\` and \`journal.ts start-here\` have the same state.` });
  const start = run(['start-here']);
  parts.push({ title: 'Start here', body: start.ok ? start.out : `start-here failed: ${start.out.split('\n').pop()}` });
  return assemble(parts);
}

/** A part that throws is a part that is skipped: the hook is a fallback and must never be the reason a session fails to start. */
function safely(run: ColdRun): { ok: boolean; out: string } {
  try { return run(); } catch (e) { return { ok: false, out: e instanceof Error ? e.message : String(e) }; }
}

/** The floor warnings for the live setting; a throw in the reader yields none (fail-open). */
function autocompactWarnings(): string[] {
  try { return floorWarnings(readAutocompact()); } catch { return []; }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const forward = ['project', 'vault'].flatMap((f) => { const k = process.argv.indexOf(`--${f}`); return k >= 0 && process.argv[k + 1] ? [`--${f}`, process.argv[k + 1]] : []; });
    const input: { source?: string } = JSON.parse(readFileSync(0, 'utf8') || '{}');
    const spawn = (script: string, args: string[]): { ok: boolean; out: string } => {
      const r = spawnSync(process.execPath, [script, ...args, ...forward], { encoding: 'utf8', timeout: 60_000 });
      return { ok: !r.error && r.status === 0, out: (r.status === 0 ? r.stdout : r.stderr || r.stdout || r.error?.message || '').trim() };
    };
    const out = context(input.source ?? '', (args) => spawn(JOURNAL, args), () => spawn(COLD_START, ['generate']), autocompactWarnings());
    if (out) console.log(out);
  } catch (e) {
    console.error(`session-start-compact hook: ${e instanceof Error ? e.message : String(e)}`);
  }
  process.exit(0);
}
