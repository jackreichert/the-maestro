#!/usr/bin/env node
/**
 * agent-dispatch.ts: the PreToolUse hook for the Agent tool. Before a subagent starts it ties the dispatch to the ledger: it finds
 * the in-flight row this window already holds a lease on that the dispatch is about (its id in the prompt, or its text holding the
 * description), or opens one, then marks the lease "agent out" and records the next step. Nothing a window dispatches is then
 * invisible to the ledger. Input is the hook's JSON on stdin (`tool_input.description`, `.prompt`, `.subagent_type`, `session_id`).
 *
 *   agent-dispatch.ts [--project <name>] [--vault <ledger-root>]
 *
 * Fails open and prints nothing to stdout: it never blocks the dispatch, and an error is a stderr line with exit 0. It reads and
 * appends the ledger directly (no spawned process) to stay well under 300 ms.
 */
import { fileURLToPath } from 'node:url';
import { dispatchRows } from '../lib/journal/agent-rows.ts';
import { fold } from '../lib/ledger-core.ts';
import type { LedgerRow } from '../lib/ledger-core.ts';
import { failOpen, hookWindow, HOOK_MARKS, idSource, readInput, realLedger } from './ledger-hook.ts';
import type { HookLedger } from './ledger-hook.ts';

export interface AgentCall { session_id?: string; tool_input?: { description?: string; prompt?: string; subagent_type?: string } }

/** Appends the dispatch rows and returns them. */
export function dispatch(input: AgentCall, ledger: HookLedger): LedgerRow[] {
  const rows = ledger.readLedger();
  const call = input.tool_input ?? {};
  const out = dispatchRows(rows, fold(rows, null).items, { window: hookWindow(input.session_id), description: call.description, prompt: call.prompt, agentType: call.subagent_type }, ledger.now(), idSource(rows, ledger.newId), HOOK_MARKS);
  ledger.append(out);
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  failOpen('agent-dispatch', () => { dispatch(readInput() as AgentCall, realLedger(process.argv.slice(2))); });
  process.exit(0);
}
