import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerWaiter } from '../lib/waiters.ts';
import { inject, waiterLine } from './event-inject.ts';
import { startLockOwner } from '../lib/lock-owner-fixture.ts';

const ok = { state: 'ok' as const, line: '**Loop:** ok 2 min' };
const base = { claim: () => [], health: () => ok };

test('the waiter line shows on SessionStart and on every prompt when given, even with nothing else to say', () => {
  const deps = { ...base, waiter: () => 'Waiter: none armed' };
  assert.equal(inject('UserPromptSubmit', 'w1', deps), 'Waiter: none armed');
  assert.equal(inject('SessionStart', 'w1', deps), `${ok.line}\nWaiter: none armed`);
});

test('without a waiter dependency, or when it throws, the hook is as before and fails open', () => {
  assert.equal(inject('UserPromptSubmit', 'w1', base), '');
  assert.equal(inject('SessionStart', 'w1', { ...base, waiter: () => { throw new Error('boom'); } }), '');
});

test('waiterLine is empty with no loop running, names the arm command with a loop and no waiter, and is empty again once a waiter is live', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inject-waiter-'));
  const owner = startLockOwner();
  try {
    assert.equal(waiterLine('w1', dir), '');
    writeFileSync(join(dir, 'loop.lock'), String(owner.pid));
    assert.match(waiterLine('w1', dir), /^Waiter: none armed .*event-loop\.ts' events wait$/);
    assert.equal(waiterLine(undefined, dir), '');
    const off = registerWaiter(dir, 'w1');
    assert.equal(waiterLine('w1', dir), '');
    assert.match(waiterLine('w2', dir), /^Waiter:/);
    off();
    assert.match(waiterLine('w1', dir), /^Waiter:/);
  } finally { owner.stop(); rmSync(dir, { recursive: true, force: true }); }
});
