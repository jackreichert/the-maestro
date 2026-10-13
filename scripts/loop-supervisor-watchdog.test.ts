// Run: node --test scripts/loop-supervisor-watchdog.test.ts
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess, StdioOptions } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LABEL } from './install-loop-supervisor.ts';
import { supervisorLogPath } from './lib/supervisor-state.ts';
import { cleanEnv, notifyCalls } from './lib/test-env.ts';

const tempDir = () => mkdtempSync(join(tmpdir(), 'loop-watchdog-test-'));
const SUPERVISOR = new URL('./loop-supervisor.ts', import.meta.url).pathname;
const INSTALL = new URL('./install-loop-supervisor.ts', import.meta.url).pathname;
/** Cold node starts under load; waits return as soon as the condition holds. */
const PATIENCE_MS = 60_000;
/** Longer than a slow preload, shorter than the second launch's stay, so a silence-kill cannot explain a 20 min wake-time log. */
const GRACE_MS = 3_000;
const INTERVAL_MS = 200;
/** Past GRACE_MS, so a second launch with no fresh heartbeat would be killed too. A future sleepingUntil must spare it. */
const SECOND_STAY_MS = 5_000;

const envsUsed: NodeJS.ProcessEnv[] = [];
const envFor = (ledger: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const env = { ...cleanEnv(), LEDGER_ROOT: ledger, MAESTRO_PROJECT: 'proj', MAESTRO_EVENT_DIR: join(ledger, 'Events'), ...extra };
  envsUsed.push(env);
  return env;
};
after(() => { for (const env of envsUsed) assert.deepEqual(notifyCalls(env), [], 'a test supervisor sent a notification'); });

async function waitFor(done: () => boolean, ms: number = PATIENCE_MS): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (done()) return true;
  return done();
}

const live = new Set<ChildProcess>();
const killTree = (p: ChildProcess): void => { if (live.has(p) && p.pid) { try { process.kill(-p.pid, 'SIGKILL'); } catch { /* already gone */ } } };
after(() => { for (const p of live) killTree(p); });

function startSupervisor(env: NodeJS.ProcessEnv, stdio?: StdioOptions): { p: ChildProcess; closed: Promise<number | null> } {
  const p = spawn(process.execPath, [SUPERVISOR], { env, stdio, detached: true });
  live.add(p);
  const closed = new Promise<number | null>((resolve) => p.on('close', (code) => { live.delete(p); resolve(code); }));
  return { p, closed };
}

/** A node preload that acts only when it is the loop (`run --serve`). macOS stalls a newly written executable; node is already trusted. */
function servePreload(file: string, body: string): string {
  writeFileSync(file, `import { existsSync, mkdirSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nif (process.argv.includes('--serve')) {\n${body}\n}\n`);
  return `--import ${pathToFileURL(file).href}`;
}

