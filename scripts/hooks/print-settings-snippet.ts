#!/usr/bin/env node
/**
 * print-settings-snippet.ts: prints the Claude Code `hooks` settings for the continuous roll. It only prints; it edits no
 * settings file, so you merge the output into your own `settings.json` (or `settings.local.json`) yourself.
 *
 *   print-settings-snippet.ts [--project <name>] [--vault <ledger-root>]
 *
 * PreCompact runs precompact.ts (timeout 120 s, above the 100 s the hook gives its own handoff). SessionStart with matcher
 * `compact|clear` runs session-start-compact.ts (timeout 120 s; each command it runs is capped at 60 s).
 * `--project` and `--vault` are passed through to both hooks.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = dirname(fileURLToPath(import.meta.url));
const shq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

/** The settings object for the two hooks; `extra` is the shell-quoted pass-through flags. */
export function snippet(extra: string[]): object {
  const cmd = (file: string): string => ['node', shq(join(HOOKS, file)), ...extra].join(' ');
  return {
    hooks: {
      PreCompact: [{ matcher: 'auto|manual', hooks: [{ type: 'command', command: cmd('precompact.ts'), timeout: 120 }] }],
      SessionStart: [{ matcher: 'compact|clear', hooks: [{ type: 'command', command: cmd('session-start-compact.ts'), timeout: 120 }] }],
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const extra = ['project', 'vault'].flatMap((f) => { const k = process.argv.indexOf(`--${f}`); return k >= 0 && process.argv[k + 1] ? [`--${f}`, shq(process.argv[k + 1])] : []; });
  console.log(JSON.stringify(snippet(extra), null, 2));
  console.error('Printed only: merge the "hooks" entries into your settings file yourself. Nothing was edited.');
}
