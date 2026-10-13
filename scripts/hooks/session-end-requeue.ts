#!/usr/bin/env node
/**
 * session-end-requeue.ts: a SessionEnd hook. When a window ends, the in-flight rows it holds a live lease on go back to queued and
 * the leases are released, so the board stops calling them in flight and another window can pick them up at once instead of
 * waiting out the lease. Input is the hook's JSON on stdin (`session_id`).
 *
 *   session-end-requeue.ts [--project <name>] [--vault <ledger-root>]
 *
 * Fails open and prints nothing to stdout; an error is a stderr line with exit 0. It runs beside session-end-decisions.ts, not
 * inside it, so a failure in one never costs the other.
 */
import { fileURLToPath } from 'node:url';
import { windowRequeues } from '../lib/journal/lease-requeue.ts';
import { fold } from '../lib/ledger-core.ts';
import type { LedgerRow } from '../lib/ledger-core.ts';
import { failOpen, hookWindow, HOOK_MARKS, idSource, readInput, realLedger } from './ledger-hook.ts';
import type { HookLedger } from './ledger-hook.ts';

/** Appends the requeue rows for the ending window and returns them. */
export function requeueEnding(input: { session_id?: string }, ledger: HookLedger): LedgerRow[] {
  const rows = ledger.readLedger();
  const next = idSource(rows, ledger.newId);
  const out = windowRequeues(rows, fold(rows, null).items, hookWindow(input.session_id), ledger.now(), HOOK_MARKS).map((r) => ({ ...r, id: next() }));
  if (out.length) ledger.append(out);
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  failOpen('session-end-requeue', () => { requeueEnding(readInput() as { session_id?: string }, realLedger(process.argv.slice(2))); });
  process.exit(0);
}
