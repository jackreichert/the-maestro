#!/usr/bin/env node
/**
 * session-start-compact.ts: the SessionStart hook for every start reason (`startup`, `resume`, `compact`, `clear`).
 * Whatever it prints becomes session context, so the board and the cold-start page (current work, decisions pending, library pointers) are re-read from
 * disk instead of summarized. The Start-here page is the fallback: it prints only when the cold-start part failed or was skipped. Any other source prints nothing.
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
import { WITHHELD, withhold } from '../lib/withhold.ts';
import { MODE } from '../local-config.ts';

const JOURNAL = join(dirname(fileURLToPath(import.meta.url)), '..', 'journal.ts');
const COLD_START = join(dirname(fileURLToPath(import.meta.url)), '..', 'cold-start.ts');
export const SOURCES = ['startup', 'resume', 'compact', 'clear'];
/** About 5k tokens at four characters each. */
export const MAX_CHARS = 20_000;

export { WITHHELD };

/** Joins the parts under their headings, withholds secret-shaped lines, and cuts at the cap, saying so. */
export function assemble(parts: { title: string; body: string }[], max: number = MAX_CHARS): string {
  const text = parts.map((p) => `== ${p.title} ==\n${withhold(p.body.trim())}`).join('\n\n');
  return text.length <= max ? text : `${text.slice(0, max)}\n… cut at ${max} characters; \`journal.ts start-here\` and \`library-brief\` have the rest.`;
}

export type Run = (args: string[]) => { ok: boolean; out: string };
/** Runs `cold-start.ts generate`; optional, so a checkout without it (or a failing run) only loses that part. */
export type ColdRun = () => { ok: boolean; out: string };

/** Slim mode's pointer: the session reads slim/SKILL.md and the ledger front page, not the board. */
export const SLIM_POINTER = 'Mode: slim. Run session-start.ts, then follow slim/SKILL.md only. The board is on the Podium; the ledger holds the handoff.';

/**
 * The context for a source: empty for an unknown source. In slim mode it is only the footer (the ledger front page) and a pointer,
 * so a roll starts small (about 1k tokens instead of the board and cold-start page, about 5k); the full board stays on the Podium.
 */
export function context(source: string, run: Run, cold?: ColdRun, warnings: string[] = [], mode: 'full' | 'slim' = 'full'): string {
  if (!SOURCES.includes(source)) return '';
  const parts: { title: string; body: string }[] = warnings.length ? [{ title: 'Autocompact', body: warnings.map((w) => `!! ${w}`).join('\n') }] : [];
  if (mode === 'slim') {
    const footer = run(['status', '--footer']);
    parts.push({ title: 'Front page (journal.ts status --footer)', body: footer.ok ? footer.out : `status failed: ${footer.out.split('\n').pop()}` });
    parts.push({ title: 'Slim', body: SLIM_POINTER });
    return assemble(parts);
  }
  const prime = run(['prime', '--source', source, '--no-update-check']);
  parts.push({ title: 'Board (journal.ts prime)', body: prime.ok ? prime.out : `prime failed: ${prime.out.split('\n').pop()}` });
  const page = cold ? safely(cold) : { ok: false, out: 'cold-start is not available in this checkout' };
  if (page.ok && page.out.trim()) parts.push({ title: 'Cold start', body: page.out });
  else {
    parts.push({ title: 'Cold start', body: `skipped: ${page.out.split('\n').pop() || 'no output'}. \`cold-start.ts generate\` and \`journal.ts start-here\` have the same state.` });
    const start = run(['start-here']);
    parts.push({ title: 'Start here', body: start.ok ? start.out : `start-here failed: ${start.out.split('\n').pop()}` });
  }
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
  // A triage child (haiku-triage.ts) is a throwaway session: no board or ledger priming for it.
  if (process.env.MAESTRO_TRIAGE_CHILD) process.exit(0);
  try {
    const forward = ['project', 'vault'].flatMap((f) => { const k = process.argv.indexOf(`--${f}`); return k >= 0 && process.argv[k + 1] ? [`--${f}`, process.argv[k + 1]] : []; });
    const input: { source?: string } = JSON.parse(readFileSync(0, 'utf8') || '{}');
    const spawn = (script: string, args: string[]): { ok: boolean; out: string } => {
      const r = spawnSync(process.execPath, [script, ...args, ...forward], { encoding: 'utf8', timeout: 60_000 });
      return { ok: !r.error && r.status === 0, out: (r.status === 0 ? r.stdout : r.stderr || r.stdout || r.error?.message || '').trim() };
    };
    const out = context(input.source ?? '', (args) => spawn(JOURNAL, args), () => spawn(COLD_START, ['generate']), autocompactWarnings(), MODE);
    if (out) console.log(out);
  } catch (e) {
    console.error(`session-start-compact hook: ${e instanceof Error ? e.message : String(e)}`);
  }
  process.exit(0);
}
