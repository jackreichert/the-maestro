// Run: node --test scripts/review-harvest.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stubEnv, writeStub } from './lib/stub-bin.ts';
import { renderBatch } from './review-harvest.ts';
import type { Finding, Triage } from './lib/review-harvest.ts';

const SCRIPT = new URL('./review-harvest.ts', import.meta.url).pathname;
const PLAYBOOK = new URL('../playbooks/review-miss-harvest.md', import.meta.url);

const thread = (id: string, path: string, body: string, who = 'copilot-pull-request-reviewer', resolved = true) =>
  ({ isResolved: resolved, path, comments: { nodes: [{ id, body, author: { login: who } }] } });
const prNode = (author: string, branch: string, threads: object[]) => ({
  author: { login: author }, headRefName: branch, files: { nodes: [{ path: 'src/gate.mjs' }] },
  reviewThreads: { nodes: threads }, reviews: { nodes: [] }, comments: { nodes: [] },
});

/** A fake gh: `-F number=N` picks the PR; a `search(` query lists the merged ones. */
function fakeGh(prs: Record<string, object>, merged: string[]): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'rh-gh-'));
  const body = `#!${process.execPath}
const args = process.argv.slice(2);
const q = args.find((a) => a.startsWith('query=')) || '';
if (q.includes('search(')) { console.log(JSON.stringify({ data: { search: { pageInfo: { hasNextPage: false }, nodes: ${JSON.stringify(merged.map((m) => ({ number: Number(m.split('#')[1]), repository: { nameWithOwner: m.split('#')[0] } })))} } } })); process.exit(0); }
const n = (args.find((a) => a.startsWith('number=')) || '').slice(7);
const prs = ${JSON.stringify(prs)};
if (!prs[n]) { console.error('no such pr ' + n); process.exit(1); }
console.log(JSON.stringify({ data: { repository: { pullRequest: prs[n] } } }));
`;
  return stubEnv('MAESTRO_GH_BIN', writeStub(join(dir, 'gh.cjs'), body));
}

function run(env: Record<string, string>, args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, MAESTRO_LOCAL_CONFIG: '', ...env } });
}

const TWIN = 'Empty allowlist is read as unrestricted, so a blank list grants every entity.';

test('harvest reads Jack PRs only, collapses the twin, and a second run adds nothing', () => {
  const store = mkdtempSync(join(tmpdir(), 'rh-store-'));
  const env = fakeGh({
    '10': prNode('jack', 'feat/gate', [thread('a1', 'src/gate.mjs', TWIN), thread('a2', 'src/gate.mjs', 'The core helper already exists, reuse it.', 'samwise', false)]),
    '11': prNode('jack', 'feat/gate', [thread('b1', 'src/gate.mjs', TWIN)]),
    '12': prNode('frodo', 'feat/shire', [thread('c1', 'src/gate.mjs', 'Unrelated.')]),
  }, ['rivendell/elrond-api#10', 'rivendell/elrond-api#11']);
  const first = run(env, ['harvest', 'rivendell/elrond-api#10', 'rivendell/elrond-api#11', 'rivendell/elrond-api#12', '--jack', 'jack', '--store', store, '--json']);
  assert.equal(first.status, 0, first.stderr);
  const out = JSON.parse(first.stdout);
  assert.equal(out.total, 2);
  assert.deepEqual(out.skipped, ['rivendell/elrond-api#12']);
  const second = JSON.parse(run(env, ['harvest', 'rivendell/elrond-api#10', 'rivendell/elrond-api#11', '--jack', 'jack', '--store', store, '--json']).stdout);
  assert.equal(second.added, 0);
  assert.equal(second.total, 2);
  const pending = JSON.parse(run(env, ['pending', '--store', store, '--skills', join(store, 'none'), '--json']).stdout) as { threads: number; hints: string[]; prs: string[] }[];
  assert.equal(pending.find((f) => f.threads === 2)?.prs.length, 2);
  assert.ok(pending.some((f) => f.hints.includes('planning')));
});

test('--since finds merged PRs by search; an unreadable PR is reported and exits 2', () => {
  const store = mkdtempSync(join(tmpdir(), 'rh-store-'));
  const env = fakeGh({ '10': prNode('jack', 'feat/gate', [thread('a1', 'src/gate.mjs', TWIN)]) }, ['rivendell/elrond-api#10', 'rivendell/elrond-api#99']);
  const r = run(env, ['harvest', '--since', '2026-10-10', '--jack', 'jack', '--store', store]);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /1 new findings/);
  assert.match(r.stdout, /elrond-api#99: /);
});

