// Run: node --test scripts/web/client/test/others-api.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOthersActions } from '../src/others-api.ts';

const HEAD = 'b'.repeat(40);
const pr = { repo: 'acme/app', number: 4, headSha: HEAD };
type Seen = { url: string; body?: unknown };
function rig(reply: (url: string) => Response | Promise<Response>): { seen: Seen[]; fetchFn: (u: string, i?: RequestInit) => Promise<Response> } {
  const seen: Seen[] = [];
  return { seen, fetchFn: async (u, i) => { if (u === '/api/edit-token') return new Response(JSON.stringify({ token: 't' }), { status: 200 }); seen.push({ url: u, body: i?.body ? JSON.parse(String(i.body)) : undefined }); return reply(u); } };
}
const ok = (): Response => new Response(JSON.stringify({ ok: true }), { status: 200 });

test('ignore and review-anyway pin the head the page drew; unignore names only the PR', async () => {
  const { seen, fetchFn } = rig(ok);
  const a = createOthersActions(fetchFn);
  assert.equal(await a.send('ignore', pr), null);
  assert.equal(await a.send('review-anyway', pr), null);
  assert.equal(await a.send('unignore', pr), null);
  assert.deepEqual(seen, [
    { url: '/api/others/ignore', body: { repo: 'acme/app', pr: 4, head: HEAD } },
    { url: '/api/others/review-anyway', body: { repo: 'acme/app', pr: 4, head: HEAD } },
    { url: '/api/others/unignore', body: { repo: 'acme/app', pr: 4 } },
  ]);
});

test('a PR with no recorded head cannot be ignored, and nothing is sent', async () => {
  const { seen, fetchFn } = rig(ok);
  assert.match(await createOthersActions(fetchFn).send('ignore', { repo: 'acme/app', number: 4 }) ?? '', /no commit recorded/);
  assert.deepEqual(seen, []);
});

test('a refusal carries the server\'s words; a network failure and a missing token say nothing changed', async () => {
  const refused = rig(() => new Response(JSON.stringify({ error: 'refused', message: 'The PR has new commits.' }), { status: 409 }));
  assert.equal(await createOthersActions(refused.fetchFn).send('ignore', pr), 'The PR has new commits.');
  const down = rig(() => { throw new Error('offline'); });
  assert.match(await createOthersActions(down.fetchFn).send('ignore', pr) ?? '', /Could not reach the server/);
  const noToken = createOthersActions(async () => new Response('{}', { status: 500 }));
  assert.match(await noToken.send('unignore', pr) ?? '', /permission/);
});

test('add sends the trimmed text as { ref }, and an empty box sends nothing', async () => {
  const { seen, fetchFn } = rig(ok);
  const a = createOthersActions(fetchFn);
  assert.equal(await a.add('  acme/app#4 '), null);
  assert.match(await a.add('   ') ?? '', /Type a PR/);
  assert.deepEqual(seen, [{ url: '/api/others/add', body: { ref: 'acme/app#4' } }]);
});

test('add carries the server\'s words when it refuses', async () => {
  const refused = rig(() => new Response(JSON.stringify({ error: 'refused', message: 'That is not a PR.' }), { status: 422 }));
  assert.equal(await createOthersActions(refused.fetchFn).add('hello'), 'That is not a PR.');
});
