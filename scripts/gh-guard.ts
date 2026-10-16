#!/usr/bin/env node
/**
 * GH GUARD: the one door every production `gh` call goes through (lib/tool-bin.ts points `gh` here).
 *
 *   node scripts/gh-guard.ts <gh arguments...>
 *
 * It does three things around the real `gh`, and passes its stdout and exit status through untouched:
 *   - logs the call (scripts/gh-budget.ts report prints calls per hour by caller);
 *   - for a GraphQL call, reads the real budget from the GraphQL `rateLimit` field at most every two minutes and, under the floor or
 *     while GitHub is refusing calls, fails fast with "GitHub limited until HH:MM" instead of sending a call that will fail;
 *   - when a call comes back rate-limited, starts a backoff, so a limited account stops being hammered by every poller on every tick.
 * `MAESTRO_GH_GUARD=off` bypasses it (lib/tool-bin.ts then calls `gh` directly).
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVENT_DIR, WATCH_TZ } from './local-config.ts';
import { appendCall, applyFailure, applyProbe, blockedUntil, classifyGh, isRateLimitError, limitedText, needsProbe, readState, writeState } from './lib/gh-budget.ts';

const PROBE_QUERY = 'query{rateLimit{limit remaining resetAt}}';

export interface GuardDeps {
  dir: string;
  now: () => number;
  /** Runs the real gh with the given arguments; stdout goes straight through, stderr comes back. */
  gh: (args: string[], passStdout: boolean) => { status: number | null; stdout: string; stderr: string };
  caller: string;
  tz?: string;
  err: (text: string) => void;
}

/** The script that spawned this guard (its parent's first .ts or .mjs argument), or MAESTRO_GH_CALLER; `unknown` when neither is readable. */
export function callerName(env: NodeJS.ProcessEnv = process.env, ppid: number = process.ppid): string {
  if (env.MAESTRO_GH_CALLER) return env.MAESTRO_GH_CALLER;
  try {
    const r = spawnSync('ps', ['-o', 'command=', '-p', String(ppid)], { encoding: 'utf8', timeout: 2000 });
    const script = (r.stdout ?? '').split(/\s+/).find((t) => /\.(ts|mjs|js)$/.test(t));
    return script ? basename(script) : 'unknown';
  } catch { return 'unknown'; }
}

/** One probe of the GraphQL budget; a rate-limited probe is itself the answer. Anything else (no network) leaves the state alone, apart from when it was tried. */
function probe(deps: GuardDeps): void {
  const now = deps.now();
  const r = deps.gh(['api', 'graphql', '-f', `query=${PROBE_QUERY}`], false);
  const state = readState(deps.dir);
  try {
    const data = (JSON.parse(r.stdout) as { data?: { rateLimit?: { limit: number; remaining: number; resetAt: string } } }).data?.rateLimit;
    if (r.status === 0 && data) { writeState(deps.dir, applyProbe(state, { remaining: data.remaining, limit: data.limit, resetAt: Date.parse(data.resetAt) }, now)); return; }
  } catch { /* fall through to the failure paths */ }
  writeState(deps.dir, isRateLimitError(r.stderr) ? applyFailure(state, now) : { ...state, probedAt: now });
}

/** Runs one gh call under the guard and returns its exit status. */
export function runGuarded(args: string[], deps: GuardDeps): number {
  const kind = classifyGh(args);
  const cmd = args.filter((a) => !a.startsWith('-')).slice(0, 2).join(' ');
  if (kind === 'graphql') {
    if (needsProbe(readState(deps.dir), deps.now())) probe(deps);
    const state = readState(deps.dir);
    if (blockedUntil(state, deps.now()) !== null) {
      deps.err(`GitHub ${limitedText(state, deps.now(), deps.tz)}; this call was not sent (the-maestro gh guard)\n`);
      appendCall(deps.dir, { t: deps.now(), kind, caller: deps.caller, cmd: `${cmd} (blocked)`, status: 1 });
      return 1;
    }
  }
  const r = deps.gh(args, true);
  if (r.stderr) deps.err(r.stderr);
  appendCall(deps.dir, { t: deps.now(), kind, caller: deps.caller, cmd, status: r.status });
  if (kind === 'graphql' && r.status !== 0 && isRateLimitError(r.stderr)) writeState(deps.dir, applyFailure(readState(deps.dir), deps.now()));
  return r.status ?? 1;
}

const realGh: GuardDeps['gh'] = (args, passStdout) => {
  const r = spawnSync('gh', args, { encoding: 'utf8', stdio: ['inherit', passStdout ? 'inherit' : 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { status: 127, stdout: '', stderr: `${r.error.message}\n` };
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

const isMain = (): boolean => { try { return realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url); } catch { return false; } };
if (isMain()) {
  process.exitCode = runGuarded(process.argv.slice(2), { dir: EVENT_DIR, now: Date.now, gh: realGh, caller: callerName(), tz: WATCH_TZ, err: (t) => process.stderr.write(t) });
}
