// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/lib/web/drafts-write.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWebServer } from './server.ts';
import { addDraft, draftsPath, listDrafts, revOf } from '../drafts/queue.ts';
import type { GhResult } from '../drafts/post.ts';

const NOW = new Date('2026-10-14T15:00:00Z');
const TOKEN = 'test-token-0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab';
const root = mkdtempSync(join(tmpdir(), 'web-drafts-'));
const client = join(root, 'client');
mkdirSync(join(client, 'dist'), { recursive: true });
writeFileSync(join(client, 'index.html'), '<p>home</p>');
const PAGE = { streams: ['Alpha'], repoStreams: {}, vaultName: '', trackerUrlBase: '', ticketNotePath: '', trackerKeyPattern: 'FAKE-\\d+', tz: 'UTC' };
const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

interface Rig { port: number; file: string; calls: string[][]; inputs: string[] }
/** The GraphQL answer for a PR with `n` unresolved Copilot threads. */
const threadsReply = (n: number): string => JSON.stringify({ data: { repository: { pullRequest: { state: 'OPEN', author: { login: 'robin-r' }, reviewThreads: { pageInfo: { hasNextPage: false }, nodes: Array.from({ length: n }, (_, i) => ({ id: `T${i}`, isResolved: false, isOutdated: false, path: 'a.ts', line: 1, comments: { pageInfo: { hasNextPage: false }, nodes: [{ databaseId: i + 1, body: 'x', author: { login: 'copilot-pull-request-reviewer', __typename: 'Bot' } }] } })) } } } } });
async function rig(name: string, gh: Partial<GhResult> = {}, copilot = 0): Promise<Rig> {
  const vault = join(root, name);
  mkdirSync(join(vault, 'Projects', 'p', 'Journal'), { recursive: true });
  mkdirSync(join(vault, 'Status'), { recursive: true });
  const calls: string[][] = [];
  const inputs: string[] = [];
  const ghRun = (a: string[], input?: string): GhResult => { if (a.includes('graphql')) return { status: 0, stdout: threadsReply(copilot), stderr: '' }; if (a.at(-1) === '.head.ref') return { status: 0, stdout: 'feat/widgets\n', stderr: '' }; if (a.includes('--jq')) return { status: 0, stdout: `abcdef1${'0'.repeat(33)}\n`, stderr: '' }; calls.push(a); if (input) inputs.push(input); return { status: 0, stdout: '{"html_url":"https://github.com/acme/widgets/pull/7#r1"}', stderr: '', ...gh }; };
  const server = createWebServer({ web: { vault, project: 'p', statusDir: join(vault, 'Status'), page: PAGE }, clientDir: client, now: () => NOW, log: () => {}, token: TOKEN, ghRun });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  servers.push(server);
  return { port: (server.address() as AddressInfo).port, file: draftsPath(vault, 'p'), calls, inputs };
}
const rev = (r: Rig): string => revOf(listDrafts(r.file)[0] as never);
const seed = (r: Rig, text = 'Could this guard an empty list?', key = 'k1'): string => addDraft(r.file, { key, source: 'review', repo: 'acme/widgets', pr: 7, severity: 'suggestion', text, target: { kind: 'general' } }, { now: () => NOW }).id;

function call(r: Rig, path: string, o: { method?: string; body?: unknown; token?: string | null } = {}): Promise<{ status: number; json: Record<string, any> }> {
  const body = o.body === undefined ? '' : JSON.stringify(o.body);
  const headers: Record<string, string> = { host: `127.0.0.1:${r.port}`, origin: `http://127.0.0.1:${r.port}`, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) };
  if (o.token !== null) headers['x-podium-token'] = o.token ?? TOKEN;
  if (!body) delete headers['content-length'], delete headers['content-type'];
  return new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port: r.port, path, method: o.method ?? 'POST', headers }, (res) => {
      let t = ''; res.on('data', (c) => { t += c; });
      res.on('end', () => { let json: Record<string, any> = {}; try { json = JSON.parse(t); } catch { /* */ } ok({ status: res.statusCode ?? 0, json }); });
    });
    req.on('error', fail); req.end(body);
  });
}

