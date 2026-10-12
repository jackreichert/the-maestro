import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { liveWaiters } from './lib/waiters.ts';

const LOOP = fileURLToPath(new URL('./event-loop.ts', import.meta.url));
const nap = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function start(dir: string, args: string[], window: string) {
  const ledger = mkdtempSync(join(tmpdir(), 'waiter-ledger-'));
  const child = spawn(process.execPath, [LOOP, ...args], { env: { ...process.env, MAESTRO_EVENT_DIR: dir, MAESTRO_WINDOW: window, LEDGER_ROOT: ledger, MAESTRO_NOTIFY_COMMAND: '/usr/bin/true' }, stdio: 'ignore' });
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  return { child, exited, ledger };
}

async function until(cond: () => boolean, ms = 10_000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await nap(50)) if (cond()) return true;
  return cond();
}

test('events wait is registered under its window while it waits, and the record is gone when it times out', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'waiter-reg-'));
  const run = start(dir, ['events', 'wait', '--timeout-hours', '0.0006', '--poll-seconds', '0.2'], 'wreg1');
  try {
    assert.equal(await until(() => liveWaiters(dir).some((w) => w.window === 'wreg1')), true);
    await run.exited;
    assert.deepEqual(liveWaiters(dir), []);
  } finally { run.child.kill(); rmSync(dir, { recursive: true, force: true }); rmSync(run.ledger, { recursive: true, force: true }); }
});

test('digest-wait registers too, and a SIGTERM removes the record', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'waiter-reg-'));
  const run = start(dir, ['digest-wait', '--timeout-hours', '1', '--poll-seconds', '0.2'], 'wreg2');
  try {
    assert.equal(await until(() => liveWaiters(dir).some((w) => w.window === 'wreg2')), true);
    run.child.kill('SIGTERM');
    await run.exited;
    assert.deepEqual(liveWaiters(dir), []);
  } finally { run.child.kill(); rmSync(dir, { recursive: true, force: true }); rmSync(run.ledger, { recursive: true, force: true }); }
});
