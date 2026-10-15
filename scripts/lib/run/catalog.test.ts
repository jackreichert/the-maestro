import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { buildArgs, buildArgv, displayArgv, loadCatalog, parseCatalog } from './catalog.ts';
import type { ArgSpec, Entry } from './catalog.ts';

const CTX = { node: '/usr/bin/node', home: '/srv/fake', ledger: '/led', vault: '/vault', project: 'proj' };
const entry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ id: 'a-b', name: 'A', description: 'd', group: 'g', command: ['{node}', 'scripts/x.ts'], args: [], readOnly: true, tier: 'haiku', timeoutSeconds: 30, ...over });
const problems = (e: Record<string, unknown>): string[] => parseCatalog({ scripts: [e] }).problems;

test('the shipped catalog loads clean, is all read-only, and every command starts at node', () => {
  const c = loadCatalog(fileURLToPath(new URL('../../../podium/scripts.json', import.meta.url)));
  assert.deepEqual(c.problems, []);
  assert.ok(c.entries.length >= 3);
  assert.ok(c.entries.every((e) => e.readOnly && e.command[0] === '{node}'));
  for (const e of c.entries) { const b = buildArgv(e, {}, CTX); assert.ok(b.ok, e.id); }
});

test('an entry that does not validate is dropped with a reason, not run', () => {
  assert.deepEqual(problems(entry()), []);
  assert.match(problems(entry({ id: 'Bad Id' }))[0]!, /bad id/);
  assert.match(problems(entry({ command: ['sh', '-c', 'x'] }))[0]!, /must be \{node\} or an absolute path/);
  assert.match(problems(entry({ command: ['{node}', 'cat', '.env'] }))[0]!, /secret file/);
  assert.match(problems(entry({ readOnly: 'yes' }))[0]!, /readOnly/);
  assert.match(problems(entry({ tier: 'gpt' }))[0]!, /tier/);
  assert.match(problems(entry({ timeoutSeconds: 99999 }))[0]!, /timeoutSeconds/);
  assert.match(problems(entry({ args: [{ name: 'q', type: 'string' }] }))[0]!, /needs a pattern/);
  assert.match(problems(entry({ args: [{ name: 'q', type: 'string', pattern: '[a-z]+' }] }))[0]!, /anchored/);
  assert.match(problems(entry({ args: [{ name: 'q', type: 'boolean' }] }))[0]!, /needs a flag/);
  assert.match(problems(entry({ args: [{ name: 'q', type: 'integer' }] }))[0]!, /min and max/);
  assert.equal(parseCatalog({ scripts: [entry(), entry()] }).entries.length, 1);
  assert.equal(parseCatalog({}).entries.length, 0);
  assert.equal(loadCatalog('/no/such/file.json').entries.length, 0);
});

const SPEC: ArgSpec[] = [
  { name: 'who', type: 'string', flag: '--who', pattern: '^[a-z0-9-]{1,10}$' },
  { name: 'pos', type: 'string', pattern: '^[a-z0-9-]{1,10}$' },
  { name: 'kind', type: 'enum', flag: '--kind', values: ['a', 'b'], default: 'a' },
  { name: 'n', type: 'integer', flag: '--n', min: 1, max: 10 },
  { name: 'all', type: 'boolean', flag: '--all' },
  { name: 'must', type: 'string', flag: '--must', pattern: '^x$', required: true },
];
const args = (given: unknown) => buildArgs(SPEC, given);

test('valid args become separate argv elements, with defaults applied', () => {
  assert.deepEqual(args({ must: 'x', who: 'bob', pos: 'p1', n: 3, all: true }), { ok: true, argv: ['--who', 'bob', 'p1', '--kind', 'a', '--n', '3', '--all', '--must', 'x'] });
  assert.deepEqual(args({ must: 'x', all: false }), { ok: true, argv: ['--kind', 'a', '--must', 'x'] });
});

test('injection attempts are refused, never expanded', () => {
  for (const bad of [
    { must: 'x', who: '$(id)' }, { must: 'x', who: 'a;b' }, { must: 'x', who: 'a b' }, { must: 'x', who: 'a\nb' }, { must: 'x', who: '`id`' },
    { must: 'x', who: '../x' }, { must: 'x', who: 'a'.repeat(11) }, { must: 'x', who: '' }, { must: 'x', who: 5 }, { must: 'x', pos: '-rf' },
    { must: 'x', kind: 'c' }, { must: 'x', n: 0 }, { must: 'x', n: 11 }, { must: 'x', n: 1.5 }, { must: 'x', n: '3' }, { must: 'x', all: 'yes' },
    { must: 'x', extra: 'y' }, { must: 'x', ['__proto__']: 'y' }, {}, { must: 'y' },
  ]) {
    assert.equal(args(bad).ok, false, JSON.stringify(bad));
  }
  assert.equal(args([] as unknown).ok, false);
  assert.equal(args('x').ok, false);
});

test('placeholders come from the server settings only; an arg value that looks like one stays literal', () => {
  const e = parseCatalog({ scripts: [entry({ command: ['{node}', '{home}/s.mjs', '--vault', '{vault}'], args: [{ name: 'q', type: 'string', flag: '--q', pattern: '^[{}a-z]+$' }] })] }).entries[0] as Entry;
  const b = buildArgv(e, { q: '{home}' }, CTX);
  assert.deepEqual(b, { ok: true, argv: ['/usr/bin/node', '/srv/fake/s.mjs', '--vault', '/vault', '--q', '{home}'] });
});

test('the display line quotes anything beyond plain words', () => {
  assert.equal(displayArgv(['/bin/echo', 'a b', "it's", '--x=1']), "/bin/echo 'a b' 'it'\\''s' --x=1");
});
