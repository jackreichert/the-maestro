// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/lib/drafts/queue.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addDraft, editDraft, listDrafts, rejectDraft, revOf, withLock } from './queue.ts';
import type { NewDraft, ReviewComment } from './queue.ts';
import { approveAndPost, ghCall } from './post.ts';
import type { GhResult } from './post.ts';

const file = (): string => { const d = mkdtempSync(join(tmpdir(), 'drafts-')); mkdirSync(join(d, 'J')); return join(d, 'J', 'drafts.jsonl'); };
const R = (f: string, id: string): string => { const d = listDrafts(f).find((x) => x.id === id); return d ? revOf(d) : '000000000000'; };
const draft = (over: Partial<NewDraft> = {}): NewDraft => ({ key: 'acme/widgets#7@abc:a.ts:3:x', source: 'review', repo: 'acme/widgets', pr: 7, severity: 'suggestion', text: 'Could this guard against an empty list?', target: { kind: 'inline', path: 'src/a.ts', line: 3, commitId: 'abcdef1' }, ...over });
interface Stub { calls: string[][]; run: (a: string[]) => GhResult }
const stub = (result: Partial<GhResult> = {}): Stub => { const calls: string[][] = []; return { calls, run: (a) => { calls.push(a); return { status: 0, stdout: '{"html_url":"https://github.com/acme/widgets/pull/7#discussion_r1"}', stderr: '', ...result }; } }; };

test('a new draft is pending and the same key is added once, even after it was rejected', () => {
  const f = file();
  const a = addDraft(f, draft());
  assert.equal(a.created, true);
  assert.equal(listDrafts(f)[0]?.state, 'pending');
  assert.deepEqual(addDraft(f, draft()), { id: a.id, created: false });
  rejectDraft(f, a.id, 'not needed');
  assert.equal(addDraft(f, draft()).created, false, 'a rejected finding does not come back');
  assert.equal(listDrafts(f).length, 1);
});

test('a producer cannot hand in a state: rows with a state field still fold to pending', () => {
  const f = file();
  appendFileSync(f, `${JSON.stringify({ op: 'add', id: 'dr-00000001', ts: '2026-10-14T10:00:00Z', state: 'posted', ...draft() })}\n${JSON.stringify({ op: 'posted', id: 'dr-00000001', ts: '2026-10-14T10:00:01Z' })}\n`);
  assert.equal(listDrafts(f)[0]?.state, 'pending');
});

test('bad drafts are refused: empty text, a reply that is inline, a path escape, a severity mismatch', () => {
  const f = file();
  assert.throws(() => addDraft(f, draft({ text: '  ' })));
  assert.throws(() => addDraft(f, draft({ target: { kind: 'inline', path: '../x', line: 1, commitId: 'abcdef1' } })));
  assert.throws(() => addDraft(f, draft({ source: 'reply', severity: 'reply' })), 'a reply cannot be inline');
  assert.throws(() => addDraft(f, draft({ severity: 'reply' })));
  assert.throws(() => addDraft(f, draft({ repo: 'not a repo' })));
});

test('approve posts once, as the text shown, and records the url', () => {
  const f = file(); const g = stub();
  const { id } = addDraft(f, draft());
  const out = approveAndPost(f, id, R(f, id), { run: g.run });
  assert.deepEqual(out, { ok: true, url: 'https://github.com/acme/widgets/pull/7#discussion_r1' });
  assert.equal(g.calls.length, 1);
  assert.deepEqual(g.calls[0]?.slice(0, 4), ['api', '-X', 'POST', 'repos/acme/widgets/pulls/7/comments']);
  assert.ok(g.calls[0]?.includes('body=Could this guard against an empty list?'));
  const d = listDrafts(f)[0];
  assert.equal(d?.state, 'posted');
  assert.equal(d?.approvedText, draft().text);
});

test('approve is idempotent: a second approve, or a retry after posted, never calls gh again', () => {
  const f = file(); const g = stub();
  const { id } = addDraft(f, draft());
  approveAndPost(f, id, R(f, id), { run: g.run });
  const again = approveAndPost(f, id, R(f, id), { run: g.run });
  assert.equal(again.ok, false);
  assert.equal(g.calls.length, 1);
});

