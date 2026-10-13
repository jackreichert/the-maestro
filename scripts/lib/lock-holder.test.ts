// Run: node --test scripts/lib/lock-holder.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, lockHolder, ownsLoop, processCommand } from './watch-registry.ts';
import { startLockOwner } from './lock-owner-fixture.ts';

const tempDir = () => mkdtempSync(join(tmpdir(), 'lock-holder-test-'));
const lockWith = (pid: number): string => { const dir = tempDir(); writeFileSync(join(dir, 'loop.lock'), String(pid)); return dir; };

test('ownsLoop: a command line that names event-loop.ts is a loop; any other is not; an unknown one is assumed to be', () => {
  assert.equal(ownsLoop(1, () => 'node /x/scripts/event-loop.ts run --serve'), true);
  assert.equal(ownsLoop(1, () => '/usr/bin/vim notes.md'), false);
  assert.equal(ownsLoop(1, () => ''), false);
  assert.equal(ownsLoop(1, () => null), true);
});

test('a lock whose pid is alive but is not an event loop (a pid reused after a reboot) reads as no holder', () => {
  const dir = lockWith(process.pid);
  assert.equal(lockHolder(dir), null);
});

test('a live event loop holds the lock', () => {
  const owner = startLockOwner();
  try {
    assert.equal(lockHolder(lockWith(owner.pid)), owner.pid);
    assert.match(processCommand(owner.pid) ?? '', /event-loop\.ts/);
  } finally { owner.stop(); }
});

test('acquireLock takes over a lock held by a live pid that is not an event loop, and refuses one held by a real loop', () => {
  const reused = lockWith(process.pid);
  assert.equal(readFileSync(acquireLock(reused, 4242), 'utf8'), '4242');
  const owner = startLockOwner();
  try {
    assert.throws(() => acquireLock(lockWith(owner.pid), 4242), new RegExp(`another event loop is running \\(pid ${owner.pid}\\)`));
  } finally { owner.stop(); }
});

test('a pid that is gone has no command line, so it is no holder', () => {
  assert.equal(lockHolder(lockWith(99999999)), null);
  assert.equal(processCommand(99999999), '');
});
