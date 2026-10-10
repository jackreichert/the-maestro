#!/usr/bin/env node
/**
 * print-settings-snippet.ts: prints the Claude Code `hooks` settings for the continuous roll. It only prints; it edits no
 * settings file, so you merge the output into your own `settings.json` (or `settings.local.json`) yourself.
 *
 *   print-settings-snippet.ts [--project <name>] [--vault <ledger-root>]
 *
 * PreCompact runs precompact.ts (timeout 120 s, above the 45 s the hook gives its own handoff). SessionStart with matcher
 * `compact|clear` runs session-start-compact.ts (timeout 120 s; each command it runs is capped at 60 s).
 * SessionEnd with matcher `clear|resume|logout|prompt_input_exit|other` runs session-end-decisions.ts, the decision scan alone
 * (timeout 30 s; SessionEnd hooks otherwise get 1.5 s and never more than 60 s).
 * PreToolUse with matcher `Bash` runs git-guard.ts (timeout 10 s), which takes no flags: it asks before risky git commands.
 * `--project` and `--vault` are passed through to the three roll hooks, not to git-guard.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = dirname(fileURLToPath(import.meta.url));
const shq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

/** The settings object for the three hooks; `extra` is the shell-quoted pass-through flags. */
export function snippet(extra: string[]): object {
  const cmd = (file: string): string => ['node', shq(join(HOOKS, file)), ...extra].join(' ');
  return {
    hooks: {
      PreCompact: [{ matcher: 'auto|manual', hooks: [{ type: 'command', command: cmd('precompact.ts'), timeout: 120 }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: ['node', shq(join(HOOKS, 'git-guard.ts'))].join(' '), timeout: 10 }] }],
      SessionEnd: [{ matcher: 'clear|resume|logout|prompt_input_exit|other', hooks: [{ type: 'command', command: cmd('session-end-decisions.ts'), timeout: 30 }] }],
      SessionStart: [{ matcher: 'compact|clear', hooks: [{ type: 'command', command: cmd('session-start-compact.ts'), timeout: 120 }] }],
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const extra = ['project', 'vault'].flatMap((f) => { const k = process.argv.indexOf(`--${f}`); return k >= 0 && process.argv[k + 1] ? [`--${f}`, shq(process.argv[k + 1])] : []; });
  console.log(JSON.stringify(snippet(extra), null, 2));
  console.error('Printed only: merge the "hooks" entries into your settings file yourself. Nothing was edited.');
}
