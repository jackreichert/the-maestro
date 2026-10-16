#!/usr/bin/env node
/**
 * GH BUDGET: what the-maestro spends of GitHub's GraphQL budget, from the log scripts/gh-guard.ts keeps.
 *
 *   node scripts/gh-budget.ts report [--hours N] [--json]   calls per hour by caller and kind over the last N hours (default 1)
 *   node scripts/gh-budget.ts status [--json]                the last probe of the budget and any block
 *   node scripts/gh-budget.ts clear                          drop a block (the next GraphQL call probes again)
 *
 * Calls are counted, not priced: a call's cost in points depends on its query (the `rateLimit { cost }` field says), so read a
 * suspicious caller's query before trusting its count as small.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EVENT_DIR, WATCH_TZ } from './local-config.ts';
import { callsPerHour, limitedText, readCalls, readState, writeState } from './lib/gh-budget.ts';

/** Runs one subcommand and returns the exit code. */
export function main(argv: string[], dir: string = EVENT_DIR, now: number = Date.now(), out: (t: string) => void = console.log): number {
  const [sub, ...rest] = argv;
  const json = rest.includes('--json');
  if (sub === 'report') {
    const i = rest.indexOf('--hours');
    const hours = i >= 0 ? Number(rest[i + 1]) : 1;
    if (!(hours > 0)) { out('--hours needs a positive number'); return 2; }
    const rows = callsPerHour(readCalls(dir, now - hours * 3600_000), hours);
    out(json ? JSON.stringify(rows.map(([caller, kind, perHour]) => ({ caller, kind, perHour }))) : [`gh calls per hour over the last ${hours}h`, ...rows.map(([c, k, n]) => `${String(n).padStart(8)}  ${k.padEnd(7)} ${c}`), ...(rows.length ? [] : ['  (none logged)'])].join('\n'));
    return 0;
  }
  if (sub === 'status') {
    const state = readState(dir);
    out(json ? JSON.stringify(state) : [`GraphQL: ${state.remaining ?? '?'} of ${state.limit ?? '?'} left at last probe${state.probedAt ? ` (${Math.round((now - state.probedAt) / 1000)}s ago)` : ''}`, limitedText(state, now, WATCH_TZ) || 'not limited'].join('\n'));
    return 0;
  }
  if (sub === 'clear') { const { blockedUntil: _b, failures: _f, reason: _r, ...keep } = readState(dir); writeState(dir, { ...keep, probedAt: undefined }); out('block cleared'); return 0; }
  out('usage: gh-budget.ts report [--hours N] [--json] | status [--json] | clear');
  return sub ? 2 : 0;
}

const isMain = (): boolean => { try { return realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url); } catch { return false; } };
if (isMain()) process.exitCode = main(process.argv.slice(2));
