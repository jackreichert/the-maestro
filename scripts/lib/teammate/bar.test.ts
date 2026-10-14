// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/lib/teammate/bar.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SUGGESTIONS, classify, complimentProblem, parseDiffLines, planReview, voiceProblem } from './bar.ts';
import type { Finding } from './bar.ts';

const CTX = { repo: 'acme/widgets', pr: 12, head: 'a'.repeat(40) };
const ok = 'Could we check for an empty list here? It looks like the first item is read without a guard.';

test('correctness blocks only with an input and a concrete failure; a bare claim is a suggestion', () => {
  assert.equal(classify({ category: 'correctness', input: 'an empty cart', failure: 'throws TypeError reading items[0]' }).severity, 'blocking');
  const bare = classify({ category: 'correctness', failure: 'breaks' });
  assert.equal(bare.severity, 'suggestion');
  assert.match(bare.downgraded ?? '', /input and the concrete failure/);
  assert.equal(classify({ category: 'correctness', input: 'short', failure: 'short' }).severity, 'suggestion');
});

test('security blocks only for a listed kind (secrets, PHI or PII, auth, tenant scope, injection, customer reference)', () => {
  for (const kind of ['secret', 'phi-pii', 'auth', 'tenant-scope', 'injection', 'customer-reference']) assert.equal(classify({ category: 'security', kind }).severity, 'blocking', kind);
  assert.equal(classify({ category: 'security', kind: 'hardening' }).severity, 'suggestion');
  assert.equal(classify({ category: 'security' }).severity, 'suggestion');
});

test('rollback blocks only for a destructive migration or a breaking API with no fallback', () => {
  assert.equal(classify({ category: 'rollback', kind: 'destructive-migration' }).severity, 'blocking');
  assert.equal(classify({ category: 'rollback', kind: 'breaking-api-no-fallback' }).severity, 'blocking');
  assert.equal(classify({ category: 'rollback', kind: 'slow-migration' }).severity, 'suggestion');
});

test('naming, style, tests and refactors can never block, whatever evidence is attached', () => {
  for (const category of ['naming', 'style', 'test', 'refactor', 'other', '', undefined]) {
    assert.equal(classify({ category, kind: 'auth', input: 'anything at all here', failure: 'a long enough failure' } as Finding).severity, 'suggestion', String(category));
  }
});

const NICE = 'The ID validation before anything goes into a URL is careful and easy to follow.';
const DIFF = parseDiffLines(['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1,3 +1,5 @@', ' keep', '-old', '+new1', '+new2', ' tail', '@@ -20,1 +22,2 @@', ' x', '+y', 'diff --git a/gone.ts b/gone.ts', '--- a/gone.ts', '+++ /dev/null', '@@ -1,1 +0,0 @@', '-bye'].join('\n'));

test('the right-side lines of a diff are the added and the context lines, per file, and a deleted file has none', () => {
  assert.deepEqual([...(DIFF.get('a.ts') ?? [])].sort((a, b) => a - b), [1, 2, 3, 4, 22, 23]);
  assert.equal(DIFF.has('gone.ts'), false);
});

test('a review has a compliment slot: refused without one, refused when generic, and the draft opens with it', () => {
  for (const c of [undefined, '', '   ', 'Great work!', 'Nice job overall', 'Looks good to me']) {
    const plan = planReview(CTX, c, [], DIFF);
    assert.equal(plan.draft, null, String(c));
    assert.match(plan.problem ?? '', /compliment/);
  }
  assert.equal(complimentProblem('The assistant liked the ID validation before anything goes into a URL'), 'the comment mentions an assistant or a tool');
  const plan = planReview(CTX, NICE, [], DIFF);
  assert.ok(plan.draft?.text.startsWith(NICE));
  assert.equal(plan.draft?.review?.compliment, NICE);
});

test('nothing blocking approves, with suggestions inline on diff lines and a closing line that lets the author resolve them', () => {
  const plan = planReview(CTX, NICE, [{ category: 'other', text: ok, path: 'a.ts', line: 2 }], DIFF);
  const d = plan.draft;
  assert.equal(d?.severity, 'review');
  assert.deepEqual(d?.target, { kind: 'review', commitId: CTX.head });
  assert.deepEqual(d?.review?.comments.map((c) => [c.path, c.line, c.severity]), [['a.ts', 2, 'suggestion']]);
  assert.match(d?.text ?? '', /Approving/);
  assert.match(d?.text ?? '', /fix now, follow up later, or just resolve the thread if you disagree/);
});

test('a blocking finding requests changes with the same inline anchoring', () => {
  const plan = planReview(CTX, NICE, [{ category: 'security', kind: 'secret', text: 'This looks like a key committed in the file; could we move it to the secret store?', path: 'a.ts', line: 23 }], DIFF);
  assert.deepEqual(plan.draft?.review?.comments.map((c) => c.severity), ['blocking']);
  assert.match(plan.draft?.text ?? '', /asked for changes/);
});

test('a finding off the diff or with no line is dropped, never posted loose', () => {
  const plan = planReview(CTX, NICE, [{ category: 'other', text: ok, path: 'a.ts', line: 10 }, { category: 'other', text: ok }, { category: 'other', text: ok, path: 'nope.ts', line: 1 }], DIFF);
  assert.equal(plan.dropped.length, 3);
  assert.match(plan.dropped[0]?.reason ?? '', /not anchored/);
  assert.equal(plan.draft?.review?.comments.length, 0);
});

test('at most three suggestions per PR, blocking ones are never dropped for the cap', () => {
  const findings: Finding[] = [
    ...Array.from({ length: 5 }, (_, i) => ({ category: 'other', text: `${ok} (${i})`, path: 'a.ts', line: i + 1 })),
    { category: 'security', kind: 'secret', text: 'This looks like a key committed in the file; could we move it to the secret store?', path: 'a.ts', line: 22 },
  ];
  const plan = planReview(CTX, NICE, findings, DIFF);
  const cs = plan.draft?.review?.comments ?? [];
  assert.equal(cs.filter((c) => c.severity === 'suggestion').length, MAX_SUGGESTIONS);
  assert.equal(cs.filter((c) => c.severity === 'blocking').length, 1);
  assert.equal(plan.dropped.length, 2);
  assert.match(plan.dropped[0]?.reason ?? '', /3-suggestion limit/);
});

test('a text that mentions an assistant or a tool is refused, and an empty one too', () => {
  for (const t of ['As an AI I think this is wrong', 'Claude suggests a guard', 'mithril flagged this line', 'Generated by a review bot', 'This was auto-generated', '']) assert.notEqual(voiceProblem(t), null, t);
  assert.equal(voiceProblem(ok), null);
  const plan = planReview(CTX, NICE, [{ category: 'correctness', input: 'an empty cart', failure: 'throws TypeError', text: 'The assistant found a crash here', path: 'a.ts', line: 1 }], DIFF);
  assert.equal(plan.draft?.review?.comments.length, 0);
  assert.equal(plan.dropped[0]?.index, 0);
});

test('the same PR and head has the same key, so queueing it twice is a no-op; a new head is a new review', () => {
  assert.equal(planReview(CTX, NICE, [], DIFF).draft?.key, planReview(CTX, NICE, [], DIFF).draft?.key);
  assert.notEqual(planReview(CTX, NICE, [], DIFF).draft?.key, planReview({ ...CTX, head: 'b'.repeat(40) }, NICE, [], DIFF).draft?.key);
});
