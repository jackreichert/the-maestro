#!/usr/bin/env node
/**
 * agent-dispatch.ts: the PreToolUse hook for the Agent tool. Before a subagent starts it ties the dispatch to the ledger: it finds
 * the in-flight row this window already holds a lease on that the dispatch is about (its id in the prompt, or its text holding the
 * description), or opens one, then marks the lease "agent out" and records the next step. Nothing a window dispatches is then
 * invisible to the ledger. When it opens the row it also saves the prompt as the row's brief (the same `brief` row `journal.ts brief <id>`
 * and `start --brief` write), so a cut agent can be re-dispatched from the file; a prompt that looks like it holds a secret is not saved.
 * A call a subagent makes itself (the harness sets `agent_id`) writes nothing: only the orchestrator session is tracked.
 * Input is the hook's JSON on stdin (`tool_input.description`, `.prompt`, `.subagent_type`, `session_id`, `agent_id`).
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
import { briefLinkRow } from '../lib/journal/brief-link.ts';
import { failOpen, hookWindow, HOOK_MARKS, idSource, readInput, realLedger } from './ledger-hook.ts';
import type { HookLedger } from './ledger-hook.ts';

export interface AgentCall { session_id?: string; /** Set by the harness on a call a subagent makes itself; absent on the orchestrator's own. */ agent_id?: string; tool_input?: { description?: string; prompt?: string; subagent_type?: string } }

/**
 * Appends the dispatch rows and returns them. A dispatch the orchestrator makes opens a row when none matches and keeps the prompt
 * as that row's brief (`<ledger>/Journal/Briefs/`), so a cut agent can be re-dispatched from the file. A call a subagent makes
 * (the harness sets `agent_id` on it) is that agent's own business and writes nothing: only the orchestrator session is tracked.
 */
export function dispatch(input: AgentCall, ledger: HookLedger): LedgerRow[] {
  if (input.agent_id) return [];
  const rows = ledger.readLedger();
  const call = input.tool_input ?? {};
  const nextId = idSource(rows, ledger.newId);
  const window = hookWindow(input.session_id);
  const out = dispatchRows(rows, fold(rows, null).items, { window, description: call.description, prompt: call.prompt, agentType: call.subagent_type }, ledger.now(), nextId, HOOK_MARKS);
  const opened = out.find((r) => r.kind === 'wip' && r.hookOpened === true);
  const file = opened && call.prompt && ledger.saveBrief ? ledger.saveBrief(call.prompt, String(opened.text ?? ''), String(opened.id), String(opened.date)) : null;
  if (opened && file) out.splice(1, 0, { ...HOOK_MARKS, ts: opened.ts, date: opened.date, window, id: nextId(), ...briefLinkRow(String(opened.id), file, { repo: undefined }) } as LedgerRow);
  ledger.append(out);
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  failOpen('agent-dispatch', () => { dispatch(readInput() as AgentCall, realLedger(process.argv.slice(2))); });
  process.exit(0);
}
