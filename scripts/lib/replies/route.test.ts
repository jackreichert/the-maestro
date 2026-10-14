// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/lib/replies/route.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addDraft, listDrafts, revOf } from '../drafts/queue.ts';
import { approveAndPost, postBotReply } from '../drafts/post.ts';
import type { GhResult, GhRun } from '../drafts/post.ts';
import { routeReplies } from './route.ts';
import { isBotAuthor, isBotLogin } from '../github-bots.ts';
import { fetchThreads } from './threads.ts';

const file = (): string => { const d = mkdtempSync(join(tmpdir(), 'replies-')); mkdirSync(join(d, 'J')); return join(d, 'J', 'drafts.jsonl'); };
type C = { id: number; login: string | null; type?: string; body?: string };
interface T { id: string; resolved?: boolean; comments: C[] }
const ok = (stdout = '{}'): GhResult => ({ status: 0, stdout, stderr: '' });

/** A gh stand-in for one PR: answers the thread query, records every write. */
function rig(threads: T[], pr: { author?: string; state?: string } = {}): { run: GhRun; writes: string[][] } {
  const writes: string[][] = [];
  const run: GhRun = (args) => {
    if (args[0] === 'api' && args[1] === 'graphql' && args.some((a) => a.startsWith('query=query'))) {
      return ok(JSON.stringify({ data: { repository: { pullRequest: { state: pr.state ?? 'OPEN', author: { login: pr.author ?? 'me' }, reviewThreads: { pageInfo: { hasNextPage: false }, nodes: threads.map((t) => ({ id: t.id, isResolved: !!t.resolved, isOutdated: false, path: 'src/a.ts', line: 4, comments: { nodes: t.comments.map((c) => ({ databaseId: c.id, body: c.body ?? 'Please check this.', author: c.login === null ? null : { login: c.login, __typename: c.type ?? 'User' } })) } })) } } } } }));
    }
    writes.push(args);
    return ok('{"html_url":"https://github.com/acme/widgets/pull/7#discussion_r9"}');
  };
  return { run, writes };
}
const human: T = { id: 'PRRT_h', comments: [{ id: 101, login: 'jane', body: 'Why not use a map here?' }] };
const bot: T = { id: 'PRRT_b', comments: [{ id: 201, login: 'copilot-pull-request-reviewer', type: 'Bot', body: 'Possible null dereference.' }] };
const TEXT = 'Good catch, I added a guard in the next commit.';
const go = (f: string, r: ReturnType<typeof rig>, replies: { commentId: number; kind: string; text: string }[]) => routeReplies(f, { repo: 'acme/widgets', pr: 7, self: 'me', replies, run: r.run });

test('a human thread is queued pending and writes nothing; a bot thread is answered directly and never queued', () => {
  const f = file();
  const r = rig([human, bot]);
  const out = go(f, r, [{ commentId: 101, kind: 'fixed', text: TEXT }, { commentId: 201, kind: 'fixed', text: TEXT }]);
  assert.deepEqual(out.map((x) => x.route), ['queued', 'posted']);
  const drafts = listDrafts(f);
  assert.equal(drafts.length, 1, 'only the human thread waits in the queue');
  assert.ok(drafts[0] && drafts[0].state === 'pending' && drafts[0].source === 'reply' && drafts[0].replyTo === 'jane');
  assert.equal(r.writes.length, 2, 'the bot reply and its resolve; nothing for the human thread');
  assert.match(r.writes[0]?.[3] ?? '', /pulls\/7\/comments\/201\/replies$/);
  assert.ok(r.writes[1]?.some((a) => a.startsWith('id=PRRT_b')), 'a fix resolves the bot thread');
});

test('human round trip: the queued reply posts to the right thread only after Approve, once', () => {
  const f = file();
  const r = rig([human]);
  go(f, r, [{ commentId: 101, kind: 'fixed', text: TEXT }]);
  assert.equal(r.writes.length, 0);
  const d = listDrafts(f)[0];
  assert.ok(d);
  const gh = rig([]);
  const posted = approveAndPost(f, d.id, revOf(d), { run: gh.run });
  assert.equal(posted.ok, true);
  assert.deepEqual(gh.writes.map((w) => w[3]), ['repos/acme/widgets/pulls/7/comments/101/replies']);
  assert.equal(gh.writes[0]?.includes(`body=${TEXT}`), true);
  assert.equal(approveAndPost(f, d.id, revOf(d), { run: gh.run }).ok, false);
  assert.equal(gh.writes.length, 1);
});

