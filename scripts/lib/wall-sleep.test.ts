// Run: node --test scripts/lib/wall-sleep.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHUNK_SECONDS, sleepUntil } from './wall-sleep.ts';

test('a long sleep is cut into chunks and the heartbeat hook runs before each', async () => {
  let clock = 0;
  const slept: number[] = [];
  const chunks: number[] = [];
  await sleepUntil(150_000, { now: () => clock, sleep: async (s) => { slept.push(s); clock += s * 1000; }, onChunk: (u) => chunks.push(u) });
  assert.deepEqual(slept, [CHUNK_SECONDS, CHUNK_SECONDS, 30]);
  assert.equal(chunks.length, 3);
});

test('a machine that slept through the wait catches up within one chunk', async () => {
  let clock = 0;
  let calls = 0;
  await sleepUntil(3_600_000, { now: () => clock, sleep: async (s) => { calls += 1; clock += calls === 2 ? 4_000_000 : s * 1000; } });
  assert.equal(calls, 2, 'the lid-closed jump ends the wait after the next chunk, not after the original hour');
});

test('a time already past sleeps not at all', async () => {
  let calls = 0;
  await sleepUntil(5, { now: () => 10, sleep: async () => { calls += 1; } });
  assert.equal(calls, 0);
});
