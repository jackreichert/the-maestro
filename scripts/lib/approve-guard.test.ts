// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/lib/approve-guard.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkApprove } from './approve-guard.ts';
import type { GhOut } from './approve-guard.ts';

const HEAD = `abcdef1${'0'.repeat(33)}`;
type Thread = { login: string; type?: string; resolved?: boolean; extra?: { login: string; type?: string }[] };
const thread = (t: Thread, i: number): object => ({ id: `T${i}`, isResolved: !!t.resolved, isOutdated: false, path: 'src/a.ts', line: 10 + i, comments: { pageInfo: { hasNextPage: false }, nodes: [{ login: t.login, type: t.type }, ...(t.extra ?? [])].map((c, j) => ({ databaseId: i * 10 + j + 1, body: 'x', author: { login: c.login, __typename: c.type ?? 'User' } })) } });
interface Rig { calls: string[][]; run: (a: string[]) => GhOut; head: string; headRef: string; threads: Thread[]; graphql: Partial<GhOut> }
const rig = (threads: Thread[] = []): Rig => {
  const out: Rig = { calls: [], head: HEAD, headRef: 'feat/x', threads, graphql: {}, run: (a) => {
    out.calls.push(a);
    if (a.includes('graphql')) return { status: 0, stderr: '', stdout: JSON.stringify({ data: { repository: { pullRequest: { state: 'OPEN', author: { login: 'robin-r' }, reviewThreads: { pageInfo: { hasNextPage: false }, nodes: out.threads.map(thread) } } } } }), ...out.graphql };
    return { status: 0, stderr: '', stdout: `${a.at(-1) === '.head.ref' ? out.headRef : out.head}\n` };
  } };
  return out;
};
const COPILOT = { login: 'copilot-pull-request-reviewer', type: 'Bot' };

const T = (i: number, over: object = {}) => ({ threadId: String(i * 10 + 1), worthAddressing: false, reason: 'A style nit the author can ignore.', ...over });

test('a clean PR whose head is the reviewed commit approves, and a stored short sha matches by prefix', () => {
  assert.deepEqual(checkApprove(rig().run, 'acme/widgets', 7, HEAD), { ok: true, event: 'APPROVE', worth: [], blocking: [] });
  assert.equal(checkApprove(rig().run, 'acme/widgets', 7, 'abcdef1').ok, true);
});

test('an open bot thread triaged not worth addressing approves with nothing to point out', () => {
  const v = checkApprove(rig([COPILOT]).run, 'acme/widgets', 7, HEAD, [T(0)]);
  assert.deepEqual(v, { ok: true, event: 'APPROVE', worth: [], blocking: [] });
});

test('a thread triaged worth addressing still approves, and is returned with its link and reason for the body', () => {
  const v = checkApprove(rig([COPILOT]).run, 'acme/widgets', 7, HEAD, [T(0, { worthAddressing: true, reason: 'The empty cart is not handled here.' })]);
  assert.equal(v.ok && v.event, 'APPROVE');
  assert.deepEqual(v.ok && v.worth, [{ id: '1', path: 'src/a.ts', line: 10, author: COPILOT.login, url: 'https://github.com/acme/widgets/pull/7#discussion_r1', reason: 'The empty cart is not handled here.' }]);
});

test('a thread triaged blocking turns the approval into a COMMENT; the GraphQL node id names a thread as well as its root comment id', () => {
  const v = checkApprove(rig([COPILOT]).run, 'acme/widgets', 7, HEAD, [{ threadId: 'T0', worthAddressing: true, severity: 'blocking', reason: 'Drops rows on a retry.' }]);
  assert.equal(v.ok && v.event, 'COMMENT');
  assert.equal(v.ok && v.blocking.length, 1);
  assert.equal(v.ok && v.worth.length, 1);
});