test('reject never posts, and the same unanswered comment does not queue twice, while a newer comment does', () => {
  const f = file();
  go(f, rig([human]), [{ commentId: 101, kind: 'decline', text: 'I would keep the list: order matters in the output.' }]);
  assert.equal(go(f, rig([human]), [{ commentId: 101, kind: 'decline', text: 'I would keep the list: order matters in the output.' }])[0]?.route, 'queued');
  assert.equal(listDrafts(f).length, 1, 'same key, no duplicate');
  const again: T = { id: 'PRRT_h', comments: [...human.comments, { id: 102, login: 'me', body: 'x' }, { id: 103, login: 'jane', body: 'Still not convinced.' }] };
  go(f, rig([again]), [{ commentId: 101, kind: 'question', text: 'Could you say more about the case you have in mind?' }]);
  assert.equal(listDrafts(f).length, 2, 'a new comment from them is a new draft');
});

test('a thread with a person anywhere in it is never answered directly, even if the last word is a bot', () => {
  const f = file();
  const mixed: T = { id: 'PRRT_m', comments: [{ id: 301, login: 'copilot-pull-request-reviewer', type: 'Bot' }, { id: 302, login: 'jane', body: 'I agree with the bot.' }, { id: 303, login: 'aikido-pr-checks', type: 'Bot' }] };
  const r = rig([mixed]);
  assert.equal(go(f, r, [{ commentId: 301, kind: 'fixed', text: TEXT }])[0]?.route, 'queued');
  assert.equal(r.writes.length, 0);
  assert.equal(listDrafts(f)[0]?.replyTo, 'jane', 'addressed to the person, not to the bot that spoke last');
});

test('postBotReply re-reads the thread itself: asked to answer a human thread it refuses and writes nothing', () => {
  const f = file();
  const r = rig([human]);
  const out = postBotReply(f, { repo: 'acme/widgets', pr: 7, self: 'me', rootId: 101, text: TEXT, resolve: true }, { run: r.run });
  assert.equal(out.ok, false);
  assert.equal(out.ok === false && out.code, 'not-bot');
  assert.equal(r.writes.length, 0);
  assert.equal(existsSync(join(f, '..', 'bot-replies.jsonl')), false);
});

test('addDraft refuses a reply to a bot or with no author, so a bot thread can never wait in the queue', () => {
  const f = file();
  const base = { key: 'k1', source: 'reply' as const, repo: 'acme/widgets', pr: 7, severity: 'reply' as const, text: TEXT, target: { kind: 'reply' as const, commentId: 5 } };
  for (const replyTo of ['copilot-pull-request-reviewer', 'dependabot[bot]', 'Aikido-PR-Checks', '', undefined]) assert.throws(() => addDraft(f, { ...base, ...(replyTo === undefined ? {} : { replyTo }) }), /refused/, String(replyTo));
  assert.doesNotThrow(() => addDraft(f, { ...base, replyTo: 'jane' }));
});

