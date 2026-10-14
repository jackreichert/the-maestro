// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/lib/drafts/queue.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addDraft, editDraft, listDrafts, rejectDraft, withLock } from './queue.ts';
import type { NewDraft } from './queue.ts';
import { approveAndPost, ghArgs } from './post.ts';
import type { GhResult } from './post.ts';

const file = (): string => { const d = mkdtempSync(join(tmpdir(), 'drafts-')); mkdirSync(join(d, 'J')); return join(d, 'J', 'drafts.jsonl'); };
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
  const out = approveAndPost(f, id, draft().text, { run: g.run });
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
  approveAndPost(f, id, draft().text, { run: g.run });
  const again = approveAndPost(f, id, draft().text, { run: g.run });
  assert.equal(again.ok, false);
  assert.equal(g.calls.length, 1);
});

test('edit then approve posts the edited text, and approving stale text is refused as changed', () => {
  const f = file(); const g = stub();
  const { id } = addDraft(f, draft());
  assert.equal(editDraft(f, id, 'Friendlier wording here.').ok, true);
  const stale = approveAndPost(f, id, draft().text, { run: g.run });
  assert.deepEqual([stale.ok, !stale.ok && stale.code], [false, 'changed']);
  assert.equal(g.calls.length, 0);
  assert.equal(approveAndPost(f, id, 'Friendlier wording here.', { run: g.run }).ok, true);
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
  assert.equal(approveAndPost(f, id, draft().text, { run: g.run }).ok, false);
  assert.equal(g.calls.length, 0);
  assert.equal(readFileSync(f, 'utf8').includes('"op":"posting"'), false);
});

test('a gh refusal leaves nothing posted and allows a retry; a cut-off call is uncertain and never retried', () => {
  const f = file();
  const { id } = addDraft(f, draft());
  const no = stub({ status: 1, stdout: '', stderr: 'HTTP 422: line is not part of the diff' });
  const r = approveAndPost(f, id, draft().text, { run: no.run });
  assert.equal(r.ok, false);
  assert.equal(listDrafts(f)[0]?.state, 'failed');
  assert.match(listDrafts(f)[0]?.error ?? '', /422/);
  const cut = stub({ status: null });
  approveAndPost(f, id, draft().text, { run: cut.run });
  assert.equal(listDrafts(f)[0]?.state, 'uncertain');
  const again = stub();
  assert.equal(approveAndPost(f, id, draft().text, { run: again.run }).ok, false);
  assert.equal(again.calls.length, 0);
  assert.equal(rejectDraft(f, id, 'checked, it is there').ok, false, 'uncertain is not rejectable until checked by hand');
});

test('a crash after the posting row, before the result, leaves the draft unpostable', () => {
  const f = file(); const g = stub();
  const { id } = addDraft(f, draft());
  appendFileSync(f, `${JSON.stringify({ op: 'approve', id, ts: 't', text: draft().text })}\n${JSON.stringify({ op: 'posting', id, ts: 't' })}\n`);
  assert.equal(listDrafts(f)[0]?.state, 'posting');
  assert.equal(approveAndPost(f, id, draft().text, { run: g.run }).ok, false);
  assert.equal(g.calls.length, 0);
});

test('a hand-written row that addDraft would refuse never becomes a draft, so it can never reach gh', () => {
  const f = file();
  const bad = { op: 'add', id: 'dr-0000000a', ts: 't', ...draft(), repo: '{owner}/{repo}', target: { kind: 'inline', path: '-p', line: '@/etc/hosts', commitId: 'zz' } };
  appendFileSync(f, `${JSON.stringify(bad)}\n`);
  assert.equal(listDrafts(f).length, 0);
  const g = stub();
  assert.equal(approveAndPost(f, 'dr-0000000a', draft().text, { run: g.run }).ok, false);
  assert.equal(g.calls.length, 0);
});

test('a crash between the approve and posting rows leaves the draft approvable again, and gh was never called', () => {
  const f = file(); const g = stub();
  const { id } = addDraft(f, draft());
  appendFileSync(f, `${JSON.stringify({ op: 'approve', id, ts: 't', text: draft().text })}\n`);
  assert.equal(listDrafts(f)[0]?.state, 'approved');
  assert.equal(approveAndPost(f, id, draft().text, { run: g.run }).ok, true);
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
  const out = approveAndPost(f, id, draft().text, { run });
  assert.equal(out.ok, false);
  assert.equal(calls, 0);
});

test('target kinds map to the right gh endpoint', () => {
  const f = file();
  const base = { ...listDrafts(f)[0], id: 'x', state: 'pending' as const, createdAt: '', updatedAt: '', ...draft() };
  assert.match(ghArgs({ ...base, source: 'reply', severity: 'reply', target: { kind: 'reply', commentId: 99 } }, 't')[3] ?? '', /pulls\/7\/comments\/99\/replies$/);
  assert.match(ghArgs({ ...base, target: { kind: 'general' } }, 't')[3] ?? '', /issues\/7\/comments$/);
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
  assert.deepEqual(uses('spawnGh'), ['lib/drafts/post.ts']);
  assert.deepEqual(uses('drafts/post.ts'), ['lib/web/drafts-write.ts', 'lib/web/server.ts']);
  const write = readFileSync(join(root, 'lib/web/drafts-write.ts'), 'utf8');
  assert.equal(write.match(/approveAndPost\(/g)?.length, 1);
  assert.match(write, /if \(op === 'approve'\) return approveAndPost/);
  assert.equal(/^import .*post\.ts/m.test(readFileSync(join(root, 'lib/drafts/queue.ts'), 'utf8')), false, 'queue.ts does not import post.ts');
});
