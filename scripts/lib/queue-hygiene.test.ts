// Run: node --test scripts/lib/queue-hygiene.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { branchFor, gitBranches, keysOf, queueFooter, queueHygiene } from './queue-hygiene.ts';

const PATTERN = '\\b[A-Z][A-Z0-9]+-\\d+\\b';

test('a key matches a branch only as a whole key', () => {
  assert.equal(branchFor('MAESTRO-266', ['feat/MAESTRO-266-flow-run-quality']), 'feat/MAESTRO-266-flow-run-quality');
  assert.equal(branchFor('MAESTRO-26', ['feat/MAESTRO-266-flow']), undefined);
  assert.equal(branchFor('AB-1', ['feat/XAB-1-x']), undefined);
  assert.equal(branchFor('maestro-5', ['origin/feat/maestro-5']), 'origin/feat/maestro-5');
});

test('keys come from the ticket field and the text', () => {
  assert.deepEqual(keysOf({ ticket: 'AV-1', text: 'see MAESTRO-7 and AV-1' }, PATTERN).sort(), ['AV-1', 'MAESTRO-7']);
});

test('oldest age and built rows are counted from queued rows and their repo branches', () => {
  const queued = [
    { id: 'old1', date: '2026-10-04', text: 'nothing named' },
    { id: 'blt1', date: '2026-10-09', text: 'rework MAESTRO-266', repo: 'the-maestro' },
    { id: 'oth1', date: '2026-10-10', text: 'rework MAESTRO-266', repo: 'other' },
  ];
  const h = queueHygiene(queued, '2026-10-11', PATTERN, (repo) => (repo === 'the-maestro' ? ['feat/MAESTRO-266-x'] : []));
  assert.equal(h.queued, 3);
  assert.equal(h.oldestDays, 7);
  assert.equal(h.oldestId, 'old1');
  assert.deepEqual(h.built, [{ id: 'blt1', branch: 'feat/MAESTRO-266-x' }]);
  assert.equal(queueFooter(h), '**Queue:** oldest 7d (old1); 1 of 3 already built (branch exists)');
});

test('an empty queue has no footer line and no age', () => {
  const h = queueHygiene([], '2026-10-11', PATTERN, () => []);
  assert.equal(h.oldestDays, null);
  assert.equal(queueFooter(h), '');
});

test('gitBranches is empty for a directory that is not a repo', () => {
  assert.deepEqual(gitBranches('/nonexistent-dir-for-test'), []);
});
