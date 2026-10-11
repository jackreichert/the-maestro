#!/usr/bin/env node
/**
 * install-loop-supervisor.ts: fills the launchd plist template and PRINTS the launchctl commands. It never runs launchctl:
 * loading a LaunchAgent is a machine change you make yourself.
 *
 *   install-loop-supervisor.ts [--out <plist path>] [--log <log path>]
 *
 * Needs a ledger root (LEDGER_ROOT); digests and the supervisor log live under it. Refuses while any event loop holds the
 * lock, since launchd's loop would then exit 2 and sit idle. It also refuses, so there is only ever one runner, when another
 * `*maestro-loop*.plist` is in the LaunchAgents directory, and when this checkout is on a branch: launchd runs the supervisor
 * from this path after every relaunch, so it should be a runtime worktree detached at origin/main (`git worktree add --detach <path> origin/main`),
 * not a checkout whose branch an agent can move. `--allow-branch` overrides the branch check. Exit 0 wrote the plist, 2 refused or misconfigured.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { LABEL, launchAgentsDir, supervisorLogPath } from './lib/supervisor-state.ts';
import { lockHolder } from './lib/watch-registry.ts';
import { CONTAINER_PROJECT, EVENT_DIR, LEDGER_ROOT } from './local-config.ts';

export { LABEL };
const TEMPLATE = fileURLToPath(new URL(`./launchd/${LABEL}.plist.template`, import.meta.url));
/** The checkout launchd will run the supervisor from: this one. MAESTRO_INSTALL_REPO is a test hook. */
const REPO = process.env.MAESTRO_INSTALL_REPO || dirname(dirname(fileURLToPath(import.meta.url)));
const BASE_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The template with every {{NAME}} replaced (XML-escaped); throws on a placeholder left without a value. */
export function fillTemplate(template: string, values: Record<string, string>): string {
  const filled = template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => (name in values ? xml(values[name]) : whole));
  const left = filled.match(/\{\{\w+\}\}/);
  if (left) throw new Error(`placeholder ${left[0]} has no value`);
  return filled;
}

/** A shell-safe single-quoted word: each embedded single quote becomes '\''. */
export const shq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

/** The commands the user runs, in order. `uid` is the numeric user id launchd's gui domain is keyed by. */
export const commands = (plist: string, uid: number): { load: string; check: string; restart: string; unload: string } => ({
  load: `launchctl bootstrap gui/${uid} ${shq(plist)}`,
  check: `launchctl print gui/${uid}/${LABEL}`,
  restart: `launchctl kickstart -k gui/${uid}/${LABEL}`,
  unload: `launchctl bootout gui/${uid}/${LABEL}`,
});

/** Other maestro-loop plists in `dir` (not `ours`): a second one would start a second runner. Sorted, full paths. */
export function otherLoopPlists(dir: string, ours: string): string[] {
  try { return readdirSync(dir).filter((f) => /maestro-loop.*\.plist$/.test(f) && join(dir, f) !== ours).sort().map((f) => join(dir, f)); } catch { return []; }
}

/** The branch `repo` has checked out, or null when HEAD is detached (the runtime worktree) or `repo` is not a git checkout. */
export function checkedOutBranch(repo: string): string | null {
  const r = spawnSync('git', ['-C', repo, 'symbolic-ref', '--short', '-q', 'HEAD'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

function main(argv: string[]): number {
  const fail = (msg: string): number => { console.error(`install-loop-supervisor: ${msg}`); return 2; };
  const { values: v } = parseArgs({ args: argv, options: { out: { type: 'string' }, log: { type: 'string' }, 'allow-branch': { type: 'boolean' } } });
  if (!LEDGER_ROOT) return fail('no ledger root; set LEDGER_ROOT (or ledger_root in the config)');
  const holder = lockHolder(EVENT_DIR);
  if (holder !== null) {
    return fail(`an event loop holds the lock (pid ${holder}). Stop it first: end the session's background \`event-loop.ts run\` task, or \`kill ${holder}\` (the lock releases on SIGTERM); if launchd already runs the supervisor, \`launchctl bootout\` it. Never delete the lock file.`);
  }
  const out = v.out ?? join(launchAgentsDir(), `${LABEL}.plist`);
  const others = otherLoopPlists(launchAgentsDir(), out);
  if (others.length) return fail(`another loop plist is installed: ${others.join(', ')}. Two would run two loops over one registry. Unload it (launchctl bootout) and remove the file first.`);
  const branch = checkedOutBranch(REPO);
  if (branch && !v['allow-branch']) return fail(`${REPO} is on branch ${branch}, and launchd would run whatever that branch holds after every relaunch. Install from a runtime worktree detached at origin/main: git worktree add --detach <path> origin/main (or pass --allow-branch).`);
  const log = v.log ?? supervisorLogPath(LEDGER_ROOT, CONTAINER_PROJECT);
  const path = [...new Set([dirname(process.execPath), ...BASE_PATH])].join(':');
  const plist = fillTemplate(readFileSync(TEMPLATE, 'utf8'), { NODE: realpathSync(process.execPath), REPO, LEDGER_ROOT, PROJECT: CONTAINER_PROJECT, LOG: log, PATH: path });
  mkdirSync(dirname(out), { recursive: true });
  mkdirSync(dirname(log), { recursive: true });
  writeFileSync(out, plist);
  const c = commands(out, process.getuid?.() ?? 501);
  console.log(`wrote ${out}\nrepo ${REPO}${branch ? `  (on branch ${branch}, allowed by --allow-branch)` : ''}\n\nload:    ${c.load}\ncheck:   ${c.check}\nrestart: ${c.restart}\nunload:  ${c.unload}\nlog:     ${log}\n\nNothing was loaded. Run the load command yourself.`);
  return 0;
}

const isMain = () => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };
if (process.argv[1] && isMain()) process.exitCode = main(process.argv.slice(2));
