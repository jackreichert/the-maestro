#!/usr/bin/env node
/**
 * shutdown.ts: stops the loop supervisor and the Podium web server before travel or a power-off. Dry run by default: it prints exactly what it would stop.
 *
 *   shutdown.ts [--apply] [--roll]
 *
 *   (none)   dry run: lists each step as `would ...` and changes nothing.
 *   --apply  does it: `launchctl bootout` for the supervisor and, when it runs under launchd, the Podium; then SIGTERM to a detached Podium
 *            (a process listening on the Podium port whose command is `.../scripts/web.ts --port <port>`; nothing else is ever signalled).
 *   --roll   first runs the end-of-day sequence (reference/ledger.md#end-of-day): `journal.ts triage`, `roll`, `handoff --all --delta`.
 *            A step that fails stops the run before anything is stopped.
 *
 * MUTATES: launchd (bootout of the loop and Podium jobs) and a detached Podium process (SIGTERM); with --roll the ledger (roll, handoff).
 * GATE: --apply. A dry run only reads (`launchctl print`, `lsof`, `ps`) so it can say what is really running.
 * Never deletes a plist, the loop lock or the ledger, and never signals a process it cannot identify as the Podium server.
 * Rollback: `node scripts/session-start.ts` brings the supervisor and the Podium back (plists stay installed, so it loads them again).
 * Exit 0 done (or dry run), 1 a step failed, 2 usage or configuration error.
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { WEB_LABEL, portFromUri } from './install-podium-web.ts';
import { bootout, currentUid, isLoaded, realLaunchctl } from './lib/launchd.ts';
import type { Launchctl } from './lib/launchd.ts';
import { LABEL } from './lib/supervisor-state.ts';
import { CONTAINER_PROJECT, LEDGER_ROOT, STATUS_PAGE_URI_SETTING } from './local-config.ts';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));

/** The end-of-day sequence `--roll` runs first, as journal.ts arguments. */
export const ROLL_STEPS: readonly (readonly string[])[] = [['triage'], ['roll'], ['handoff', '--all', '--delta']];

/** Everything shutdown reads from or does to the machine; tests replace it. */
export interface ShutdownEnv {
  launchctl: Launchctl;
  uid: number;
  /** The port the Podium serves on (from the footer link, else the default). */
  port: number;
  /** Pids listening on the port. */
  listeners: (port: number) => number[];
  /** The command line of a pid, or '' when unreadable. */
  commandOf: (pid: number) => string;
  /** SIGTERM to a pid; throws when it cannot be signalled. */
  terminate: (pid: number) => void;
  /** Runs one journal.ts command; `output` is what it printed. */
  runJournal: (args: readonly string[]) => { ok: boolean; output: string };
  sleep: (ms: number) => void;
}

export interface ShutdownReport { lines: string[]; failed: boolean }

/** True when `command` is the Podium server for `port`: a web.ts script run with `--port <port>`. */
export const isPodiumServer = (command: string, port: number): boolean =>
  /(?:^|\s)\S*\/scripts\/web\.ts(?:\s|$)/.test(command) && new RegExp(`(?:^|\\s)--port(?:\\s+|=)${port}(?:\\s|$)`).test(command);

/** Pids listening on the Podium port that are provably the Podium server. */
const detachedServers = (env: ShutdownEnv): number[] => env.listeners(env.port).filter((pid) => isPodiumServer(env.commandOf(pid), env.port));

