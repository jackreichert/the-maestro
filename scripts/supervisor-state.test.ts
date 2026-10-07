// Run: node --test scripts/supervisor-state.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearRecord, readRecord, recordPath, supervisorStatus, writeRecord } from './lib/supervisor-state.ts';

const tempDir = () => mkdtempSync(join(tmpdir(), 'supervisor-state-test-'));
const SUPERVISOR = new URL('./loop-supervisor.ts', import.meta.url).pathname;
const NOPLIST = join(tmpdir(), 'no-such-plist-ever.plist');
const waitFor = async (ok: () => boolean, ms = 8000) => { for (let t = 0; t < ms && !ok(); t += 50) await new Promise((r) => setTimeout(r, 50)); };

test('nothing recorded and nothing installed is silent: an install without a supervisor is not nagged', () => {
  const s = supervisorStatus(tempDir(), { plist: NOPLIST });
  assert.equal(s.state, 'absent');
  assert.equal(s.line, '');
});

test('a record whose pid is alive reads as running and prints nothing', () => {
  const dir = tempDir();
  writeRecord(dir, process.pid);
  const s = supervisorStatus(dir, { plist: NOPLIST });
  assert.equal(s.state, 'running');
  assert.equal(s.pid, process.pid);
  assert.equal(s.line, '');
});

test('a record whose pid is gone reads as dead, names the pid and the restart command', () => {
  const dir = tempDir();
  writeRecord(dir, 424242);
  const s = supervisorStatus(dir, { plist: NOPLIST, alive: () => false });
  assert.equal(s.state, 'dead');
  assert.match(s.line, /Loop supervisor: DEAD \(pid 424242, started \d{4}-/);
  assert.match(s.line, /launchctl kickstart -k gui\/\d+\/com\.jackreichert\.the-maestro-loop/);
});

test('an installed plist with no record is reported as installed but never seen alive', () => {
  const plist = join(tempDir(), 'x.plist');
  writeFileSync(plist, '<plist/>');
  const s = supervisorStatus(tempDir(), { plist });
  assert.equal(s.state, 'dead');
  assert.match(s.line, /NOT RUNNING \(installed at .*x\.plist, never seen alive\)/);
});

test('a junk, empty or wrongly shaped record is treated as no record', () => {
  for (const text of ['', '{not json', 'null', '[]', '{"pid":"7","startedAt":"x"}', '{"pid":-1,"startedAt":"x"}', '{"pid":1.5,"startedAt":"x"}', '{"pid":7}']) {
    const dir = tempDir();
    writeFileSync(recordPath(dir), text);
    assert.equal(readRecord(dir), null, text);
    assert.equal(supervisorStatus(dir, { plist: NOPLIST }).state, 'absent', text);
  }
});

test('clearRecord removes only its own pid record', () => {
  const dir = tempDir();
  writeRecord(dir, 111);
  clearRecord(dir, 222);
  assert.equal(readRecord(dir)?.pid, 111);
  clearRecord(dir, 111);
  assert.equal(readRecord(dir), null);
  clearRecord(dir, 111);
});

test('the real supervisor writes its record, and SIGTERM during a sleep removes it and exits 0', async () => {
  const events = tempDir();
  const ledger = tempDir();
  const env = { ...process.env, MAESTRO_LOCAL_CONFIG: '', MAESTRO_EVENT_DIR: events, LEDGER_ROOT: ledger, MAESTRO_LOOP_BIN: '/usr/bin/true' };
  const child = spawn(process.execPath, [SUPERVISOR], { env, stdio: 'ignore' });
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  await waitFor(() => readRecord(events)?.pid === child.pid);
  assert.equal(readRecord(events)?.pid, child.pid);
  assert.equal(supervisorStatus(events, { plist: NOPLIST }).state, 'running');
  await new Promise((r) => setTimeout(r, 300)); // the fake loop has exited 0; the supervisor is now in its 300 s sleep
  child.kill('SIGTERM');
  assert.equal(await exited, 0);
  assert.equal(existsSync(recordPath(events)), false);
});

test('a supervisor killed with SIGKILL leaves its record, which then reads as dead', async () => {
  const events = tempDir();
  const env = { ...process.env, MAESTRO_LOCAL_CONFIG: '', MAESTRO_EVENT_DIR: events, LEDGER_ROOT: tempDir(), MAESTRO_LOOP_BIN: '/usr/bin/true' };
  const child = spawn(process.execPath, [SUPERVISOR], { env, stdio: 'ignore' });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  await waitFor(() => readRecord(events)?.pid === child.pid);
  child.kill('SIGKILL');
  await exited;
  assert.equal(supervisorStatus(events, { plist: NOPLIST }).state, 'dead');
});

test('a second supervisor that cannot start (no ledger root) leaves the record alone', () => {
  const events = tempDir();
  writeRecord(events, 31337);
  const r = spawnSync(process.execPath, [SUPERVISOR], { env: { ...process.env, MAESTRO_LOCAL_CONFIG: '', MAESTRO_EVENT_DIR: events, LEDGER_ROOT: '' }, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.equal(readRecord(events)?.pid, 31337);
});