test('an open bot thread with no triage entry refuses and is listed: Copilot, Aikido and any [bot] alike', () => {
  for (const bot of [COPILOT, { login: 'aikido-pr-checks', type: 'User' }, { login: 'some-scanner[bot]', type: 'User' }]) {
    const v = checkApprove(rig([bot]).run, 'acme/widgets', 7, HEAD, []);
    assert.equal(!v.ok && v.code, 'untriaged');
    assert.deepEqual(!v.ok && v.threads.map((t) => [t.id, t.path, t.line, t.author]), [['1', 'src/a.ts', 10, bot.login]]);
    assert.match(!v.ok ? v.message : '', /1 open bot thread has not been triaged.*at src\/a\.ts:10 \(thread 1\).*triage it, or post this as a comment/);
  }
});

test('only the untriaged threads are listed, a triage for a thread that is not open is ignored, and a long list is cut with a count', () => {
  const g = rig([COPILOT, COPILOT, ...Array.from({ length: 6 }, () => COPILOT)]);
  const v = checkApprove(g.run, 'acme/widgets', 7, HEAD, [T(0), T(99)]);
  assert.equal(!v.ok && v.threads.length, 7);
  assert.match(!v.ok ? v.message : '', /7 open bot threads have not been triaged.*and 2 more/);
  assert.equal(checkApprove(rig([{ ...COPILOT, resolved: true }]).run, 'acme/widgets', 7, HEAD).ok, true, 'a resolved thread needs no triage');
});

test('a bot thread still needs triage after a person replied in it, because it is open', () => {
  assert.equal(checkApprove(rig([{ ...COPILOT, extra: [{ login: 'robin-r' }] }]).run, 'acme/widgets', 7, HEAD).ok, false);
});

test('threads only people opened never matter, even with a bot reply inside', () => {
  const v = checkApprove(rig([{ login: 'robin-r' }, { login: 'sam-q', extra: [COPILOT] }]).run, 'acme/widgets', 7, HEAD);
  assert.deepEqual(v, { ok: true, event: 'APPROVE', worth: [], blocking: [] });
});

test('a head that moved since the review refuses before any thread is read', () => {
  const g = rig(); g.head = `9${'0'.repeat(39)}`;
  const v = checkApprove(g.run, 'acme/widgets', 7, HEAD);
  assert.equal(!v.ok && v.code, 'head-moved');
  assert.match(!v.ok ? v.message : '', /reviewed abcdef1, head is now 9000000.*Re-review/);
  assert.equal(g.calls.some((a) => a.includes('graphql')), false);
});

test('anything unreadable refuses: the head, the threads, a missing or malformed reviewed commit', () => {
  const blind = rig(); blind.run = () => ({ status: 1, stdout: '', stderr: 'gh: Bad credentials' });
  const a = checkApprove(blind.run, 'acme/widgets', 7, HEAD);
  assert.equal(!a.ok && a.code, 'head-unreadable');
  const g = rig(); g.graphql = { status: 1, stdout: '', stderr: 'boom' };
  const b = checkApprove(g.run, 'acme/widgets', 7, HEAD);
  assert.equal(!b.ok && b.code, 'threads-unreadable');
  const thrower = (): GhOut => { throw new Error('spawn failed'); };
  assert.equal(checkApprove(thrower, 'acme/widgets', 7, HEAD).ok, false);
  for (const bad of ['', 'zzz', 'abc', '--help']) assert.equal(checkApprove(rig().run, 'acme/widgets', 7, bad).ok, false, `reviewed head "${bad}"`);
});

test('a backmerge is exempt from the thread rules, a look-alike branch is not, and the exemption never covers a moved head', () => {
  const g = rig([COPILOT]); g.headRef = 'backmerge/main-into-develop';
  assert.equal(checkApprove(g.run, 'acme/widgets', 7, HEAD).ok, true);
  g.headRef = 'back-merge-main';
  assert.equal(checkApprove(g.run, 'acme/widgets', 7, HEAD).ok, true);
  g.headRef = 'feat/backmerges-are-great';
  assert.equal(checkApprove(g.run, 'acme/widgets', 7, HEAD).ok, false);
  g.headRef = 'backmerge/x'; g.head = `9${'0'.repeat(39)}`;
  assert.equal(checkApprove(g.run, 'acme/widgets', 7, HEAD).ok, false);
});