test('edit then approve posts the edited text, and approving stale text is refused as changed', () => {
  const f = file(); const g = stub();
  const { id } = addDraft(f, draft());
  const before = R(f, id);
  assert.equal(editDraft(f, id, 'Friendlier wording here.').ok, true);
  const stale = approveAndPost(f, id, before, { run: g.run });
  assert.deepEqual([stale.ok, !stale.ok && stale.code], [false, 'changed']);
  assert.equal(g.calls.length, 0);
  assert.equal(approveAndPost(f, id, R(f, id), { run: g.run }).ok, true);
  assert.ok(g.calls[0]?.includes('body=Friendlier wording here.'));
  assert.equal(editDraft(f, id, 'too late').ok, false, 'a posted draft cannot be edited');
});

test('reject never posts, records the reason, and blocks any later approve', () => {
  const f = file(); const g = stub();
  const { id } = addDraft(f, draft());
  assert.equal(rejectDraft(f, id, '   ').ok, false, 'a reason is required');
  assert.equal(rejectDraft(f, id, 'already covered in the thread').ok, true);
  const d = listDrafts(f)[0];
  assert.deepEqual([d?.state, d?.rejectReason], ['rejected', 'already covered in the thread']);
  assert.equal(approveAndPost(f, id, R(f, id), { run: g.run }).ok, false);
  assert.equal(g.calls.length, 0);
  assert.equal(readFileSync(f, 'utf8').includes('"op":"posting"'), false);
});

test('a gh refusal leaves nothing posted and allows a retry; a cut-off call is uncertain and never retried', () => {
  const f = file();
  const { id } = addDraft(f, draft());
  const no = stub({ status: 1, stdout: '', stderr: 'HTTP 422: line is not part of the diff' });
  const r = approveAndPost(f, id, R(f, id), { run: no.run });
  assert.equal(r.ok, false);
  assert.equal(listDrafts(f)[0]?.state, 'failed');
  assert.match(listDrafts(f)[0]?.error ?? '', /422/);
  const cut = stub({ status: null });
  approveAndPost(f, id, R(f, id), { run: cut.run });
  assert.equal(listDrafts(f)[0]?.state, 'uncertain');
  const again = stub();
  assert.equal(approveAndPost(f, id, R(f, id), { run: again.run }).ok, false);
  assert.equal(again.calls.length, 0);
  assert.equal(rejectDraft(f, id, 'checked, it is there').ok, true, 'once checked by hand, an uncertain draft can be cleared');
  assert.equal(listDrafts(f)[0]?.state, 'rejected');
});

test('a crash after the posting row, before the result, leaves the draft unpostable', () => {
  const f = file(); const g = stub();
  const { id } = addDraft(f, draft());
  appendFileSync(f, `${JSON.stringify({ op: 'approve', id, ts: 't', text: draft().text })}\n${JSON.stringify({ op: 'posting', id, ts: 't' })}\n`);
  assert.equal(listDrafts(f)[0]?.state, 'posting');
  assert.equal(approveAndPost(f, id, R(f, id), { run: g.run }).ok, false);
  assert.equal(g.calls.length, 0);
});

test('a hand-written row that addDraft would refuse never becomes a draft, so it can never reach gh', () => {
  const f = file();
  const bad = { op: 'add', id: 'dr-0000000a', ts: 't', ...draft(), repo: '{owner}/{repo}', target: { kind: 'inline', path: '-p', line: '@/etc/hosts', commitId: 'zz' } };
  appendFileSync(f, `${JSON.stringify(bad)}\n`);
  assert.equal(listDrafts(f).length, 0);
  const g = stub();
  assert.equal(approveAndPost(f, 'dr-0000000a', R(f, 'dr-0000000a'), { run: g.run }).ok, false);
  assert.equal(g.calls.length, 0);
});

