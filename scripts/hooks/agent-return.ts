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
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { returnRows } from '../lib/journal/agent-rows.ts';
import type { LedgerRow } from '../lib/ledger-core.ts';
import { failOpen, hookWindow, HOOK_MARKS, idSource, readInput, realLedger } from './ledger-hook.ts';
import type { HookLedger } from './ledger-hook.ts';

export interface AgentStop { session_id?: string; agent_type?: string; agent_id?: string; transcript_path?: string; agent_transcript_path?: string }

/**
 * The tool-use id of the Agent call that started the stopping subagent: the harness writes it into `<session>/subagents/agent-<id>.meta.json`
 * beside the subagent's transcript. Empty when the stop names no transcript or the file is missing, and the stop is then paired by agent type.
 */
export function toolUseIdOf(input: AgentStop): string {
  try {
    const transcript = input.agent_transcript_path || (input.transcript_path && input.agent_id ? join(dirname(input.transcript_path), basename(input.transcript_path, '.jsonl'), 'subagents', `agent-${input.agent_id}.jsonl`) : '');
    if (!transcript.endsWith('.jsonl')) return '';
    const id = (JSON.parse(readFileSync(transcript.replace(/\.jsonl$/, '.meta.json'), 'utf8')) as { toolUseId?: unknown }).toolUseId;
    return typeof id === 'string' ? id : '';
  } catch { return ''; }
}

/** Appends the return rows and returns them; none when this window has no open dispatch. */
export function agentReturned(input: AgentStop, ledger: HookLedger): LedgerRow[] {
  const rows = ledger.readLedger();
  const out = returnRows(rows, hookWindow(input.session_id), input.agent_type ?? '', ledger.now(), idSource(rows, ledger.newId), HOOK_MARKS, toolUseIdOf(input));
  if (out.length) ledger.append(out);
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  failOpen('agent-return', () => { agentReturned(readInput() as AgentStop, realLedger(process.argv.slice(2))); });
  process.exit(0);
}