test('a bot reply is idempotent: the same thread state is answered once, a cut-off call is never retried, a refusal can be', () => {
  const f = file();
  const r = rig([bot]);
  const send = (run: GhRun) => postBotReply(f, { repo: 'acme/widgets', pr: 7, self: 'me', rootId: 201, text: TEXT, resolve: false }, { run });
  assert.equal(send(r.run).ok, true);
  const second = send(r.run);
  assert.ok(second.ok && !second.posted);
  assert.equal(r.writes.filter((w) => w[3]?.endsWith('/replies')).length, 1);

  const g = file();
  const cut: GhRun = (a) => (a[1] === 'graphql' ? rig([bot]).run(a) : { status: null, stdout: '', stderr: '' });
  assert.equal(postBotReply(g, { repo: 'acme/widgets', pr: 7, self: 'me', rootId: 201, text: TEXT, resolve: false }, { run: cut }).ok, false);
  const retry = rig([bot]);
  const again = postBotReply(g, { repo: 'acme/widgets', pr: 7, self: 'me', rootId: 201, text: TEXT, resolve: false }, { run: retry.run });
  assert.equal(again.ok === false && again.code, 'uncertain');
  assert.equal(retry.writes.length, 0);

  const h = file();
  const refused: GhRun = (a) => (a[1] === 'graphql' ? rig([bot]).run(a) : { status: 1, stdout: '', stderr: 'HTTP 422: nope' });
  assert.equal(postBotReply(h, { repo: 'acme/widgets', pr: 7, self: 'me', rootId: 201, text: TEXT, resolve: false }, { run: refused }).ok, false);
  assert.equal(postBotReply(h, { repo: 'acme/widgets', pr: 7, self: 'me', rootId: 201, text: TEXT, resolve: false }, { run: rig([bot]).run }).ok, true);
});

test('a question to a bot is not resolved; a decline is', () => {
  const f = file();
  const q = rig([bot]);
  go(f, q, [{ commentId: 201, kind: 'question', text: 'Could you say which input triggers this?' }]);
  assert.equal(q.writes.some((w) => w.includes('query=mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}')), false);
  const g = file();
  const d = rig([bot]);
  go(g, d, [{ commentId: 201, kind: 'decline', text: 'I would leave this as is: the caller already checks for null.' }]);
  assert.equal(d.writes.some((w) => w.some((a) => a.startsWith('query=mutation'))), true);
});

test('replies refuse: a PR that is not yours, a resolved thread, one you answered last, a bad kind, or text that names an assistant', () => {
  const f = file();
  assert.throws(() => go(f, rig([human], { author: 'someone-else' }), [{ commentId: 101, kind: 'fixed', text: TEXT }]), /own open PR/);
  assert.throws(() => go(f, rig([human], { state: 'MERGED' }), [{ commentId: 101, kind: 'fixed', text: TEXT }]), /own open PR/);
  const answered: T = { id: 'a', comments: [{ id: 401, login: 'jane' }, { id: 402, login: 'me' }] };
  const r = rig([answered, { ...human, resolved: true }]);
  const out = go(f, r, [{ commentId: 401, kind: 'fixed', text: TEXT }, { commentId: 101, kind: 'fixed', text: TEXT }, { commentId: 999, kind: 'fixed', text: TEXT }, { commentId: 101, kind: 'maybe', text: TEXT }, { commentId: 101, kind: 'fixed', text: 'As an AI I added a guard.' }]);
  assert.deepEqual(out.map((x) => x.route), ['refused', 'refused', 'refused', 'refused', 'refused']);
  assert.equal(listDrafts(f).length, 0);
  assert.equal(r.writes.length, 0);
});

test('bot detection is strict: GitHub says Bot, a [bot] login, or a named review account; a missing author is a person', () => {
  assert.equal(isBotLogin('dependabot[bot]'), true);
  assert.equal(isBotLogin('Copilot-Pull-Request-Reviewer'), true);
  assert.equal(isBotLogin('jane'), false);
  assert.equal(isBotLogin('copilot-fan'), false);
  assert.equal(isBotAuthor(null), false);
  assert.equal(isBotAuthor({ login: 'x', __typename: 'Bot' }), true);
  const t = fetchThreads('acme/widgets', 7, 'me', rig([{ id: 'n', comments: [{ id: 1, login: null }] }]).run);
  assert.equal(t.threads[0]?.kind, 'human');
});

test('the helper has exactly one direct-post path, and it is the bot one', () => {
  const root = join(import.meta.dirname, '..', '..');
  for (const f of ['lib/replies/route.ts', 'lib/replies/threads.ts', 'reply-drafts.ts']) {
    const src = readFileSync(join(root, f), 'utf8');
    assert.equal(/approveAndPost|'-X', 'POST'|--method/.test(src), false, f);
  }
  assert.match(readFileSync(join(root, 'lib/replies/route.ts'), 'utf8'), /postBotReply/);
});
