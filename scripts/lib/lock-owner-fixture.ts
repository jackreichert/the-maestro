/**
 * Test fixture: a process whose command line names `event-loop.ts`, so `lockHolder` accepts it as a loop. It sleeps and ends by itself
 * after `seconds` (default 60), so a test that dies before `stop()` leaves nothing behind for long.
 */
import { spawn } from 'node:child_process';

export function startLockOwner(seconds = 60): { pid: number; stop: () => void } {
  const child = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${Math.round(seconds * 1000)})`, 'event-loop.ts'], { stdio: 'ignore' });
  child.unref();
  if (child.pid === undefined) throw new Error('could not start the lock owner fixture');
  return { pid: child.pid, stop: () => { child.kill('SIGKILL'); } };
}
