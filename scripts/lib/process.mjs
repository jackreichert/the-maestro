import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {hash, requireValue} from '../storage.mjs';

export function processIdentity(pid) {
  requireValue(Number.isInteger(pid) && pid > 0, 'Invalid process ID');
  let output;
  try {
    output = execFileSync('ps', ['-p', String(pid), '-o', 'ppid=', '-o', 'lstart=', '-o', 'comm='],
      {encoding: 'utf8', timeout: 3000, env: {...process.env, LC_ALL: 'C'}});
  } catch (error) {
    if (error.status === 1 && !String(error.stdout ?? '').trim()) return null;
    throw new Error('Cannot verify process identity');
  }
  const match = output.trim().match(/^(\d+)\s+(\w+\s+\w+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.+)$/);
  requireValue(match, 'Unrecognized process identity');
  const started = match[2].replace(/\s+/g, ' ');
  return {pid, parent: Number(match[1]), started, executable: path.basename(match[3]),
    key: hash(`${pid}:${started}`).slice(0, 32)};
}

export function alive(identity) {
  return processIdentity(identity.pid)?.key === identity.key;
}

export function claudeProcess() {
  let pid = process.ppid;
  for (let depth = 0; pid > 1 && depth < 20; depth++) {
    const identity = processIdentity(pid);
    if (!identity) break;
    if (/^claude(?:-\d+(?:\.\d+)*)?$/.test(identity.executable)) return identity;
    pid = identity.parent;
  }
  throw new Error('No verified Claude ancestor; hook/listener/ack requires a local Claude Code process');
}
