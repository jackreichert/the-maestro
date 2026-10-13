#!/usr/bin/env node
/**
 * agent-return.ts: the SubagentStop hook. When a subagent ends it marks the row that agent was dispatched on "returned, verify"
 * and shortens its lease to the verify window, so a hand-back nobody checks lapses and the row is requeued, not left in flight
 * with a finished agent behind it. It never closes the row: whether the work is done is for the dispatcher to verify. Pairing is
 * by this window and agent type, oldest dispatch first. Input is the hook's JSON on stdin (`agent_type`, `session_id`).
 *
 *   agent-return.ts [--project <name>] [--vault <ledger-root>]
 *
 * Fails open and prints nothing to stdout; an error is a stderr line with exit 0. No spawned process, so it stays under 300 ms.
 */
import { fileURLToPath } from 'node:url';
import { returnRows } from '../lib/journal/agent-rows.ts';
import type { LedgerRow } from '../lib/ledger-core.ts';
import { failOpen, hookWindow, HOOK_MARKS, idSource, readInput, realLedger } from './ledger-hook.ts';
import type { HookLedger } from './ledger-hook.ts';

export interface AgentStop { session_id?: string; agent_type?: string }

/** Appends the return rows and returns them; none when this window has no open dispatch. */
export function agentReturned(input: AgentStop, ledger: HookLedger): LedgerRow[] {
  const rows = ledger.readLedger();
  const out = returnRows(rows, hookWindow(input.session_id), input.agent_type ?? '', ledger.now(), idSource(rows, ledger.newId), HOOK_MARKS);
  if (out.length) ledger.append(out);
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  failOpen('agent-return', () => { agentReturned(readInput() as AgentStop, realLedger(process.argv.slice(2))); });
  process.exit(0);
}
