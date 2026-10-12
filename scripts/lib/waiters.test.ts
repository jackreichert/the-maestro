import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasLiveWaiter, liveWaiters, pidAlive, registerWaiter, rearmLine, waitersDir } from './waiters.ts';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'waiters-'));

test('a registered waiter is live for its own window only, and unregistering removes it', () => {
  const dir = tmp();
  try {
    const off = registerWaiter(dir, 'w1');
    assert.equal(hasLiveWaiter(dir, 'w1'), true);
    assert.equal(hasLiveWaiter(dir, 'w2'), false);
    off();
    assert.equal(hasLiveWaiter(dir, 'w1'), false);
    assert.deepEqual(readdirSync(waitersDir(dir)), []);
    off();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a record whose pid is dead is not live and is deleted on read', () => {
  const dir = tmp();
  try {
    registerWaiter(dir, 'w1', 424242);
    assert.deepEqual(liveWaiters(dir, () => false), []);
    assert.equal(existsSync(join(waitersDir(dir), '424242.json')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('unreadable, mis-shaped and mis-named files are never live and are cleaned up', () => {
  const dir = tmp();
  try {
    registerWaiter(dir, 'w1', process.pid);
    writeFileSync(join(waitersDir(dir), '7.json'), '{not json');
    writeFileSync(join(waitersDir(dir), '8.json'), JSON.stringify({ pid: 9, window: 'w1', startedAt: 'x' }));
    writeFileSync(join(waitersDir(dir), '9.json'), JSON.stringify({ pid: 9, window: 5, startedAt: 'x' }));
    assert.deepEqual(liveWaiters(dir).map((w) => w.pid), [process.pid]);
    assert.deepEqual(readdirSync(waitersDir(dir)), [`${process.pid}.json`]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a missing directory means no waiters, and the real liveness check sees this process but not a dead one', () => {
  assert.deepEqual(liveWaiters(join(tmpdir(), 'no-such-waiters-dir')), []);
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(2 ** 31 - 2), false);
});

test('the re-arm line carries the command and nothing else variable', () => {
  assert.match(rearmLine('node x.ts events wait'), /run_in_background: node x\.ts events wait$/);
});
