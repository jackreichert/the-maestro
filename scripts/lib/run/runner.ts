/**
 * RUNNER: runs one reviewed command in a child process and keeps what it printed, scrubbed, for the page to poll.
 *
 * A command is either a shell block (`/bin/zsh -c <block>` in the user's home directory) or an argv vector (no shell at all, so nothing in it is
 * ever expanded). Each runs in its own process group so a kill or a timeout takes its children too. Output is read as lines and every line the
 * secret scan flags is replaced by a marker before it is stored, so a secret never reaches the page or the ledger summary. The environment is passed
 * to the child but never printed by this module. At most one run per key at a time, and at most MAX_ACTIVE at once; a refused start leaves nothing behind.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { withhold } from '../withhold.ts';

export type Spec = { kind: 'shell'; command: string } | { kind: 'argv'; argv: string[]; cwd: string };
export type Status = 'running' | 'done' | 'failed' | 'killed' | 'timeout';
export interface Chunk { seq: number; stream: 'out' | 'err'; text: string }
export interface RunView { runId: string; key: string; status: Status; exitCode: number | null; durationMs: number | null; chunks: Chunk[]; next: number; truncated: boolean }

export const MAX_ACTIVE = 4;
export const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_PARTIAL = 8 * 1024;
const KEEP_RUNS = 20;
const KILL_GRACE_MS = 3000;

interface Run {
  runId: string; key: string; source: string; target: string; sha256: string;
  status: Status; exitCode: number | null; startedMs: number; durationMs: number | null;
  chunks: Chunk[]; bytes: number; truncated: boolean; child: ChildProcess | null; kill: 'killed' | 'timeout' | null;
}

export interface RunnerOptions {
  home: string;
  now?: () => number;
  /** The shell for a shell block (default /bin/zsh). Tests pass /bin/sh. */
  shell?: string;
  /** Called once when a run ends, with what the ledger row needs: never the output. */
  onDone?: (r: { runId: string; key: string; source: string; target: string; sha256: string; status: Status; exitCode: number | null; durationMs: number }) => void;
  log?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
}

export type StartResult = { ok: true; runId: string } | { ok: false; code: 'busy' | 'full' | 'spawn' };

export function createRunner(o: RunnerOptions) {
  const now = o.now ?? Date.now;
  const runs = new Map<string, Run>();
  const log = o.log ?? (() => {});

  const active = (): Run[] => [...runs.values()].filter((r) => r.status === 'running');

  function start(key: string, meta: { source: string; target: string; sha256: string }, spec: Spec, timeoutMs: number): StartResult {
    if (active().some((r) => r.key === key)) return { ok: false, code: 'busy' };
    if (active().length >= MAX_ACTIVE) return { ok: false, code: 'full' };
    const run: Run = { runId: randomBytes(12).toString('hex'), key, ...meta, status: 'running', exitCode: null, startedMs: now(), durationMs: null, chunks: [], bytes: 0, truncated: false, child: null, kill: null };
    let child: ChildProcess;
    try {
      const env = o.env ?? process.env;
      child = spec.kind === 'shell'
        ? spawn(o.shell ?? '/bin/zsh', ['-c', spec.command], { cwd: o.home, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
        : spawn(spec.argv[0]!, spec.argv.slice(1), { cwd: spec.cwd, env, detached: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      log(`could not start a run: ${e instanceof Error ? e.message.split('\n')[0] : 'error'}`);
      return { ok: false, code: 'spawn' };
    }
    run.child = child;
    runs.set(run.runId, run);
    trim();
    const parts = { out: '', err: '' };
    const flush = (stream: 'out' | 'err', all: boolean): void => {
      let buf = parts[stream];
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) { push(run, stream, buf.slice(0, nl + 1)); buf = buf.slice(nl + 1); }
      if (all || buf.length > MAX_PARTIAL) { if (buf) push(run, stream, buf); buf = ''; }
      parts[stream] = buf;
    };
    for (const [stream, src] of [['out', child.stdout], ['err', child.stderr]] as const) {
      src?.setEncoding('utf8');
      src?.on('data', (d: string) => { parts[stream] += d; flush(stream, false); });
    }
    const timer = setTimeout(() => stop(run, 'timeout'), timeoutMs);
    let finished = false;
    const finish = (code: number | null, failed: boolean): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      flush('out', true); flush('err', true);
      run.durationMs = now() - run.startedMs;
      run.exitCode = code;
      run.status = run.kill ?? (failed ? 'failed' : 'done');
      run.child = null;
      try { o.onDone?.({ runId: run.runId, key, source: run.source, target: run.target, sha256: run.sha256, status: run.status, exitCode: code, durationMs: run.durationMs }); } catch (e) { log(`run record failed: ${e instanceof Error ? e.message.split('\n')[0] : 'error'}`); }
    };
    child.once('error', () => finish(null, true));
    child.once('close', (code) => finish(code, false));
    return { ok: true, runId: run.runId };
  }

  /** Asks the whole process group to stop, then forces it. A run already over is left alone. */
  function stop(run: Run, why: 'killed' | 'timeout'): void {
    const pid = run.child?.pid;
    if (run.status !== 'running' || !pid) return;
    run.kill = why;
    const send = (sig: NodeJS.Signals): void => { try { process.kill(-pid, sig); } catch { try { run.child?.kill(sig); } catch { /* already gone */ } } };
    send('SIGTERM');
    setTimeout(() => { if (run.status === 'running') send('SIGKILL'); }, KILL_GRACE_MS).unref();
  }

  function push(run: Run, stream: 'out' | 'err', text: string): void {
    if (run.truncated) return;
    const clean = withhold(text.replace(/\r(?!\n)/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ''));
    run.bytes += Buffer.byteLength(clean);
    if (run.bytes > MAX_OUTPUT_BYTES) { run.truncated = true; run.chunks.push({ seq: run.chunks.length, stream: 'err', text: '[output truncated]\n' }); return; }
    run.chunks.push({ seq: run.chunks.length, stream, text: clean });
  }

  function trim(): void {
    const done = [...runs.values()].filter((r) => r.status !== 'running');
    for (const r of done.slice(0, Math.max(0, done.length - KEEP_RUNS))) runs.delete(r.runId);
  }

  /** What the page needs: the status and the chunks from `since`. Null for an unknown run id. */
  function view(runId: string, since = 0): RunView | null {
    const r = runs.get(runId);
    if (!r) return null;
    const from = Math.max(0, Math.floor(since) || 0);
    return { runId, key: r.key, status: r.status, exitCode: r.exitCode, durationMs: r.durationMs, chunks: r.chunks.slice(from), next: r.chunks.length, truncated: r.truncated };
  }

  function kill(runId: string): boolean {
    const r = runs.get(runId);
    if (!r || r.status !== 'running') return false;
    stop(r, 'killed');
    return true;
  }

  const info = (runId: string): { key: string; source: string; target: string; status: Status; exitCode: number | null; durationMs: number | null; tail: string } | null => {
    const r = runs.get(runId);
    return r ? { key: r.key, source: r.source, target: r.target, status: r.status, exitCode: r.exitCode, durationMs: r.durationMs, tail: r.chunks.map((c) => c.text).join('') } : null;
  };

  /** Stops every active run (server shutdown). */
  const killAll = (): void => { for (const r of active()) stop(r, 'killed'); };

  return { start, view, kill, info, killAll, activeKeys: (): string[] => active().map((r) => r.key) };
}

export type Runner = ReturnType<typeof createRunner>;
