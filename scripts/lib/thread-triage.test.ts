// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/lib/thread-triage.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { triageProblem, worthSection } from './thread-triage.ts';

const ok = { threadId: '1234', worthAddressing: true, reason: 'Drops rows on a retry.' };

test('a well-formed triage list passes, including a blocking entry on a thread worth addressing', () => {
  assert.equal(triageProblem([]), null);
  assert.equal(triageProblem([ok, { ...ok, threadId: 'PRRT_kwDOabc', worthAddressing: false, reason: 'A nit.' }, { ...ok, severity: 'blocking' }]), null);
});

test('malformed entries are refused: not a list, a bad id, a missing flag, a multi-line or empty reason, blocking without worth', () => {
  for (const bad of [null, {}, 'x', [null], [{ ...ok, threadId: '' }], [{ ...ok, threadId: '1 2' }], [{ ...ok, worthAddressing: 'yes' }], [{ ...ok, reason: '' }], [{ ...ok, reason: 'a\nb' }], [{ ...ok, reason: 'x'.repeat(201) }], [{ ...ok, severity: 'high' }], [{ ...ok, worthAddressing: false, severity: 'blocking' }], Array.from({ length: 51 }, () => ok)]) {
    assert.notEqual(triageProblem(bad), null, JSON.stringify(bad)?.slice(0, 60));
  }
});

test('the body section lists each thread worth addressing as a link with its reason, and is empty when there is none', () => {
  assert.equal(worthSection([]), '');
  assert.equal(worthSection([{ label: 'src/a.ts:10', url: 'https://github.com/acme/widgets/pull/7#discussion_r1', reason: 'Empty cart.' }]), '**Worth addressing before merge**\n- [src/a.ts:10](https://github.com/acme/widgets/pull/7#discussion_r1): Empty cart.');
});
