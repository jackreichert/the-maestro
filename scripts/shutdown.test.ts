/** shutdown: dry run changes nothing, --apply stops exactly the loop and Podium jobs and an identified detached server; all against fakes. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { ROLL_STEPS, isPodiumServer, shutdown } from './shutdown.ts';
import type { ShutdownEnv } from './shutdown.ts';
import { cleanEnv } from './lib/test-env.ts';
import { LABEL } from './lib/supervisor-state.ts';
import { WEB_LABEL } from './install-podium-web.ts';

const WEB_CMD = '/usr/local/bin/node /r/scripts/web.ts --port 47700 --vault /l --project p';

/** A fake machine: `loaded` labels answer `print`; `servers` maps a listening pid to its command; terminating a pid removes it. Records everything done. */
function machine(opts: { loaded?: string[]; servers?: Record<number, string>; journalFails?: string; terminateThrows?: boolean; ignoreTerm?: boolean } = {}) {
  const loaded = new Set(opts.loaded ?? []);
  const servers = new Map(Object.entries(opts.servers ?? {}).map(([pid, cmd]) => [Number(pid), cmd]));
  const done: string[] = [];
  const env: ShutdownEnv = {
    launchctl: (args) => {
      if (args[0] === 'print') return { ok: loaded.has(args[1]!.split('/')[2]!), output: '' };
      done.push(`launchctl ${args.join(' ')}`);
      if (args[0] === 'bootout') loaded.delete(args[1]!.split('/')[2]!);
      return { ok: true, output: '' };
    },
    uid: 501, port: 47700,
    listeners: () => [...servers.keys()],
    commandOf: (pid) => servers.get(pid) ?? '',
    terminate: (pid) => { if (opts.terminateThrows) throw new Error('EPERM'); done.push(`kill ${pid}`); if (!opts.ignoreTerm) servers.delete(pid); },
    runJournal: (args) => { done.push(`journal ${args.join(' ')}`); return { ok: args[0] !== opts.journalFails, output: `${args[0]} output` }; },
    sleep: () => {},
  };
  return { env, done };
}

test('a dry run lists every step and does nothing', () => {
  const m = machine({ loaded: [LABEL, WEB_LABEL], servers: { 900: WEB_CMD } });
  const r = shutdown({ apply: false, roll: true }, m.env);
  assert.deepEqual(m.done, []);
  const text = r.lines.join('\n');
  assert.match(text, /dry run/);
  assert.match(text, /would run the end-of-day sequence first: journal\.ts triage, then journal\.ts roll, then journal\.ts handoff --all --delta/);
  assert.match(text, new RegExp(`would run: launchctl bootout gui/501/${LABEL}`));
  assert.match(text, new RegExp(`would run: launchctl bootout gui/501/${WEB_LABEL}`));
  assert.equal(r.failed, false);
});

test('a dry run names a detached Podium it would stop when no Podium job is loaded', () => {
  const r = shutdown({ apply: false, roll: false }, machine({ loaded: [LABEL], servers: { 900: WEB_CMD } }).env);
  assert.match(r.lines.join('\n'), /would run: kill -TERM 900 {2}\(the detached Podium on port 47700/);
});

test('--apply boots out both jobs and signals nothing when no detached server is left', () => {
  const m = machine({ loaded: [LABEL, WEB_LABEL] });
  const r = shutdown({ apply: true, roll: false }, m.env);
  assert.deepEqual(m.done, [`launchctl bootout gui/501/${LABEL}`, `launchctl bootout gui/501/${WEB_LABEL}`]);
  assert.match(r.lines.join('\n'), /nothing of ours listens on port 47700/);
  assert.match(r.lines.at(-1)!, /session-start\.ts/);
  assert.equal(r.failed, false);
});

test('--apply stops a detached Podium by SIGTERM and never touches an unrelated listener or a web.ts on another port', () => {
  const m = machine({ servers: { 900: WEB_CMD, 901: 'python -m http.server 47700', 902: '/n/node /r/scripts/web.ts --port 8080' } });
  const r = shutdown({ apply: true, roll: false }, m.env);
  assert.deepEqual(m.done, ['kill 900']);
  assert.equal(r.failed, false);
});

test('a detached server that ignores SIGTERM is reported, not killed harder', () => {
  const m = machine({ servers: { 900: WEB_CMD }, ignoreTerm: true });
  const r = shutdown({ apply: true, roll: false }, m.env);
  assert.deepEqual(m.done, ['kill 900']);
  assert.equal(r.failed, true);
  assert.match(r.lines.join('\n'), /pid 900 still listens/);
});

test('a signal that cannot be sent is reported as a failure', () => {
  const r = shutdown({ apply: true, roll: false }, machine({ servers: { 900: WEB_CMD }, terminateThrows: true }).env);
  assert.equal(r.failed, true);
  assert.match(r.lines.join('\n'), /could not signal pid 900 \(EPERM\)/);
});

test('--roll runs triage, roll and the delta handoff in order before anything is stopped', () => {
  const m = machine({ loaded: [LABEL] });
  shutdown({ apply: true, roll: true }, m.env);
  assert.deepEqual(m.done, [...ROLL_STEPS.map((s) => `journal ${s.join(' ')}`), `launchctl bootout gui/501/${LABEL}`]);
});

test('a failing roll step stops the run before anything is stopped', () => {
  const m = machine({ loaded: [LABEL, WEB_LABEL], journalFails: 'roll' });
  const r = shutdown({ apply: true, roll: true }, m.env);
  assert.deepEqual(m.done, ['journal triage', 'journal roll']);
  assert.equal(r.failed, true);
  assert.match(r.lines.join('\n'), /Stopped before stopping anything/);
});

test('a Podium job that will not boot out is not followed by a SIGTERM that launchd would undo', () => {
  const m = machine({ loaded: [WEB_LABEL], servers: { 900: WEB_CMD } });
  const real = m.env.launchctl;
  m.env.launchctl = (args) => (args[0] === 'bootout' ? { ok: false, output: 'busy' } : real(args));
  const r = shutdown({ apply: true, roll: false }, m.env);
  assert.deepEqual(m.done, []);
  assert.equal(r.failed, true);
  assert.match(r.lines.join('\n'), /skipped, the launchd job still owns port/);
});

test('shutdown is idempotent: with nothing loaded or listening, --apply changes nothing', () => {
  const m = machine();
  const r = shutdown({ apply: true, roll: false }, m.env);
  assert.deepEqual(m.done, []);
  assert.equal(r.failed, false);
});

test('isPodiumServer wants web.ts and this exact port', () => {
  assert.equal(isPodiumServer(WEB_CMD, 47700), true);
  assert.equal(isPodiumServer('node /r/scripts/web.ts --port=47700', 47700), true);
  assert.equal(isPodiumServer(WEB_CMD, 4770), false);
  assert.equal(isPodiumServer('node /r/scripts/web.ts --port 477001', 47700), false);
  assert.equal(isPodiumServer('node /r/scripts/other.ts --port 47700', 47700), false);
  assert.equal(isPodiumServer('', 47700), false);
});

test('the script rejects an unknown flag before it touches launchctl', () => {
  const run = (...args: string[]) => spawnSync(process.execPath, [new URL('./shutdown.ts', import.meta.url).pathname, ...args], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(run('--bogus').status, 2);
});