test('bad usage exits 2: no jack, a bad ref, a bad date, an unknown triage id', () => {
  const store = mkdtempSync(join(tmpdir(), 'rh-store-'));
  assert.equal(run({}, ['harvest', 'rivendell/elrond-api#1', '--store', store]).status, 2);
  assert.equal(run({}, ['harvest', 'not-a-ref', '--jack', 'jack', '--store', store]).status, 2);
  assert.equal(run({}, ['harvest', '--since', 'yesterday', '--jack', 'jack', '--store', store]).status, 2);
  assert.equal(run({}, ['triage', 'nope', '--class', 'mithril', '--real', 'yes', '--store', store]).status, 2);
});

test('triage then batch --write puts planning misses in their own section and never overwrites', () => {
  const store = mkdtempSync(join(tmpdir(), 'rh-store-'));
  const out = mkdtempSync(join(tmpdir(), 'rh-out-'));
  const env = fakeGh({ '10': prNode('jack', 'feat/gate', [thread('a1', 'src/gate.mjs', TWIN), thread('a2', 'src/util.mjs', 'The core helper already exists, reuse it.', 'samwise', false), thread('a3', 'src/old.mjs', 'ESLint would flag this unused import.')]) }, []);
  run(env, ['harvest', 'rivendell/elrond-api#10', '--jack', 'jack', '--store', store]);
  const ids = (JSON.parse(run(env, ['pending', '--store', store, '--skills', join(store, 'none'), '--json']).stdout) as { id: string; gist: string }[]);
  const id = (re: RegExp) => ids.find((f) => re.test(f.gist))!.id;
  const t = (...a: string[]) => assert.equal(run({}, ['triage', ...a, '--store', store]).status, 0);
  t(id(/Empty allowlist/), '--class', 'mithril', '--real', 'yes', '--fate', 'fixed', '--coverage', 'partial', '--skill', 'code-quality', '--cite', 'CC2-8', '--category', 'Fail-open on empty input', '--candidate', 'Keep absent and empty distinct');
  t(id(/core helper/), '--class', 'planning', '--real', 'yes', '--candidate', 'core has a shared helper');
  t(id(/ESLint/), '--class', 'dropped', '--real', 'no', '--why', 'CI catches it');
  const today = new Date().toISOString().slice(0, 10);
  const w = run({}, ['batch', '--out', out, '--store', store, '--write', '--until', today]);
  assert.equal(w.status, 0, w.stderr);
  const note = readFileSync(join(out, readdirSync(out)[0]!), 'utf8');
  assert.match(note, /## Planning misses \(route to the planning checklist/);
  assert.match(note, /\| Q1 \|.*core helper/);
  assert.match(note, /- \*\*Mithril misses:\*\* 1 real/);
  assert.match(note, /- \*\*Dropped:\*\* 1/);
  assert.match(note, /\| 1 \| `code-quality` \| Keep absent and empty distinct \| CC2-8 \| 1 findings, 1 changes \| watching \|/);
  assert.doesNotMatch(note, /Q1.*Empty allowlist/);
  assert.equal(readdirSync(out).length, 1);
});

test('batch --write refuses while a finding is untriaged', () => {
  const store = mkdtempSync(join(tmpdir(), 'rh-store-'));
  const out = mkdtempSync(join(tmpdir(), 'rh-out-'));
  const env = fakeGh({ '10': prNode('jack', 'feat/gate', [thread('a1', 'src/gate.mjs', TWIN)]) }, []);
  run(env, ['harvest', 'rivendell/elrond-api#10', '--jack', 'jack', '--store', store]);
  const r = run({}, ['batch', '--out', out, '--store', store, '--write']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /1 findings are not triaged/);
  assert.equal(readdirSync(out).length, 0);
});

test('renderBatch: an unsourced candidate is blocked, and untriaged findings make the note a draft', () => {
  const f = (id: string): Finding => ({ id, seen: '2026-10-16', kind: 'human', path: 'a.mjs', gist: `gist ${id}`, prs: ['r/a#1'], changes: ['r/a:x'], threads: 1, srcIds: [id], fate: 'open', hints: [] });
  const tri = new Map<string, Triage>([['one', { id: 'one', klass: 'mithril', fate: 'open', real: true, skill: 'flow', candidate: 'Name the sink', category: 'Sinks' }]]);
  const note = renderBatch([f('one'), f('two')], tri, { since: '2026-10-10', until: '2026-10-16' }, 2);
  assert.match(note, /blocked: unsourced/);
  assert.match(note, /Not yet triaged:\*\* 1/);
});

test('the playbook names every subcommand and the hard rules', () => {
  assert.ok(existsSync(PLAYBOOK));
  const text = readFileSync(PLAYBOOK, 'utf8');
  for (const s of ['review-harvest.ts harvest', 'review-harvest.ts pending', 'review-harvest.ts triage', 'review-harvest.ts batch']) assert.ok(text.includes(s), s);
  assert.match(text, /never edit a mithril skill/i);
  assert.match(text, /planning/i);
});
