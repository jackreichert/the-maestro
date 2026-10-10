#!/usr/bin/env node
/**
 * install-hooks.ts: prints the Claude Code `hooks` settings that run event-inject.ts on SessionStart and UserPromptSubmit.
 * It only prints; it never writes a settings file, so you merge the output into your own `settings.json` yourself.
 *
 *   install-hooks.ts
 *
 * Both entries have a 10 s timeout, far above the hook's own run time, which is local reads only and fails open. There is no Stop hook.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = dirname(fileURLToPath(import.meta.url));
const shq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

/** The settings object for the two event hooks. */
export function eventHooksSnippet(): object {
  const entry = { hooks: [{ type: 'command', command: `node ${shq(join(HOOKS, 'event-inject.ts'))}`, timeout: 10 }] };
  return { hooks: { SessionStart: [entry], UserPromptSubmit: [entry] } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(JSON.stringify(eventHooksSnippet(), null, 2));
  console.error('Printed only: merge the "hooks" entries into your settings file yourself. Nothing was edited.');
}