test('a crash between the approve and posting rows leaves the draft approvable again, and gh was never called', () => {
  const f = file(); const g = stub();
  const { id } = addDraft(f, draft());
  appendFileSync(f, `${JSON.stringify({ op: 'approve', id, ts: 't', text: draft().text })}\n`);
  assert.equal(listDrafts(f)[0]?.state, 'approved');
  assert.equal(approveAndPost(f, id, R(f, id), { run: g.run }).ok, true);
  assert.equal(g.calls.length, 1);
});

test('if two writers both got through the lock, only the one whose posting row is first calls gh', () => {
  const f = file();
  const { id } = addDraft(f, draft());
  // The other writer's rows are already in the file when ours runs its re-read: simulate by having gh's first call be preceded by a rival posting row.
  let calls = 0;
  const run = (): GhResult => { calls += 1; return { status: 0, stdout: '{}', stderr: '' }; };
  const rival = (): void => appendFileSync(f, `${JSON.stringify({ op: 'approve', id, ts: 't', text: draft().text })}\n${JSON.stringify({ op: 'posting', id, ts: 't', nonce: 'rival' })}\n`);
  rival();
  const out = approveAndPost(f, id, R(f, id), { run });
  assert.equal(out.ok, false);
  assert.equal(calls, 0);
});

test('target kinds map to the right gh endpoint', () => {
  const f = file();
  const base = { ...listDrafts(f)[0], id: 'x', state: 'pending' as const, createdAt: '', updatedAt: '', ...draft() };
  assert.match(ghCall({ ...base, source: 'reply', severity: 'reply', target: { kind: 'reply', commentId: 99 } }, 't').args[3] ?? '', /pulls\/7\/comments\/99\/replies$/);
  assert.match(ghCall({ ...base, target: { kind: 'general' } }, 't').args[3] ?? '', /issues\/7\/comments$/);
});

test('the lock is released after use and a held lock answers busy', () => {
  const f = file();
  assert.equal(withLock(f, () => 'ran'), 'ran');
  assert.equal(readdirSync(join(f, '..')).some((n) => n.endsWith('.lock')), false);
  withLock(f, () => { assert.equal(withLock(f, () => 'inner'), 'busy'); });
});

