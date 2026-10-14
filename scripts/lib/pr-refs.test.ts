// Run: node --test scripts/lib/pr-refs.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergedRows, prRefs } from './pr-refs.ts';

const owner = (r: string, strict = false) => (r === 'svc' ? 'acme/svc' : r === 'zz-tool' && strict ? 'acme/zz-tool' : r === 'svc2' && !strict ? 'acme/svc2' : undefined);

test('a row names PRs as owner/repo#N, a pull URL, or #N beside its own repo', () => {
  assert.deepEqual(prRefs({ text: 'follow-ups for acme/svc#483' }, owner), [{ repo: 'acme/svc', number: 483 }]);
  assert.deepEqual(prRefs({ text: 'x', refs: ['https://github.com/acme/svc/pull/12'] }, owner), [{ repo: 'acme/svc', number: 12 }]);
  assert.deepEqual(prRefs({ text: 'merge prep #488 and PR 7', repo: 'svc' }, owner).map((r) => r.number).sort(), [488, 7]);
  assert.deepEqual(prRefs({ text: 'merge prep #488', repo: 'unknown' }, owner), []);
  assert.deepEqual(prRefs({ text: 'svc #488 merge prep' }, owner), [{ repo: 'acme/svc', number: 488 }]);
  assert.deepEqual(prRefs({ text: 'tool #601 fix' }, owner), [], 'no prefix configured: a bare name does not borrow one');
  assert.deepEqual(prRefs({ text: 'tool #601 fix' }, owner, 'zz-'), [{ repo: 'acme/zz-tool', number: 601 }]);
  assert.deepEqual(prRefs({ text: 'svc2 #5 and merge #6' }, owner), [], 'a name only the org fallback could resolve is not a repo');
  assert.deepEqual(prRefs({ text: 'ledger id a#1 is not a PR' }, owner), []);
});

test('only rows naming a MERGED PR are reported, an unknown state never counts, and a PR is asked about once', () => {
  const asked: string[] = [];
  const state = (r: { repo: string; number: number }) => { asked.push(`${r.repo}#${r.number}`); return r.number === 483 ? 'MERGED' : r.number === 9 ? 'OPEN' : undefined; };
  const rows = [
    { id: 'a1', text: 'acme/svc#483 follow-ups' },
    { id: 'a2', text: 'acme/svc#483 and acme/svc#9' },
    { id: 'a3', text: 'acme/svc#9 still open' },
    { id: 'a4', text: 'acme/svc#77 lookup failed' },
    { id: 'a5', text: 'no pr here' },
  ];
  const out = mergedRows(rows, owner, state);
  assert.deepEqual(out.map((m) => [m.id, m.allMerged]), [['a1', true], ['a2', false]]);
  assert.equal(asked.filter((a) => a === 'acme/svc#483').length, 1);
});
