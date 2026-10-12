/**
 * One seam for the external tools the scripts call (`gh`, `git`, the event loop), so a test can stand in for one
 * without writing an executable file: macOS stalls the first run of any newly written executable for minutes.
 *
 * A tool named by an env var `X` is run as `$X` followed by the JSON array of strings in `X_ARGS`, then the call's own
 * arguments. A test sets `X` to an interpreter that is already on the machine (node, /bin/sh) and `X_ARGS` to
 * `["<script>"]`. `X_ARGS` is parsed as JSON and nothing else, never split by a shell. With `X` unset, which is every
 * production run, the tool is called by name exactly as before and `X_ARGS` is not read.
 */

/** The env var that stands in for each tool the scripts look up by name. */
const TOOL_VARS: Record<string, string> = { gh: 'MAESTRO_GH_BIN', git: 'MAESTRO_GIT_BIN' };

/** The command and leading arguments for `varName`, or `fallback` when the variable is unset or empty. */
export function overrideCommand(varName: string, fallback: string, args: string[], env: NodeJS.ProcessEnv = process.env): [string, string[]] {
  const bin = env[varName];
  if (!bin) return [fallback, args];
  const raw = env[`${varName}_ARGS`];
  return [bin, [...(raw ? parseArgv(varName, raw) : []), ...args]];
}

/** `cmd` and `args` as they should be spawned: through the seam when `cmd` is gh or git and its env var is set, else untouched. */
export function toolCommand(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): [string, string[]] {
  const varName = TOOL_VARS[cmd];
  return varName ? overrideCommand(varName, cmd, args, env) : [cmd, args];
}

function parseArgv(varName: string, raw: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`${varName}_ARGS must be a JSON array of strings`); }
  if (!Array.isArray(parsed) || parsed.some((a) => typeof a !== 'string')) throw new Error(`${varName}_ARGS must be a JSON array of strings`);
  return parsed as string[];
}