test('a stale heartbeat, older than sleepingUntil plus the grace, is SIGTERMed once and relaunched once', () => {
  const ledger = tempDir();
  const markers = tempDir();
  const preload = join(markers, 'stale-loop.mjs');
  servePreload(preload, `
    const events = process.env.MAESTRO_EVENT_DIR;
    const markers = ${JSON.stringify(markers)};
    const beat = (atOffset, wakeOffset) => {
      const now = Date.now();
      mkdirSync(events, { recursive: true });
      writeFileSync(join(events, 'heartbeat.json'), JSON.stringify({
        pid: process.pid, at: new Date(now + atOffset).toISOString(), tick: 1, watchesLive: 1,
        sleepingUntil: new Date(now + wakeOffset).toISOString(), mode: 'run', lastError: '',
      }));
    };
    writeFileSync(join(markers, 'argv'), process.argv.slice(1).join(' '));
    if (existsSync(join(markers, 'first'))) {
      writeFileSync(join(markers, 'second'), '');
      beat(0, 3600_000);
      await new Promise((r) => setTimeout(r, ${SECOND_STAY_MS}));
      console.log('ACTION w1 (fake): relaunched');
      process.exit(10);
    }
    process.on('SIGTERM', () => { writeFileSync(join(markers, 'termed'), ''); process.exit(143); });
    writeFileSync(join(markers, 'first'), '');
    beat(-30 * 60_000, -20 * 60_000);
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  `);
  const r = spawnSync(process.execPath, [SUPERVISOR], {
    encoding: 'utf8',
    timeout: 25_000,
    env: envFor(ledger, {
      MAESTRO_LOOP_BIN: process.execPath,
      NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`,
      MAESTRO_SUPERVISOR_MAX_RUNS: '2',
      MAESTRO_WATCHDOG_GRACE_MS: String(GRACE_MS),
      MAESTRO_WATCHDOG_INTERVAL_MS: String(INTERVAL_MS),
    }),
  });
  const detail = `${r.error?.message ?? ''}\n${r.stderr}`;
  assert.equal(r.status, 0, detail);
  assert.match(readFileSync(join(markers, 'argv'), 'utf8'), /--serve$/);
  assert.equal(existsSync(join(markers, 'first')), true, 'the stale launch never ran');
  assert.equal(existsSync(join(markers, 'termed')), true, 'the stale child was not SIGTERMed');
  assert.equal(existsSync(join(markers, 'second')), true, 'the supervisor did not relaunch');
  assert.equal(r.stderr.match(/sending SIGTERM/g)?.length, 1, r.stderr);
  assert.equal(r.stderr.match(/sending SIGKILL/g)?.length ?? 0, 0, r.stderr);
  assert.equal(r.stderr.match(/is hung/g)?.length, 1, r.stderr);
  assert.equal(r.stderr.match(/relaunching/g)?.length, 1, r.stderr);
  assert.match(r.stderr, /for (1[0-9]|[2-9]\d) min past its wake time/, 'the kill used sleepingUntil, not the launch clock');
});

test('a serve loop that never exits still rotates the supervisor log', async () => {
  const ledger = tempDir();
  const events = join(ledger, 'Events');
  const log = supervisorLogPath(ledger, 'proj');
  mkdirSync(dirname(log), { recursive: true });
  writeFileSync(log, 'kept\n');
  const fd = openSync(log, 'a');
  const preload = join(tempDir(), 'stay-up.mjs');
  const nodeOptions = servePreload(preload, `
    const events = process.env.MAESTRO_EVENT_DIR;
    mkdirSync(events, { recursive: true });
    const now = Date.now();
    writeFileSync(join(events, 'heartbeat.json'), JSON.stringify({
      pid: process.pid, at: new Date(now).toISOString(), tick: 1, watchesLive: 1,
      sleepingUntil: new Date(now + 3600_000).toISOString(), mode: 'run', lastError: '',
    }));
    writeFileSync(join(events, 'loop.lock'), String(process.pid));
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  `);
  const { p, closed } = startSupervisor(envFor(ledger, {
    MAESTRO_LOOP_BIN: process.execPath,
    NODE_OPTIONS: nodeOptions,
    MAESTRO_WATCHDOG_INTERVAL_MS: '100',
    MAESTRO_LOG_MAX_BYTES: '1000',
    MAESTRO_EVENT_DIR: events,
  }), ['ignore', fd, fd]);
  try {
    assert.equal(await waitFor(() => existsSync(join(events, 'supervisor.json'))), true, `the supervisor never started\n${existsSync(log) ? readFileSync(log, 'utf8') : 'no log'}`);
    writeFileSync(log, 'old line\n'.repeat(200), { flag: 'a' });
    assert.equal(await waitFor(() => existsSync(`${log}.1`)), true, 'the log was never rotated while the serve loop stayed up');
    assert.equal(p.exitCode, null, 'rotation ran only because the child had already exited');
    assert.match(readFileSync(`${log}.1`, 'utf8'), /old line/);
  } finally {
    p.kill('SIGTERM');
    await closed;
    killTree(p);
    closeSync(fd);
  }
});

test('the installer refuses a second maestro-loop plist', () => {
  const ledger = tempDir();
  const agents = tempDir();
  const out = join(agents, `${LABEL}.plist`);
  writeFileSync(join(agents, 'com.example.maestro-loop-other.plist'), '<plist/>');
  const refused = spawnSync(process.execPath, [INSTALL, '--out', out, '--allow-branch'], {
    encoding: 'utf8',
    env: envFor(ledger, { MAESTRO_LAUNCH_AGENTS_DIR: agents }),
  });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /another loop plist is installed: .*com\.example\.maestro-loop-other\.plist/);
  assert.equal(existsSync(out), false, 'a refused install must not write a second plist');
});
