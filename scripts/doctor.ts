#!/usr/bin/env node
/**
 * doctor.ts: a read-only health check for a maestro install. It reports; it never fixes, edits a settings file or runs a fixing command.
 *
 *   doctor.ts [--settings <file>]... [--json]
 *
 * Checks: every hook the snippet prints is registered (guards included), registered hooks and the skill symlink run from the runtime
 * worktree, the runtime and the overlay checkout are not behind origin/main, and nothing is installed twice. A settings file is read only
 * for its `hooks` key, and only script paths are printed. Default settings files: ~/.claude/settings.json and settings.local.json, and the
 * same two under ./.claude. Exit 0 when nothing is wrong, 1 when a check warns, 2 on bad usage.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { overlayPath } from './local-config.ts';
import { snippet } from './hooks/print-settings-snippet.ts';
import { printJson } from './lib/json-out.ts';
import { runtimeBehind, runtimeWorktree } from './lib/runtime-resync.ts';
import {
  checkBehind, checkDuplicateInstalls, checkHookLocation, checkRegistered, checkSkillLocation, expectedHookFiles, hookCommands, render,
  type CheckResult, type HookCommand, type InstallFacts,
} from './lib/doctor.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const claude = join(homedir(), '.claude');

const READ_ONLY_GIT = new Set(['rev-parse', 'rev-list']);

/** git in `cwd`, restricted to the two read-only subcommands the checks use. */
const gitIn = (cwd: string) => (args: string[]) => {
  if (!READ_ONLY_GIT.has(args[0])) throw new Error(`doctor is read-only: git ${args[0]} is not allowed`);
  const r = spawnSync('git', ['--no-optional-locks', ...args], { cwd, encoding: 'utf8', timeout: 30_000 });
  return { status: r.status ?? 1, stdout: r.stdout ?? '' };
};

/** Commits the local origin/main ref has that the checkout at `dir` lacks; undefined when `dir` is not a readable checkout. */
function behindMain(dir: string | undefined): { behind: number } | null | undefined {
  if (!dir || !existsSync(dir)) return undefined;
  const git = gitIn(dir);
  if (git(['rev-parse', '--git-dir']).status !== 0 || git(['rev-parse', 'refs/remotes/origin/main']).status !== 0) return undefined;
  return runtimeBehind(git);
}

function readSettings(files: string[]): { read: string[]; commands: HookCommand[] } {
  const read: string[] = [];
  const commands: HookCommand[] = [];
  for (const f of files) {
    try { commands.push(...hookCommands(JSON.parse(readFileSync(f, 'utf8')))); read.push(f); } catch { /* absent or unreadable: not counted as read */ }
  }
  return { read, commands };
}

/** The real directory holding `file`, or undefined when a link is dangling. */
const resolvedDir = (file: string): string | undefined => { try { return dirname(realpathSync(file)); } catch { return undefined; } };

const names = (dir: string): string[] => { try { return readdirSync(dir); } catch { return []; } };

function installFacts(): InstallFacts {
  let plugins: string[] = [];
  try {
    const installed = JSON.parse(readFileSync(join(claude, 'plugins', 'installed_plugins.json'), 'utf8')) as { plugins?: Record<string, unknown> };
    plugins = Object.keys(installed.plugins ?? {}).map((k) => k.split('@')[0]);
  } catch { /* no plugin registry */ }
  const loose = [...names(join(claude, 'skills')), ...names(join(claude, 'commands')), ...names(join(claude, 'agents'))];
  const root = join(HERE, '..');
  const nestedClones = names(root).filter((n) => !n.startsWith('.') && n !== 'node_modules' && existsSync(join(root, n, '.git'))).map((n) => `${n}/ inside ${root}`);
  return { plugins, loose, nestedClones };
}

function main(): void {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const files: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--settings' && args[i + 1]) { files.push(args[i + 1]); i += 1; } else if (args[i] !== '--json') { console.error(`usage: doctor.ts [--settings <file>]... [--json] (unknown: ${args[i]})`); process.exit(2); }
  }
  const settingsFiles = files.length ? files : [join(claude, 'settings.json'), join(claude, 'settings.local.json'), join('.claude', 'settings.json'), join('.claude', 'settings.local.json')];
  const { read, commands } = readSettings(settingsFiles);
  const runtime = runtimeWorktree();
  const skill = join(claude, 'skills', 'the-maestro');
  const overlayDir = overlayPath ? resolvedDir(overlayPath) : undefined;
  const results: CheckResult[] = [
    checkRegistered(expectedHookFiles(snippet([])), commands, read),
    checkHookLocation(commands, runtime),
    checkSkillLocation(existsSync(skill) || lstatSync(skill, { throwIfNoEntry: false }) ? skill : undefined, runtime),
    checkBehind('runtime worktree current', runtime, behindMain(runtime)),
    checkBehind('overlay checkout current', overlayDir, behindMain(overlayDir)),
    checkDuplicateInstalls(installFacts()),
  ];
  if (json) printJson({ results }); else console.log(render(results));
  process.exit(results.some((r) => r.status === 'warn') ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
