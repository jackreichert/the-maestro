#!/usr/bin/env node
/**
 * equivalence-drill.ts: epic R7, done point 1. After `/compact`, after `/clear` and on a cold `startup` the SessionStart hook runs on
 * the same state, so the three contexts must carry the same facts. The drill builds one fictional ledger and vault in a temp dir, runs
 * the hook for each source, and compares (a) which ground-truth facts each context carries and (b) the ids each names in backticks.
 * Model-free; never touches the real ledger. It reports, it does not patch.
 *
 *   equivalence-drill.ts      exit 0 when the three agree and carry every fact, 1 and the differences when not
 */
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SOURCES, backtickedIds, buildScratch, missing, runHook } from './lib.ts';
import type { DrillResult, Fact, Source } from './lib.ts';

/** Every fact a context lacks, labelled with its source, plus every backticked id one source names and another does not. Empty means the three carry the same facts. */
export function compareContexts(facts: Fact[], contexts: Map<Source, string>): string[] {
  const gone = SOURCES.flatMap((source) => missing(facts, contexts.get(source) ?? '').map((m) => `${source}: ${m}`));
  const ids = SOURCES.map((source) => backtickedIds(contexts.get(source) ?? ''));
  const everyId = [...new Set(ids.flat())].sort();
  const differ = SOURCES.flatMap((source, i) => everyId.filter((id) => !(ids[i] as string[]).includes(id)).map((id) => `${source}: id ${id} named by another source only`));
  return [...gone, ...differ];
}

/** Runs the hook for each source on one state and returns every fact a context lacks, labelled with its source, plus any id the three do not share. */
export function equivalenceDrill(now: Date = new Date()): DrillResult {
  const s = buildScratch({ now });
  try {
    const contexts = new Map<Source, string>();
    for (const source of SOURCES) {
      const run = runHook(s, source);
      if (run.code !== 0 || !run.out.trim()) return { name: 'equivalence', ok: false, missing: [`${source}: hook produced no context`], notes: [run.err.trim().split('\n').pop() ?? ''] };
      contexts.set(source, run.out);
    }
    const verdict = compareContexts(s.facts, contexts);
    return { name: 'equivalence', ok: verdict.length === 0, missing: verdict, notes: [`${SOURCES.length} sources, ${s.facts.length} facts`] };
  } finally { rmSync(s.root, { recursive: true, force: true }); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = equivalenceDrill();
  console.log(`equivalence drill: ${r.ok ? 'ok' : 'FAILED'}`);
  for (const n of r.notes) console.log(`  ${n}`);
  for (const m of r.missing) console.log(`  MISSING ${m}`);
  process.exit(r.ok ? 0 : 1);
}
