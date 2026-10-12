// Run: node --test scripts/web/client/test/api-projects.test.ts
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadProjects } from '../src/api.ts';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const fixture = readFileSync(new URL('../fixtures/projects.json', import.meta.url), 'utf8');
const json = (body: string, status = 200): Response => new Response(body, { status, headers: { 'content-type': 'application/json' } });

/** A fetch whose /api/projects answers with `api`, and which serves the bundled fixture like the static preview does. */
function stubFetch(api: () => Response): void {
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.startsWith('/api/projects')) return api();
    if (u === '/fixtures/projects.json') return json(fixture);
    throw new Error(`unexpected ${u}`);
  }) as typeof fetch;
}

test('a live server that fails /api/projects is an error, never the bundled sample projects', async () => {
  stubFetch(() => json('{}', 500));
  await assert.rejects(loadProjects(true), /500/);
});

test('a live server that sends an unusable projects body is an error too', async () => {
  stubFetch(() => json('{"nope":1}'));
  await assert.rejects(loadProjects(true));
});

test('with no server at all (static preview) the bundled sample stands in', async () => {
  stubFetch(() => { throw new TypeError('network down'); });
  const got = await loadProjects(false);
  assert.equal(got.source, 'fixture');
  assert.ok(got.data.rows.length > 0);
});