test('no code path posts without an approval record: only the approve route reaches approveAndPost', () => {
  const root = join(import.meta.dirname, '..', '..');
  const sources: string[] = [];
  const walk = (dir: string): void => { for (const n of readdirSync(dir)) { if (n === 'node_modules') continue; const p = join(dir, n); statSync(p).isDirectory() ? walk(p) : /\.ts$/.test(n) && !/\.test\.ts$/.test(n) && sources.push(p); } };
  walk(root);
  const uses = (needle: string): string[] => sources.filter((p) => readFileSync(p, 'utf8').includes(needle)).map((p) => p.slice(root.length + 1)).sort();
  assert.deepEqual(uses('approveAndPost'), ['lib/drafts/post.ts', 'lib/web/drafts-write.ts']);
  // The one other way a comment reaches GitHub is the bot-thread reply, which re-reads the thread and refuses any with a person in it.
  assert.deepEqual(uses('postBotReply'), ['lib/drafts/post.ts', 'lib/replies/route.ts']);
  assert.deepEqual(uses('spawnGh'), ['lib/drafts/post.ts', 'reply-drafts.ts']);
  assert.deepEqual(uses('drafts/post.ts'), ['lib/replies/route.ts', 'lib/replies/threads.ts', 'lib/web/drafts-write.ts', 'lib/web/server.ts', 'reply-drafts.ts']);
  const write = readFileSync(join(root, 'lib/web/drafts-write.ts'), 'utf8');
  assert.equal(write.match(/approveAndPost\(/g)?.length, 1);
  assert.match(write, /if \(op === 'approve'\) return approveAndPost/);
  assert.equal(/^import .*post\.ts/m.test(readFileSync(join(root, 'lib/drafts/queue.ts'), 'utf8')), false, 'queue.ts does not import post.ts');
});

const COMPLIMENT = 'The ID validation before anything goes into a URL is exactly right.';
const review = (over: Partial<NewDraft> = {}, comments: ReviewComment[] = [{ path: 'src/a.ts', line: 3, text: 'Could this guard an empty list?', severity: 'suggestion' }]): NewDraft => ({
  key: 'acme/widgets#7@abcdef1:review', source: 'review', repo: 'acme/widgets', pr: 7, severity: 'review', target: { kind: 'review', commitId: 'abcdef1' },
  text: `${COMPLIMENT}\n\nI left a couple of inline notes; resolve them however you think best.`, review: { compliment: COMPLIMENT, comments }, ...over,
});

test('a review draft posts as ONE review: APPROVE with inline RIGHT-side comments when nothing blocks', () => {
  const f = file(); const g = stub();
  const { id } = addDraft(f, review());
  assert.equal(approveAndPost(f, id, R(f, id), { run: g.run }).ok, true);
  assert.equal(g.calls.length, 1);
  assert.deepEqual(g.calls[0]?.slice(0, 4), ['api', '-X', 'POST', 'repos/acme/widgets/pulls/7/reviews']);
  const body = JSON.parse(ghCall(listDrafts(f)[0] as never, listDrafts(f)[0]?.text ?? '').input ?? '{}');
  assert.deepEqual([body.event, body.commit_id, body.comments[0].side, body.comments[0].path, body.comments[0].line], ['APPROVE', 'abcdef1', 'RIGHT', 'src/a.ts', 3]);
  assert.ok(body.body.startsWith(COMPLIMENT));
});

test('a blocking inline comment makes it REQUEST_CHANGES, and editing the blocker away makes it APPROVE', () => {
  const f = file();
  const { id } = addDraft(f, review({}, [{ path: 'a.ts', line: 1, text: 'This crashes on an empty cart.', severity: 'blocking' }, { path: 'b.ts', line: 2, text: 'Nit-free suggestion here.', severity: 'suggestion' }]));
  const d = (): never => listDrafts(f)[0] as never;
  assert.equal(JSON.parse(ghCall(d(), 'x').input ?? '{}').event, 'REQUEST_CHANGES');
  assert.equal(editDraft(f, id, listDrafts(f)[0]?.text ?? '', {}, ['', 'Nit-free suggestion here.']).ok, true, 'an emptied comment is removed');
  assert.equal(listDrafts(f)[0]?.review?.comments.length, 1);
  assert.equal(JSON.parse(ghCall(d(), 'x').input ?? '{}').event, 'APPROVE');
  assert.equal(editDraft(f, id, 'x', {}, ['one', 'too many']).ok, false, 'a comment count that does not match is refused');
});

test('approving a review names every inline comment: editing one invalidates the shown revision', () => {
  const f = file(); const g = stub();
  const { id } = addDraft(f, review());
  const before = R(f, id);
  editDraft(f, id, listDrafts(f)[0]?.text ?? '', {}, ['Softer wording on the inline note.']);
  assert.equal(approveAndPost(f, id, before, { run: g.run }).ok, false);
  assert.equal(g.calls.length, 0);
});

test('a review must carry its compliment slot: missing, empty or not opening the text is refused', () => {
  const f = file();
  assert.throws(() => addDraft(f, review({ review: { compliment: '', comments: [] } })));
  assert.throws(() => addDraft(f, review({ text: 'Looks fine to me.' })), /compliment/);
  assert.throws(() => addDraft(f, review({ severity: 'suggestion' })));
  assert.throws(() => addDraft(f, review({ target: { kind: 'general' } })));
  assert.throws(() => addDraft(f, review({}, [{ path: '../x', line: 1, text: 'hi there', severity: 'suggestion' }])));
});

test('a rival writer that failed before our posting row landed leaves us standing down, so what gh did always matches the fold', () => {
  const f = file();
  const { id } = addDraft(f, draft());
  let calls = 0;
  const run = (): GhResult => { calls += 1; return { status: 0, stdout: '{}', stderr: '' }; };
  let n = 0;
  const now = (): Date => {
    n += 1;
    if (n === 2) {   // just before our posting row: the rival's whole attempt lands first and fails
      const rows = [{ op: 'approve', text: draft().text }, { op: 'posting', nonce: 'rival' }, { op: 'post-failed', error: 'nope' }];
      for (const r of rows) appendFileSync(f, `${JSON.stringify({ ...r, id, ts: 't' })}\n`);
    }
    return new Date(0);
  };
  const out = approveAndPost(f, id, R(f, id), { run, now });
  assert.equal(out.ok, false);
  assert.equal(calls, 0, 'gh must not run for a posting row the fold ignores');
  assert.equal(listDrafts(f)[0]?.state, 'failed');
  assert.equal(approveAndPost(f, id, R(f, id), { run }).ok, true, 'a later approve is not locked out');
  assert.equal(calls, 1);
});

test('a hand-written add row with a missing or mistyped field is dropped without breaking the queue', () => {
  const f = file();
  addDraft(f, draft());
  for (const bad of [{ target: null }, { target: undefined }, { text: 5 }, { repo: 3 }, { key: 9 }]) {
    appendFileSync(f, `${JSON.stringify({ op: 'add', id: 'dr-x', ts: 'x', key: 'h', source: 'review', repo: 'a/b', pr: 7, severity: 'suggestion', text: 'hi', target: { kind: 'general' }, ...bad })}\n`);
  }
  assert.equal(listDrafts(f).length, 1);
});

test('a draft stuck in posting (the process died mid-call) can be rejected after two minutes, not before', () => {
  const f = file();
  const { id } = addDraft(f, draft());
  const at = (s: number) => ({ now: () => new Date(Date.UTC(2026, 9, 14, 12, 0, s)) });
  appendFileSync(f, [{ op: 'approve', text: draft().text }, { op: 'posting', nonce: 'n' }].map((r) => `${JSON.stringify({ ...r, id, ts: at(0).now().toISOString() })}\n`).join(''));
  assert.equal(rejectDraft(f, id, 'checked, not there', at(30)).ok, false);
  assert.equal(rejectDraft(f, id, 'checked, not there', at(121)).ok, true);
  assert.equal(listDrafts(f)[0]?.state, 'rejected');
});

test('addDraft refuses what the page would drop: an over-long reply-to or path, and a key that is not a string', () => {
  const f = file();
  assert.throws(() => addDraft(f, { ...draft(), replyTo: 'r'.repeat(101) }), /refused/);
  assert.throws(() => addDraft(f, { ...draft(), target: { kind: 'inline', path: `${'p/'.repeat(200)}a.ts`, line: 3, commitId: 'a'.repeat(40) } }), /refused/);
  assert.throws(() => addDraft(f, { ...draft(), key: 5 as unknown as string }), /refused/);
});

test('only a definite HTTP 4xx refusal allows a retry; a 5xx or a dropped connection is uncertain, so a comment that may exist is never posted twice', () => {
  for (const stderr of ['HTTP 502: Bad Gateway (https://api.github.com/x)', 'error connecting to api.github.com', '']) {
    const f = file();
    const { id } = addDraft(f, draft());
    const first = stub({ status: 1, stdout: '', stderr });
    assert.equal(approveAndPost(f, id, R(f, id), { run: first.run }).ok, false);
    assert.equal(listDrafts(f)[0]?.state, 'uncertain', stderr);
    const second = stub();
    assert.equal(approveAndPost(f, id, R(f, id), { run: second.run }).ok, false);
    assert.equal(second.calls.length, 0);
  }
});

test('a draft left approved (the process died before the posting row) can be rejected or approved again', () => {
  const f = file();
  const { id } = addDraft(f, draft());
  appendFileSync(f, `${JSON.stringify({ op: 'approve', id, ts: 't', text: draft().text })}\n`);
  assert.equal(listDrafts(f)[0]?.state, 'approved');
  assert.equal(rejectDraft(f, id, 'changed my mind').ok, true);
  assert.equal(listDrafts(f)[0]?.state, 'rejected');
});