/** Plans (apply false) or performs (apply true) the shutdown, one line per step. */
export function shutdown({ apply, roll }: { apply: boolean; roll: boolean }, env: ShutdownEnv): ShutdownReport {
  const lines: string[] = [apply ? 'Shutdown (applying):' : 'Shutdown dry run (nothing changed; pass --apply to do this):'];
  let failed = false;
  if (roll) {
    if (!apply) lines.push(`would run the end-of-day sequence first: ${ROLL_STEPS.map((s) => `journal.ts ${s.join(' ')}`).join(', then ')}`);
    else for (const step of ROLL_STEPS) {
      const r = env.runJournal(step);
      lines.push(`journal.ts ${step.join(' ')}: ${r.ok ? 'done' : 'FAILED'}`);
      if (r.output.trim()) lines.push(r.output.trim());
      if (!r.ok) return { lines: [...lines, 'Stopped before stopping anything: fix the step above and rerun.'], failed: true };
    }
  }
  /** Returns false when the job was loaded and could not be booted out. */
  const stopJob = (label: string, what: string): boolean => {
    if (!isLoaded(env.launchctl, env.uid, label)) { lines.push(`${what}: not loaded in launchd, nothing to stop`); return true; }
    if (!apply) { lines.push(`would run: launchctl bootout gui/${env.uid}/${label}  (stops ${what}; the plist stays installed)`); return true; }
    const r = bootout(env.launchctl, env.uid, label);
    failed ||= !r.ok;
    lines.push(r.ok ? `${what}: stopped (launchctl bootout gui/${env.uid}/${label})` : `${what}: bootout FAILED (${r.output || 'no output'})`);
    return r.ok;
  };
  stopJob(LABEL, 'loop supervisor');
  const webLoaded = isLoaded(env.launchctl, env.uid, WEB_LABEL);
  const webStopped = stopJob(WEB_LABEL, 'Podium (launchd)');
  // After a bootout the launchd-run server is gone, so whatever still serves the port is a detached one. In a dry run a launchd-run server would show here too, so it is only listed when the job is not loaded.
  const pids = (!apply && webLoaded) || !webStopped ? [] : detachedServers(env);
  if (!webStopped) lines.push(`Podium (detached): skipped, the launchd job still owns port ${env.port} and a SIGTERM would only make launchd restart it`);
  else if (!apply && webLoaded) lines.push(`Podium (detached): the launchd job above owns port ${env.port}`);
  else if (!pids.length) lines.push(`Podium (detached): nothing of ours listens on port ${env.port}`);
  else if (!apply) pids.forEach((pid) => lines.push(`would run: kill -TERM ${pid}  (the detached Podium on port ${env.port}: ${env.commandOf(pid)})`));
  else {
    for (const pid of pids) {
      try { env.terminate(pid); lines.push(`Podium (detached): sent SIGTERM to pid ${pid}`); } catch (err) { failed = true; lines.push(`Podium (detached): could not signal pid ${pid} (${err instanceof Error ? err.message : String(err)})`); }
    }
    for (let waited = 0; waited < 3000 && detachedServers(env).length; waited += 250) env.sleep(250);
    const left = detachedServers(env);
    if (left.length) { failed = true; lines.push(`Podium (detached): pid ${left.join(', ')} still listens on port ${env.port} after 3 s; not killed harder (SIGTERM only)`); }
  }
  lines.push(apply ? 'Done. Bring everything back with: node scripts/session-start.ts' : 'Dry run only. Rollback after --apply: node scripts/session-start.ts');
  return { lines, failed };
}

/** The real machine. */
function realEnv(): ShutdownEnv {
  return {
    launchctl: realLaunchctl, uid: currentUid(), port: portFromUri(STATUS_PAGE_URI_SETTING),
    listeners: (port) => {
      const r = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', timeout: 10_000 });
      return (r.stdout ?? '').split('\n').map(Number).filter((n) => Number.isInteger(n) && n > 1);
    },
    commandOf: (pid) => spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000 }).stdout?.trim() ?? '',
    terminate: (pid) => { process.kill(pid, 'SIGTERM'); },
    runJournal: (args) => {
      const r = spawnSync(process.execPath, [join(SCRIPTS, 'journal.ts'), ...args, '--vault', LEDGER_ROOT, '--project', CONTAINER_PROJECT], { encoding: 'utf8', timeout: 10 * 60_000 });
      return { ok: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
    },
    sleep: (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); },
  };
}

function main(argv: string[]): number {
  let values: { apply?: boolean; roll?: boolean };
  try { values = parseArgs({ args: argv, options: { apply: { type: 'boolean' }, roll: { type: 'boolean' } } }).values; } catch (err) { console.error(`shutdown: ${err instanceof Error ? err.message : String(err)}`); return 2; }
  if (values.roll && !LEDGER_ROOT) { console.error('shutdown: --roll needs a ledger root; set LEDGER_ROOT (or ledger_root in the config)'); return 2; }
  const report = shutdown({ apply: !!values.apply, roll: !!values.roll }, realEnv());
  console.log(report.lines.join('\n'));
  return report.failed ? 1 : 0;
}

const isMain = () => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };
if (process.argv[1] && isMain()) process.exitCode = main(process.argv.slice(2));
