import { test } from 'node:test';
import assert from 'node:assert/strict';
import { supervise } from './loop-supervisor.ts';

const deps = (alertTick: () => void, logs: string[]) => ({ runLoop: async () => ({ code: 0, stdout: '', stderr: '' }), sleep: async () => {}, save: () => {}, log: (l: string) => { logs.push(l); }, alertTick, maxRuns: 3 });

test('the supervisor runs the alert tick after every launch of the loop', async () => {
  let ticks = 0;
  await supervise(deps(() => { ticks += 1; }, []));
  assert.equal(ticks, 3);
});

test('a throwing alert tick is logged and does not stop the loop', async () => {
  const logs: string[] = [];
  let runs = 0;
  await supervise({ ...deps(() => { throw new Error('nope'); }, logs), runLoop: async () => { runs += 1; return { code: 0, stdout: '', stderr: '' }; } });
  assert.equal(runs, 3);
  assert.equal(logs.filter((l) => l.startsWith('alert tick failed: nope')).length, 3);
});
