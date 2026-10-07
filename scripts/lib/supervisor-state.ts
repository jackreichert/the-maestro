/**
 * The loop supervisor's liveness record, so `prime` can say when the supervisor that should be keeping the loop alive is not.
 *
 * loop-supervisor.ts writes `<event_dir>/supervisor.json` ({ pid, startedAt }) when it starts and removes it when it is stopped
 * by SIGTERM or SIGINT. A record whose pid is gone means the supervisor died without being asked to stop (a crash, a kill -9, a
 * reboot). No record but an installed plist means launchd never started it or it was unloaded. Neither file means the supervisor
 * was never set up, which is silent: an install that does not use one is not nagged. The pid check is `kill -0`, so a pid reused
 * by an unrelated process after a reboot reads as running until the supervisor starts again and overwrites the record.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const LABEL = 'com.jackreichert.the-maestro-loop';

export interface SupervisorRecord { pid: number; startedAt: string }
/** `absent`: never set up. `running`: the recorded pid is alive. `dead`: set up, but nothing is running. */
export interface SupervisorStatus { state: 'absent' | 'running' | 'dead'; pid?: number; startedAt?: string; plist?: string; line: string }

/** Where launchd's per-user agents live; MAESTRO_LAUNCH_AGENTS_DIR moves it (tests, unusual setups). */
export const launchAgentsDir = (): string => process.env.MAESTRO_LAUNCH_AGENTS_DIR || join(homedir(), 'Library', 'LaunchAgents');
export const plistPath = (): string => join(launchAgentsDir(), `${LABEL}.plist`);
export const recordPath = (eventDir: string): string => join(eventDir, 'supervisor.json');

const defaultAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (err) { return err instanceof Error && (err as NodeJS.ErrnoException).code === 'EPERM'; }
};

/** Writes the record by temp file and rename, so a reader never sees half of it. */
export function writeRecord(eventDir: string, pid: number, now: number = Date.now()): void {
  mkdirSync(eventDir, { recursive: true });
  const tmp = `${recordPath(eventDir)}.${pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ pid, startedAt: new Date(now).toISOString() }));
  renameSync(tmp, recordPath(eventDir));
}

/** Removes the record, but only when it is this pid's: a newer supervisor's record is not ours to delete. */
export function clearRecord(eventDir: string, pid: number): void {
  const record = readRecord(eventDir);
  if (record?.pid === pid) rmSync(recordPath(eventDir), { force: true });
}

/** The record, or null when there is none or it is not a { pid, startedAt } object. */
export function readRecord(eventDir: string): SupervisorRecord | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(recordPath(eventDir), 'utf8'));
    if (typeof raw !== 'object' || raw === null) return null;
    const { pid, startedAt } = raw as Partial<SupervisorRecord>;
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && typeof startedAt === 'string' ? { pid, startedAt } : null;
  } catch { return null; }
}

/** What state the supervisor is in, with the one line `prime` prints for `dead` (empty otherwise). `plist` and `alive` are injectable. */
export function supervisorStatus(eventDir: string, { plist = plistPath(), alive = defaultAlive }: { plist?: string; alive?: (pid: number) => boolean } = {}): SupervisorStatus {
  const record = readRecord(eventDir);
  const installed = existsSync(plist);
  const restart = `launchctl kickstart -k gui/${process.getuid?.() ?? 501}/${LABEL}`;
  if (record && alive(record.pid)) return { state: 'running', ...record, plist: installed ? plist : undefined, line: '' };
  if (record) return { state: 'dead', ...record, line: `Loop supervisor: DEAD (pid ${record.pid}, started ${record.startedAt}). Nothing is relaunching the event loop or saving digests. Restart: ${restart}` };
  if (installed) return { state: 'dead', plist, line: `Loop supervisor: NOT RUNNING (installed at ${plist}, never seen alive). Load it: node scripts/install-loop-supervisor.ts prints the command` };
  return { state: 'absent', line: '' };
}