test('GET /api/drafts lists the queue and writes nothing', async () => {
  const r = await rig('list'); const id = seed(r);
  const before = readFileSync(r.file, 'utf8');
  const out = await call(r, '/api/drafts', { method: 'GET' });
  assert.equal(out.status, 200);
  assert.equal(out.json.drafts[0].id, id);
  assert.equal(out.json.drafts[0].prUrl, 'https://github.com/acme/widgets/pull/7');
  assert.equal(readFileSync(r.file, 'utf8'), before);
  assert.equal(r.calls.length, 0);
});

test('GET /api/drafts carries a review draft\'s PR author, the proposed verdict and the one-line context the needs-you list shows', async () => {
  const r = await rig('author');
  const id = addDraft(r.file, { key: 'k-review', source: 'review', repo: 'acme/widgets', pr: 9, severity: 'review', text: 'Nice tidy diff.', target: { kind: 'review', commitId: 'abcdef1' }, author: 'robin-r', context: 'Approves: 0 blocking, 1 suggestion(s); 1a2b3c', review: { compliment: 'Nice tidy diff.', comments: [] } }, { now: () => NOW }).id;
  const out = await call(r, '/api/drafts', { method: 'GET' });
  const d = out.json.drafts.find((x: Record<string, unknown>) => x.id === id);
  assert.equal(d.author, 'robin-r');
  assert.equal(d.review.event, 'APPROVE');
  assert.equal(d.context, 'Approves: 0 blocking, 1 suggestion(s); 1a2b3c');
});

test('approve over HTTP posts once through the stub gh; a second approve is refused and posts nothing', async () => {
  const r = await rig('approve'); const id = seed(r);
  const text = 'Could this guard an empty list?';
  const a = await call(r, '/api/drafts/approve', { body: { id, rev: rev(r) } });
  assert.deepEqual([a.status, a.json.ok, a.json.url], [200, true, 'https://github.com/acme/widgets/pull/7#r1']);
  const b = await call(r, '/api/drafts/approve', { body: { id, rev: rev(r) } });
  assert.equal(b.status, 409);
  assert.equal(r.calls.length, 1);
  assert.equal(listDrafts(r.file)[0]?.state, 'posted');
});

test('edit then approve posts the edited text', async () => {
  const r = await rig('edit'); const id = seed(r);
  const staleRev = rev(r);
  assert.equal((await call(r, '/api/drafts/edit', { body: { id, text: 'Softer wording.' } })).status, 200);
  assert.equal((await call(r, '/api/drafts/approve', { body: { id, rev: staleRev } })).status, 409, 'the shown text is stale');
  assert.equal(r.calls.length, 0);
  assert.equal((await call(r, '/api/drafts/approve', { body: { id, rev: rev(r) } })).status, 200);
  assert.ok(r.calls[0]?.includes('body=Softer wording.'));
});

test('reject records the reason and never posts', async () => {
  const r = await rig('reject'); const id = seed(r);
  assert.equal((await call(r, '/api/drafts/reject', { body: { id, reason: '' } })).status, 422);
  assert.equal((await call(r, '/api/drafts/reject', { body: { id, reason: 'not worth a comment' } })).status, 200);
  assert.equal((await call(r, '/api/drafts/approve', { body: { id, rev: rev(r) } })).status, 409);
  assert.equal(r.calls.length, 0);
  assert.equal(listDrafts(r.file)[0]?.rejectReason, 'not worth a comment');
});

test('a gh failure surfaces as a refusal with nothing marked posted', async () => {
  const r = await rig('fail', { status: 1, stdout: '', stderr: 'HTTP 422: nope' }); const id = seed(r);
  const a = await call(r, '/api/drafts/approve', { body: { id, rev: rev(r) } });
  assert.equal(a.status, 409);
  assert.match(a.json.message, /Nothing was posted/);
  assert.equal(listDrafts(r.file)[0]?.state, 'failed');
});

