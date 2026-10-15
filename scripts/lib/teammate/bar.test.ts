// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/lib/teammate/bar.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SMELL_SUGGESTIONS, MAX_SUGGESTIONS, classify, complimentProblem, parseDiffLines, planReview, voiceProblem } from './bar.ts';
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
const DIFF = parseDiffLines(['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1,3 +1,4 @@', ' keep', '-old', '+new1', '+new2', ' tail', '@@ -20,1 +22,2 @@', ' x', '+y', 'diff --git a/gone.ts b/gone.ts', '--- a/gone.ts', '+++ /dev/null', '@@ -1,1 +0,0 @@', '-bye'].join('\n'));

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
  assert.equal(complimentProblem('As an AI I liked the ID validation before anything goes into a URL'), 'the comment mentions an assistant or a tool');
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
  for (const t of ['As an AI I think this is wrong', 'Claude suggests a guard', 'mithril flagged this line', 'Generated by a review tool', 'This was auto-generated', '']) assert.notEqual(voiceProblem(t), null, t);
  assert.equal(voiceProblem(ok), null);
  const plan = planReview(CTX, NICE, [{ category: 'other', text: 'As an AI I would guard this call', path: 'a.ts', line: 1 }], DIFF);
  assert.equal(plan.draft?.review?.comments.length, 0);
  assert.equal(plan.dropped[0]?.index, 0);
});

test('the same PR and head has the same key, so queueing it twice is a no-op; a new head is a new review', () => {
  assert.equal(planReview(CTX, NICE, [], DIFF).draft?.key, planReview(CTX, NICE, [], DIFF).draft?.key);
  assert.notEqual(planReview(CTX, NICE, [], DIFF).draft?.key, planReview({ ...CTX, head: 'b'.repeat(40) }, NICE, [], DIFF).draft?.key);
});

test('a dropped blocking finding stops the review instead of letting it become an approval', () => {
  const secret = { category: 'security', kind: 'secret', text: 'This looks like a key committed in the file; could we move it to the secret store?' };
  for (const where of [{ path: 'nope.ts', line: 1 }, { path: 'a.ts' }, { path: 'a.ts', line: 99 }]) {
    const plan = planReview(CTX, NICE, [{ ...secret, ...where }], DIFF);
    assert.equal(plan.draft, null, JSON.stringify(where));
    assert.match(plan.problem ?? '', /blocking finding could not be posted/);
  }
  const badWords = planReview(CTX, NICE, [{ ...secret, path: 'a.ts', line: 1, text: 'As an AI I think this key is committed here' }], DIFF);
  assert.equal(badWords.draft, null);
});

test('real git diff headers parse: names with spaces or non-ASCII, added lines that look like headers, no-newline markers', () => {
  const d = parseDiffLines([
    'diff --git a/my file.txt b/my file.txt', 'index 1..2 100644', '--- a/my file.txt\t', '+++ b/my file.txt\t', '@@ -0,0 +1,2 @@', '+one', '+two',
    'diff --git "a/caf\\303\\251.md" "b/caf\\303\\251.md"', '--- "a/caf\\303\\251.md"', '+++ "b/caf\\303\\251.md"', '@@ -1,0 +2,1 @@', '+x',
    'diff --git a/pp.txt b/pp.txt', 'new file mode 100644', '--- /dev/null', '+++ b/pp.txt', '@@ -0,0 +1,4 @@', '+start', '+++ weird', '+after1', '+after2', '\\ No newline at end of file',
  ].join('\n'));
  assert.deepEqual([...(d.get('my file.txt') ?? [])], [1, 2]);
  assert.deepEqual([...(d.get('caf\u00e9.md') ?? [])], [2]);
  assert.deepEqual([...(d.get('pp.txt') ?? [])].sort(), [1, 2, 3, 4]);
  assert.equal(d.has('weird'), false);
});

test('a legitimate finding that mentions a bot, an AI feature or an assistant scheduler is not refused', () => {
  for (const t of ['The Slack bot token is written to the log on line 12.', 'The AI summary column leaks a patient name.', 'Add a test for the assistant scheduler.']) assert.equal(voiceProblem(t), null, t);
});

test('stock praise is refused as a compliment, even when it is long enough', () => {
  for (const c of ['LGTM, looks good to me, ship it now please', 'Really nice work here, thanks for doing this.', 'Thanks for this PR, it looks really good overall.', 'Great work on this one, it all reads well to me.']) assert.notEqual(complimentProblem(c), null, c);
  assert.equal(complimentProblem(NICE), null);
});

const smell = (over: Partial<Finding> = {}): Finding => ({ source: 'smell', category: 'other', path: 'a.ts', line: 2, cost: 'the next edit has to touch both copies', text: 'This block repeats the one above; could we pull it into a helper?', ...over });

test('a smell never blocks, whatever category, kind or evidence it carries, and an approval stays an approval', () => {
  for (const claim of [{ category: 'security', kind: 'secret' }, { category: 'correctness', input: 'an empty cart', failure: 'throws TypeError reading items[0]' }, { category: 'rollback', kind: 'destructive-migration' }]) {
    assert.equal(classify(smell(claim)).severity, 'suggestion', JSON.stringify(claim));
    const plan = planReview(CTX, NICE, [smell(claim)], DIFF);
    assert.equal(plan.draft?.review?.comments[0]?.severity, 'suggestion');
    assert.match(plan.draft?.context ?? '', /^Approves: 0 blocking, 1 suggestion/);
  }
});

test('a smell without a stated cost, or off the diff, is dropped and does not stop the review', () => {
  const plan = planReview(CTX, NICE, [smell({ cost: '' }), smell({ line: 99 }), smell({ path: 'nope.ts' })], DIFF);
  assert.equal(plan.draft?.review?.comments.length, 0);
  assert.equal(plan.dropped.length, 3);
  assert.match(plan.dropped[0]?.reason ?? '', /maintenance cost/);
});

test('a smell within 3 lines of a reviewer finding in the same file is the same finding and is dropped', () => {
  const reviewer: Finding = { category: 'other', path: 'a.ts', line: 4, text: ok };
  const plan = planReview(CTX, NICE, [smell({ line: 1 }), reviewer, smell({ line: 23 }), smell({ line: 22, path: 'other.ts' })], DIFF);
  assert.deepEqual(plan.draft?.review?.comments.map((c) => `${c.path}:${c.line}`).sort(), ['a.ts:23', 'a.ts:4']);
  assert.match(plan.dropped[0]?.reason ?? '', /already raised/);
  assert.equal(plan.dropped.length, 2);
});

test('smells have their own cap and can never crowd out the reviewer, even when they are listed first', () => {
  const smells = [2, 3, 22, 23].map((line) => smell({ line }));
  const reviewers: Finding[] = Array.from({ length: MAX_SUGGESTIONS + 1 }, (_, i) => ({ category: 'other', path: 'a.ts', line: [1, 22, 23, 4][i], text: ok }));
  const comments = planReview(CTX, NICE, [...smells, ...reviewers], DIFF).draft?.review?.comments ?? [];
  assert.equal(comments.length, MAX_SUGGESTIONS);
  assert.equal(planReview(CTX, NICE, smells, DIFF).draft?.review?.comments.length, MAX_SMELL_SUGGESTIONS);
});
