/**
 * The user's own secret-file hook as an extra check on a block about to run. It lives in the user's home (not in this repo), so it is loaded
 * when present and skipped when not: command-guard.ts has its own matcher and never depends on this one.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ExtraGuard } from './command-guard.ts';

export const HOOK_PATH = join(homedir(), '.claude', 'hooks', 'secret-file-guard.mjs');

interface HookModule { decideSafely?: (input: unknown) => { block?: boolean; message?: string }; decide?: (input: unknown) => { block?: boolean; message?: string } }

/** The hook's decision as an ExtraGuard, or undefined when the hook is absent or does not export a decision function. A hook that throws refuses. */
export async function loadHookGuard(path: string = HOOK_PATH): Promise<ExtraGuard | undefined> {
  if (!existsSync(path)) return undefined;
  let mod: HookModule;
  try { mod = (await import(pathToFileURL(path).href)) as HookModule; } catch { return undefined; }
  const decide = mod.decideSafely ?? mod.decide;
  if (typeof decide !== 'function') return undefined;
  return (command) => {
    try {
      const out = decide({ tool_name: 'Bash', tool_input: { command }, cwd: homedir() });
      return out?.block ? 'The secret-file hook refuses this block.' : null;
    } catch { return 'The secret-file hook could not check this block.'; }
  };
}
