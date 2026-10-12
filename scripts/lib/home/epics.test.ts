// Run: node --test scripts/lib/home/epics.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { epicsData } from './epics.ts';
import type { EpicSummary } from './types.ts';

const epic = (id: string, status: string): EpicSummary => ({
  id, title: `Epic ${id}`, note: { label: id, url: `note:${id}` } as EpicSummary['note'], status,
  total: 3, closed: status === 'closed' ? 3 : 1, inProgress: 1, blocked: 0, notStarted: 1,
  verify: { required: false, verified: 0 }, points: null,
  docs: {} as EpicSummary['docs'], brief: {} as EpicSummary['brief'],
  awaiting: 0, unknowns: 0, quietDays: null, prs: [],
});

test('closed epics are left out of both a stream and the unfiled list; open ones keep their order', () => {
  const homes = [{ stream: 'Avonlea', epics: [epic('a-1', 'open'), epic('a-2', 'closed'), epic('a-3', 'in-progress')] }];
  const data = epicsData('2026-10-11T00:00:00Z', homes, [epic('u-1', 'closed'), epic('u-2', 'open')]);
  assert.deepEqual(data.streams[0]?.epics.map((e) => e.id), ['a-1', 'a-3']);
  assert.deepEqual(data.unfiled.map((e) => e.id), ['u-2']);
});
