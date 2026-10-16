#!/usr/bin/env node
/**
 * print-settings-snippet.ts: prints the Claude Code `hooks` settings for the continuous roll. It only prints; it edits no
 * settings file, so you merge the output into your own `settings.json` (or `settings.local.json`) yourself.
 *
 *   print-settings-snippet.ts [--project <name>] [--vault <ledger-root>]
 *
 * PreCompact runs precompact.ts (timeout 120 s, above the 45 s the hook gives its own handoff). SessionStart with matcher
 * `startup|resume|compact|clear` runs session-start-compact.ts (timeout 120 s; each command it runs is capped at 60 s).
 * SessionEnd with matcher `clear|resume|logout|prompt_input_exit|other` runs session-end-decisions.ts, the decision scan alone
 * (timeout 30 s; SessionEnd hooks otherwise get 1.5 s and never more than 60 s).
 * A second SessionEnd entry runs session-end-requeue.ts (timeout 10 s): the ending window's in-flight rows go back to queued.
 * PreToolUse with matcher `Bash` runs git-guard.ts (timeout 10 s), which takes no flags: it asks before risky git commands.
 * PreToolUse with matcher `Agent` runs agent-dispatch.ts and SubagentStop runs agent-return.ts (timeout 10 s each): a dispatch
 * opens or finds a leased in-flight row, and a stop marks it "returned, verify". Both fail open and write the ledger directly.
 * PreToolUse with matcher `mcp__.*(tlassian|ira).*` runs jira-freeze-guard.ts (timeout 15 s): it refuses a Jira write on a ticket carrying a `next_frozen_labels` label.
 * `--project` and `--vault` are passed through to every hook but git-guard and jira-freeze-guard.
 * The one snippet also holds the event-inject entries (SessionStart with no matcher, UserPromptSubmit; see install-hooks.ts), so
 * everything to paste is in one place. `--autocompact-pct N` adds `"env": { "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "N" }`, and is
 * refused (exit 2, nothing printed on stdout) when N puts the trigger under the autocompact floor. Without it no `env` key is
 * printed. stderr always carries the current setting, any floor warning and a note on 200k-window models.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTOCOMPACT_FLOOR } from '../local-config.ts';
import { describeSetting, floorWarnings, readAutocompact, subagentNote, triggerTokens } from '../lib/autocompact.ts';
import { eventHooksSnippet } from './install-hooks.ts';
import { printJson } from '../lib/json-out.ts';

const HOOKS = dirname(fileURLToPath(import.meta.url));
const shq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

/** The settings object for every hook; `extra` is the shell-quoted pass-through flags, `autocompactPct` an already-validated percentage. */
export function snippet(extra: string[], autocompactPct?: number): object {
  const events = (eventHooksSnippet() as { hooks: { SessionStart: object[]; UserPromptSubmit: object[] } }).hooks;
  const cmd = (file: string): string => ['node', shq(join(HOOKS, file)), ...extra].join(' ');
  return {
    ...(autocompactPct ? { env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(autocompactPct) } } : {}),
    hooks: {
      PreCompact: [{ matcher: 'auto|manual', hooks: [{ type: 'command', command: cmd('precompact.ts'), timeout: 120 }] }],
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: ['node', shq(join(HOOKS, 'git-guard.ts'))].join(' '), timeout: 10 }] },
        { matcher: 'Agent', hooks: [{ type: 'command', command: cmd('agent-dispatch.ts'), timeout: 10 }] },
        { matcher: 'mcp__.*(tlassian|ira).*', hooks: [{ type: 'command', command: ['node', shq(join(HOOKS, 'jira-freeze-guard.ts'))].join(' '), timeout: 15 }] },
      ],
      SessionEnd: [
        { matcher: 'clear|resume|logout|prompt_input_exit|other', hooks: [{ type: 'command', command: cmd('session-end-decisions.ts'), timeout: 30 }] },
        { matcher: 'clear|resume|logout|prompt_input_exit|other', hooks: [{ type: 'command', command: cmd('session-end-requeue.ts'), timeout: 10 }] },
      ],
      SubagentStop: [{ hooks: [{ type: 'command', command: cmd('agent-return.ts'), timeout: 10 }] }],
      SessionStart: [{ matcher: 'startup|resume|compact|clear', hooks: [{ type: 'command', command: cmd('session-start-compact.ts'), timeout: 120 }] }, ...events.SessionStart],
      UserPromptSubmit: events.UserPromptSubmit,
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const extra = ['project', 'vault'].flatMap((f) => { const k = process.argv.indexOf(`--${f}`); return k >= 0 && process.argv[k + 1] ? [`--${f}`, shq(process.argv[k + 1])] : []; });
  const current = readAutocompact();
  const at = process.argv.indexOf('--autocompact-pct');
  const wanted = at >= 0 ? Number(process.argv[at + 1]) : undefined;
  console.error(describeSetting(current));
  for (const w of floorWarnings(current)) console.error(`!! ${w}`);
  console.error(`note: ${subagentNote(current)}`);
  if (wanted !== undefined) {
    const trigger = triggerTokens({ pct: wanted, window: current.window, source: 'env' });
    if (!Number.isInteger(wanted) || wanted < 1 || wanted > 100 || trigger < AUTOCOMPACT_FLOOR) {
      console.error(`refused: --autocompact-pct ${process.argv[at + 1]} must be a whole number from 1 to 100 with a trigger of at least ${AUTOCOMPACT_FLOOR} tokens (this one gives ${trigger}). No snippet printed.`);
      process.exit(2);
    }
  }
  printJson(snippet(extra, wanted));
  console.error('note: when pasting, remove any separate plain `prime` SessionStart entry you added earlier; this one prints the board for every start reason, so prime would print twice.');
  console.error('Printed only: merge the "hooks" (and "env", if printed) entries into your settings file yourself. Nothing was edited.');
}
