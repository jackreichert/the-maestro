import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADOPT_TTL_MS, adoptLine, adoptPath, clearAdopt, readAdopt, writeAdopt } from './lib/adopt.ts';

const LOOP = fileURLToPath(new URL('./event-loop.ts', import.meta.url));
const tmp = (): string => mkdtempSync(join(tmpdir(), 'adopt-'));
const NOW = Date.parse('2026-10-11T20:00:00Z');

test('write then read round-trips, defaults to 24 hours and makes the path absolute', () => {
  const dir = tmp();
  try {
    const a = writeAdopt(dir, '/q/queue.md', { now: NOW });
    assert.equal(a.until, new Date(NOW + ADOPT_TTL_MS).toISOString());
    assert.deepEqual(readAdopt(dir, NOW + 1000), a);
    assert.ok(writeAdopt(dir, 'rel/queue.md', { now: NOW }).file.startsWith('/'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an expired record reads as none, so tomorrow is not hijacked', () => {
  const dir = tmp();
  try {
    writeAdopt(dir, '/q/queue.md', { now: NOW, until: '2026-10-11T21:00:00Z' });
    assert.ok(readAdopt(dir, NOW + 30 * 60_000));
    assert.equal(readAdopt(dir, NOW + 2 * 3600_000), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('bad --until, a past --until, an empty path and a secret-shaped path are refused', () => {
  const dir = tmp();
  try {
    assert.throws(() => writeAdopt(dir, '/q', { now: NOW, until: 'soon' }), /ISO time/);
    assert.throws(() => writeAdopt(dir, '/q', { now: NOW, until: '2026-10-11T19:00:00Z' }), /past/);
    assert.throws(() => writeAdopt(dir, '  ', { now: NOW }), /path/);
    assert.throws(() => writeAdopt(dir, '/q/AKIAIOSFODNN7EXAMPLE.md', { now: NOW }), /secret/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a hand-written secret-shaped path is withheld on read, and a corrupt file reads as none', () => {
  const dir = tmp();
  try {
    writeFileSync(adoptPath(dir), JSON.stringify({ file: '/q/AKIAIOSFODNN7EXAMPLE.md', until: '2026-10-12T00:00:00Z', at: '' }));
    const line = adoptLine(readAdopt(dir, NOW));
    assert.match(line, /withheld/);
    assert.ok(!line.includes('AKIA'));
    writeFileSync(adoptPath(dir), '{nope');
    assert.equal(readAdopt(dir, NOW), null);
    assert.equal(adoptLine(null), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the line tells the session to read and work the queue', () => {
  assert.equal(adoptLine({ file: '/q/queue.md', until: '2026-10-12T20:00:00.000Z', at: '' }), 'Adopted queue: /q/queue.md (until 2026-10-12T20:00:00.000Z). Read it and work it now.');
});

test('clear reports whether there was a record', () => {
  const dir = tmp();
  try {
    writeAdopt(dir, '/q/queue.md');
    assert.equal(clearAdopt(dir), true);
    assert.equal(clearAdopt(dir), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('event-loop adopt writes, shows and clears the record', () => {
  const dir = tmp();
  const run = (...args: string[]) => spawnSync(process.execPath, [LOOP, 'adopt', ...args], { encoding: 'utf8', env: { ...process.env, MAESTRO_EVENT_DIR: dir, MAESTRO_NOTIFY_COMMAND: '/usr/bin/true' }, timeout: 20_000 });
  try {
    assert.match(run().stdout, /no live adopt record/);
    assert.match(run('/q/queue.md', '--until', '2999-01-01T00:00:00Z').stdout, /adopted \/q\/queue.md until 2999/);
    assert.match(run().stdout, /Adopted queue: \/q\/queue.md/);
    assert.equal(run('/q/queue.md', '--until', 'nope').status, 2);
    assert.match(run('--clear').stdout, /cleared/);
    assert.match(run().stdout, /no live adopt record/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
