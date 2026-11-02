/**
 * launchd.ts: the few launchctl calls the maestro makes, behind an injectable runner so tests never touch the real launchctl.
 * Every function takes the runner first; `realLaunchctl` is the only place a process is spawned.
 */
import { spawnSync } from 'node:child_process';

export interface LaunchctlResult { ok: boolean; output: string }
/** Runs `launchctl <args>`. */
export type Launchctl = (args: string[]) => LaunchctlResult;

/** The real launchctl: ok on exit 0, output is the last line it printed (stderr first). A launchctl that cannot run is not ok. */
export const realLaunchctl: Launchctl = (args) => {
  const r = spawnSync('launchctl', args, { encoding: 'utf8', timeout: 15_000 });
  if (r.error) return { ok: false, output: r.error.message };
  return { ok: r.status === 0, output: `${r.stderr ?? ''}${r.stdout ?? ''}`.trim().split('\n').pop() ?? '' };
};

/** The numeric user id launchd's gui domain is keyed by. */
export const currentUid = (): number => process.getuid?.() ?? 501;

const target = (uid: number, label: string): string => `gui/${uid}/${label}`;

/** True when launchd knows the job (loaded), whether or not it is running. */
export const isLoaded = (launchctl: Launchctl, uid: number, label: string): boolean => launchctl(['print', target(uid, label)]).ok;
/** Loads a plist into the user's gui domain. */
export const bootstrap = (launchctl: Launchctl, uid: number, plist: string): LaunchctlResult => launchctl(['bootstrap', `gui/${uid}`, plist]);
/** Unloads a job: launchd stops it and forgets it. The plist file is left alone. */
export const bootout = (launchctl: Launchctl, uid: number, label: string): LaunchctlResult => launchctl(['bootout', target(uid, label)]);
/** Starts a loaded job; with `restart` kills a running one first (`-k`). Without it, a job that is already running is left alone. */
export const kickstart = (launchctl: Launchctl, uid: number, label: string, restart = false): LaunchctlResult => launchctl(['kickstart', ...(restart ? ['-k'] : []), target(uid, label)]);

/** Blocks the thread for `ms` (the callers are synchronous scripts that poll). */
export const sleepSync = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
