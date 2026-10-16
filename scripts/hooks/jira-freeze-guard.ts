#!/usr/bin/env node
/**
 * jira-freeze-guard.ts: a Claude Code PreToolUse hook for the Atlassian MCP tools. It refuses a Jira write (comment, edit,
 * transition, link, worklog, create under a frozen parent) on a ticket that carries a label from `next_frozen_labels`, with a clear
 * message. Reads pass. Labels come from `jira_labels_command` (argv; the issue key is appended; one label per line).
 * Logic: scripts/lib/jira-freeze.ts. Fail closed: with frozen labels set, an unreadable label list refuses the write; a crash of the
 * hook itself denies too, because this guard exists to stop a write. Printed by print-settings-snippet.ts; you merge it yourself.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JIRA_LABELS_COMMAND, NEXT_FROZEN_LABELS } from '../local-config.ts';
import { decide, type LabelLookup } from '../lib/jira-freeze.ts';

/** Reads labels through the configured command; undefined when none is configured or it fails. */
export function commandLookup(argv: string[] = JIRA_LABELS_COMMAND): LabelLookup {
  return (issue) => {
    if (!argv.length) return undefined;
    try {
      const out = execFileSync(argv[0], [...argv.slice(1), issue], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
      return out.split('\n').map((l) => l.trim()).filter(Boolean);
    } catch { return undefined; }
  };
}

const deny = (reason: string): string => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });

/** stdin JSON in, a PreToolUse deny object (or nothing) out. Never throws. */
export function run(stdin: string, frozen: string[] = NEXT_FROZEN_LABELS, lookup: LabelLookup = commandLookup()): string {
  try {
    const input = JSON.parse(stdin) as { tool_name?: string; tool_input?: unknown };
    if (typeof input.tool_name !== 'string') return '';
    const d = decide(input.tool_name, input.tool_input, frozen, lookup);
    return d.deny ? deny(d.reason) : '';
  } catch (e) {
    return deny(`jira-freeze-guard: could not check this call (${e instanceof Error ? e.message : String(e)}); refused because the guard fails closed`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = run(readFileSync(0, 'utf8'));
  if (out) process.stdout.write(`${out}\n`);
  process.exit(0);
}
