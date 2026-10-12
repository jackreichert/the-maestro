#!/usr/bin/env node
/**
 * cold-start-drill.ts: epic R7, done point 2. A fresh session with the ledger reduced to its pointer index and live in-flight rows
 * (no CURRENT.md, no HANDOFF, no transcript) must still be handed yesterday's priorities, every open id, the asks and the how-to
 * pointers. The drill builds a fictional ledger and vault in a temp dir, reduces the ledger, runs the SessionStart hook with
 * `startup`, and reports each fact the printed context lacks. Model-free; never touches the real ledger. It reports, it does not patch.
 *
 *   cold-start-drill.ts      exit 0 when every fact is present, 1 and the missing facts when not
 */
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildScratch, missing, runHook } from './lib.ts';
import type { DrillResult } from './lib.ts';

/** Runs the drill and returns what was missing; the temp dir is removed. */
export function coldStartDrill(now: Date = new Date()): DrillResult {
  const s = buildScratch({ now, reduce: true });
  try {
    const run = runHook(s, 'startup');
    if (run.code !== 0 || !run.out.trim()) return { name: 'cold-start', ok: false, missing: ['hook produced no context'], notes: [run.err.trim().split('\n').pop() ?? ''] };
    const gone = missing(s.facts, run.out);
    return { name: 'cold-start', ok: gone.length === 0, missing: gone, notes: [`${s.facts.length} facts checked in ${run.out.length} characters`] };
  } finally { rmSync(s.root, { recursive: true, force: true }); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = coldStartDrill();
  console.log(`cold-start drill: ${r.ok ? 'ok' : 'FAILED'}`);
  for (const n of r.notes) console.log(`  ${n}`);
  for (const m of r.missing) console.log(`  MISSING ${m}`);
  process.exit(r.ok ? 0 : 1);
}
