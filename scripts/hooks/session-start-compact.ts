#!/usr/bin/env node
/**
 * session-start-compact.ts: the SessionStart hook for the `compact` and `clear` sources. Whatever it prints becomes session
 * context, so the board, the Start-here page and the library brief of each active stream are re-read from disk instead of
 * summarized. Any other source prints nothing (the plain `prime` hook covers startup and resume).
 *
 *   session-start-compact.ts [--project <name>] [--vault <ledger-root>]
 *
 * Input is the hook's JSON on stdin (`source`). Output is capped at about 5k tokens; a part that cannot run is named and skipped,
 * never fatal (a missing `library-brief` command, for one). Always exits 0.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const JOURNAL = join(dirname(fileURLToPath(import.meta.url)), '..', 'journal.ts');
export const SOURCES = ['compact', 'clear'];
/** About 5k tokens at four characters each. */
export const MAX_CHARS = 20_000;
const MAX_STREAMS = 5;

/** The stream names on prime's "Today's streams:" line. */
export function streamsFrom(primeOut: string): string[] {
  const line = primeOut.split('\n').find((l) => l.startsWith("Today's streams:"));
  return (line?.slice("Today's streams:".length).split(',').map((s) => s.trim()).filter((s) => s && s !== 'none') ?? []).slice(0, MAX_STREAMS);
}

/** Joins the parts under their headings and cuts at the cap, saying so. */
export function assemble(parts: { title: string; body: string }[], max: number = MAX_CHARS): string {
  const text = parts.map((p) => `== ${p.title} ==\n${p.body.trim()}`).join('\n\n');
  return text.length <= max ? text : `${text.slice(0, max)}\n… cut at ${max} characters; \`journal.ts start-here\` and \`library-brief\` have the rest.`;
}

export type Run = (args: string[]) => { ok: boolean; out: string };

/** The context for a source: empty for any but compact and clear. */
export function context(source: string, run: Run): string {
  if (!SOURCES.includes(source)) return '';
  const prime = run(['prime', '--source', source, '--no-update-check']);
  const parts = [{ title: 'Board (journal.ts prime)', body: prime.ok ? prime.out : `prime failed: ${prime.out.split('\n').pop()}` }];
  const start = run(['start-here']);
  parts.push({ title: 'Start here', body: start.ok ? start.out : `start-here failed: ${start.out.split('\n').pop()}` });
  for (const s of streamsFrom(prime.out)) {
    const brief = run(['library-brief', '--stream', s]);
    if (brief.ok && brief.out.trim()) parts.push({ title: `Library brief: ${s}`, body: brief.out });
    else if (!brief.ok) { parts.push({ title: 'Library brief', body: 'library-brief is not available in this checkout; skipped.' }); break; }
  }
  return assemble(parts);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const forward = ['project', 'vault'].flatMap((f) => { const k = process.argv.indexOf(`--${f}`); return k >= 0 && process.argv[k + 1] ? [`--${f}`, process.argv[k + 1]] : []; });
    const input: { source?: string } = JSON.parse(readFileSync(0, 'utf8') || '{}');
    const out = context(input.source ?? '', (args) => {
      const r = spawnSync(process.execPath, [JOURNAL, ...args, ...forward], { encoding: 'utf8', timeout: 60_000 });
      return { ok: !r.error && r.status === 0, out: (r.status === 0 ? r.stdout : r.stderr || r.stdout || r.error?.message || '').trim() };
    });
    if (out) console.log(out);
  } catch (e) {
    console.error(`session-start-compact hook: ${e instanceof Error ? e.message : String(e)}`);
  }
  process.exit(0);
}
