// Run: node --test scripts/lib/podium-gate/checks.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECKS, render, runGate } from './checks.ts';
import type { Probe, Reply, Result } from './checks.ts';

const ok = (body: unknown): Reply => ({ status: 200, text: typeof body === 'string' ? body : JSON.stringify(body) });
const NONE: Reply = { status: 404, text: '' };
const CSS = ['--font-display', '--font-sans', '--font-mono', '--grid-columns', '--hairline', '--chart-grid', '--glyph-critical', '--dur-breathe'].map((t) => `${t}: x;`).join('\n');
const run = (kind: string): { kind: string; state: string } => ({ kind, state: 'ok' });
const tab = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  project: 'avonlea-api', overview: { state: 'ok', summary: 's', now: [], next: ['ship it'] }, run: ['setup', 'run', 'test', 'deploy'].map(run),
  blocking: { clear: true, tickets: [], moreTickets: 0 }, work: { open: [] }, docs: { decisions: { title: 'DECISIONS', ref: { label: 'd' } } }, ...over,
});

/** A Podium with every piece built; each test removes or breaks one piece. */
function podium(over: Record<string, Reply> = {}, rule: 'absent' | 'works' | 'broken' = 'works', homeOver: Record<string, unknown> = {}): Probe {
  const routes: Record<string, Reply> = {
    '/theme.css': ok(CSS), '/fonts/geist.woff2': ok('f'), '/fonts/geist-mono.woff2': ok('f'), '/fonts/instrument-serif.woff2': ok('f'), '/': ok('<link href="/theme.css">'),
    '/api/state': ok({ streams: ['Avonlea', 'other'], asks: [], done: [] }),
    '/api/projects': ok({ rows: [{ stream: 'Avonlea' }], links: [], weeks: [] }),
    '/api/charts': ok({ throughput: [] }),
    '/api/streams/Avonlea/home': ok({ shared: [{ title: 'Spec', by: 'Anne', date: '2026-10-01', kind: 'web', url: 'https://example.test/x' }], projects: [tab()], ...homeOver }),
    ...over,
  };
  return { get: async (path) => routes[path] ?? NONE, plainLanguageRule: async () => rule };
}
const verdicts = async (p: Probe): Promise<Record<string, string>> => Object.fromEntries((await runGate(p)).map((r: Result) => [r.id, r.verdict]));

test('a Podium with every piece built passes every criterion and exits 0', async () => {
  const r = await runGate(podium());
  assert.deepEqual(r.map((x) => x.verdict), CHECKS.map(() => 'pass'));
  assert.equal(render(r).code, 0);
});

test('a bare main build reports each missing piece as not built, never crashes, and exits 1', async () => {
  const bare: Probe = { get: async (path) => (path === '/api/state' ? ok({ streams: ['Avonlea'], asks: [], done: [] }) : path === '/api/streams/Avonlea/home' ? ok({ links: [] }) : path === '/api/charts' ? ok({ throughput: [] }) : path === '/theme.css' ? ok('--font-sans: x;') : NONE), plainLanguageRule: async () => 'absent' };
  const r = await runGate(bare);
  assert.deepEqual(r.map((x) => x.verdict), ['not-built', 'not-built', 'not-built', 'not-built', 'not-built']);
  const { text, code } = render(r);
  assert.equal(code, 1);
  assert.match(text, /0 pass, 0 fail, 5 not built yet, of 5/);
});

test('a server that answers nothing fails the criteria with a reason instead of throwing', async () => {
  const dead: Probe = { get: async () => ({ status: 0, text: '' }), plainLanguageRule: async () => 'absent' };
  const v = await verdicts(dead);
  assert.deepEqual(v, { tokens: 'fail', home: 'fail', 'shared-docs': 'fail', handover: 'fail', 'plain-language': 'not-built' });
});

test('a check that throws is a failure and the rest still run', async () => {
  const p: Probe = { get: async () => { throw new Error('boom'); }, plainLanguageRule: async () => 'works' };
  const r = await runGate(p);
  assert.equal(r.length, CHECKS.length);
  assert.match(r[0]?.detail ?? '', /boom/);
  assert.equal(r.at(-1)?.verdict, 'pass');
});

test('tokens: a partial token set fails and names what is missing; a font off the origin fails', async () => {
  const old = await runGate(podium({ '/theme.css': ok('--font-sans: x;\n--font-mono: x;') }));
  assert.equal(old[0]?.verdict, 'not-built');
  const half = await runGate(podium({ '/theme.css': ok('--font-display: x;') }));
  assert.equal(half[0]?.verdict, 'fail');
  assert.match(half[0]?.detail ?? '', /--grid-columns/);
  const nofont = await runGate(podium({ '/fonts/geist.woff2': NONE }));
  assert.match(nofont[0]?.detail ?? '', /geist\.woff2/);
  const remote = await runGate(podium({ '/': ok('<link href="https://fonts.example.test/x.css">') }));
  assert.match(remote[0]?.detail ?? '', /off its own origin/);
});

test('home: a project with no status row, or no chart series, fails', async () => {
  assert.match((await runGate(podium({ '/api/projects': ok({ rows: [], links: [], weeks: [] }) })))[1]?.detail ?? '', /no status row for: Avonlea/);
  assert.equal((await verdicts(podium({ '/api/charts': ok({}) }))).home, 'fail');
  assert.equal((await verdicts(podium({ '/api/projects': ok({ rows: 1 }) }))).home, 'fail');
});

test('shared docs: an absolute path in an item fails', async () => {
  const v = await runGate(podium({}, 'works', { shared: [{ title: 'Spec', by: 'Anne', date: '2026-10-01', path: '/Users/x/spec.md' }] }));
  assert.equal(v[2]?.verdict, 'fail');
  assert.match(v[2]?.detail ?? '', /absolute path/);
});

test('handover: each unanswerable question is named, per project', async () => {
  const thin = tab({ run: [run('setup'), run('run')], docs: { decisions: { state: 'missing', fix: 'x' } }, overview: { state: 'ok', next: [] } });
  const r = await runGate(podium({}, 'works', { projects: [thin] }));
  assert.equal(r[3]?.verdict, 'fail');
  assert.match(r[3]?.detail ?? '', /avonlea-api: cannot answer 3 of 6 \(how do I run its tests; what was decided and where; what should I do next\)/);
  assert.match((await runGate(podium({}, 'works', { projects: [] })))[3]?.detail ?? '', /no project handover/);
});

test('plain-language: a rule that does not flag fails', async () => {
  assert.equal((await verdicts(podium({}, 'broken')))['plain-language'], 'fail');
});
