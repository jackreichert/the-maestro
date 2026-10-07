// Run: node --test scripts/lib/heartbeat.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { heartbeatPath, readHeartbeat, writeHeartbeat } from './heartbeat.ts';
import type { Heartbeat } from './heartbeat.ts';

const beat: Heartbeat = { pid: 4242, at: '2026-10-07T14:00:00.000Z', tick: 7, watchesLive: 3, sleepingUntil: '2026-10-07T14:02:00.000Z', mode: 'run', lastError: '' };

test('a written heartbeat reads back exactly, creating the directory', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'hb-')), 'events');
  writeHeartbeat(dir, beat);
  assert.deepEqual(readHeartbeat(dir), beat);
});

test('a missing, junk or wrongly shaped file reads as no heartbeat', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-'));
  assert.equal(readHeartbeat(dir), null);
  writeFileSync(heartbeatPath(dir), 'not json');
  assert.equal(readHeartbeat(dir), null);
  writeFileSync(heartbeatPath(dir), JSON.stringify({ ...beat, at: 'yesterday' }));
  assert.equal(readHeartbeat(dir), null);
  writeFileSync(heartbeatPath(dir), JSON.stringify({ ...beat, mode: 'nap' }));
  assert.equal(readHeartbeat(dir), null);
});
