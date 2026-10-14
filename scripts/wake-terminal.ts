#!/usr/bin/env node
/**
 * wake-terminal.ts: opens a new interactive Terminal window running `claude "<prompt>"`. It is the macOS `wake_launch_command`:
 *
 *   wake_launch_command: ["node", "/path/to/scripts/wake-terminal.ts"]
 *
 * The loop supervisor appends one argument, the fixed wake prompt (lib/session-wake.ts). Usage: wake-terminal.ts [--cwd <dir>] [--claude <bin>] <prompt>
 *
 * The session runs in the user's normal settings and permission mode, so this script refuses every permission flag and any option it does not
 * know, rather than passing it on: a launched session can never be made more permissive from config or argv. It writes a short `.command`
 * file (mode 700, in a fresh temp directory) and `open -a Terminal`s it, which needs no Accessibility permission.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTAINER_ROOT } from './local-config.ts';

const PERMISSION_FLAG = /dangerously|permission-mode|allowed-?tools|disallowed-?tools|bypass/i;
const USAGE = 'Usage: wake-terminal.ts [--cwd <dir>] [--claude <bin>] <prompt>';

export interface Launch { cwd: string; claude: string; prompt: string }

/** Quotes text as one shell word, so nothing in it is interpreted. */
export const shellQuote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

/** The launch described by argv; throws on a permission flag, an unknown option, or anything but exactly one prompt. */
export function parseLaunch(argv: string[], defaultCwd: string = CONTAINER_ROOT || homedir()): Launch {
  let cwd = defaultCwd;
  let claude = 'claude';
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (PERMISSION_FLAG.test(a) && a.startsWith('-')) throw new Error(`refusing ${a}: a launched session always runs in the default permission mode`);
    if (a === '--cwd' || a === '--claude') {
      const v = argv[i + 1];
      if (!v) throw new Error(`${a} needs a value`);
      if (a === '--cwd') cwd = v; else claude = v;
      i += 1;
    } else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else positional.push(a);
  }
  if (positional.length !== 1) throw new Error(USAGE);
  return { cwd, claude, prompt: positional[0] as string };
}

/** The `.command` file body. */
export const commandScript = ({ cwd, claude, prompt }: Launch): string => `#!/bin/zsh\ncd ${shellQuote(cwd)} || exit 1\nexec ${shellQuote(claude)} ${shellQuote(prompt)}\n`;

function main(argv: string[]): number {
  let launch: Launch;
  try { launch = parseLaunch(argv); } catch (err) { console.error(`wake-terminal: ${err instanceof Error ? err.message : String(err)}`); return 2; }
  const file = join(mkdtempSync(join(tmpdir(), 'wake-terminal-')), 'wake.command');
  writeFileSync(file, commandScript(launch), { mode: 0o700 });
  chmodSync(file, 0o700);
  const r = spawnSync('open', ['-a', 'Terminal', file], { stdio: 'ignore', timeout: 15_000 });
  return r.status === 0 ? 0 : 1;
}

const isMain = (): boolean => { try { return realpathSync(process.argv[1] as string) === fileURLToPath(import.meta.url); } catch { return false; } };
if (process.argv[1] && isMain()) process.exitCode = main(process.argv.slice(2));