test('the write routes need the token, the right method and an exact body shape', async () => {
  const r = await rig('guards'); const id = seed(r);
  const body = { id, rev: rev(r) };
  assert.equal((await call(r, '/api/drafts/approve', { body, token: null })).status, 403);
  assert.equal((await call(r, '/api/drafts/approve', { body, token: 'wrong' })).status, 403);
  assert.equal((await call(r, '/api/drafts/approve', { method: 'GET' })).status, 405);
  assert.equal((await call(r, '/api/drafts/approve', { body: { ...body, extra: 1 } })).status, 400);
  assert.equal((await call(r, '/api/drafts/approve', { body: { id: 'nope', rev: '0123456789ab' } })).status, 400);
  assert.equal((await call(r, '/api/drafts/approve', { body: { id: 'dr-00000000', rev: '0123456789ab' } })).status, 404);
  assert.equal(r.calls.length, 0);
  assert.equal(listDrafts(r.file)[0]?.state, 'pending');
});

test('a long draft passes the larger body limit; the same body on another write path is refused', async () => {
  const r = await rig('long'); const long = 'word '.repeat(700);
  const id = seed(r, long, 'long');
  assert.equal((await call(r, '/api/drafts/edit', { body: { id, text: `${long}!` } })).status, 200);
  assert.equal((await call(r, '/api/priorities/add', { body: { text: long } })).status, 413);
});

test('a review draft over HTTP: the view carries the event and rev, edit takes comment texts, approve posts one review through stdin JSON', async () => {
  const r = await rig('review');
  const compliment = 'The ID validation before anything goes into a URL is exactly right.';
  const id = addDraft(r.file, { key: 'rv1', source: 'review', repo: 'acme/widgets', pr: 7, severity: 'review', text: `${compliment}\n\nResolve these however you think best.`, target: { kind: 'review', commitId: 'abcdef1' }, review: { compliment, comments: [{ path: 'a.ts', line: 3, text: 'Could this guard an empty list?', severity: 'suggestion' }] } }, { now: () => NOW }).id;
  const list = await call(r, '/api/drafts', { method: 'GET' });
  assert.equal(list.json.drafts[0].review.event, 'APPROVE');
  const first = list.json.drafts[0].rev as string;
  assert.equal((await call(r, '/api/drafts/edit', { body: { id, text: `${compliment}\n\nOk.`, comments: ['Softer inline note.'] } })).status, 200);
  assert.equal((await call(r, '/api/drafts/approve', { body: { id, rev: first } })).status, 409, 'the earlier revision is stale');
  assert.equal((await call(r, '/api/drafts/edit', { body: { id, text: 'x', comments: ['a', 'b'] } })).status, 422, 'wrong comment count');
  assert.equal((await call(r, '/api/drafts/approve', { body: { id, rev: rev(r) } })).status, 200);
  assert.equal(r.calls.length, 1);
  assert.ok(r.calls[0]?.includes('repos/acme/widgets/pulls/7/reviews'));
});

test('approve over HTTP refuses an approving review while Copilot threads are open (409 copilot), then `as: comment` posts it as a COMMENT review', async () => {
  const r = await rig('copilot', {}, 2);
  const compliment = 'The ID validation before anything goes into a URL is exactly right.';
  const id = addDraft(r.file, { key: 'rv2', source: 'review', repo: 'acme/widgets', pr: 7, severity: 'review', text: `${compliment}\n\nOk.`, target: { kind: 'review', commitId: 'abcdef1' }, review: { compliment, comments: [] } }, { now: () => NOW }).id;
  const refused = await call(r, '/api/drafts/approve', { body: { id, rev: rev(r) } });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error, 'copilot');
  assert.equal(r.calls.length, 0);
  assert.equal((await call(r, '/api/drafts/approve', { body: { id, rev: rev(r), as: 'nonsense' } })).status, 400, 'only as: comment is a shape');
  const ok = await call(r, '/api/drafts/approve', { body: { id, rev: rev(r), as: 'comment' } });
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(r.inputs[0] ?? '{}').event, 'COMMENT');
});
