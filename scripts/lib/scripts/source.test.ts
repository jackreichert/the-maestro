// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/lib/scripts/source.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deniedName, markersOf, pathsIn, readSource, sourcesOf, MAX_SOURCE_BYTES } from './source.ts';
import { dataRoutes } from '../web/server.ts';
import { openStore } from '../journal/store.ts';
import { registerScript } from './register.ts';

const base = mkdtempSync(join(tmpdir(), 'script-source-'));
after(() => rmSync(base, { recursive: true, force: true }));
const root = join(base, 'scripts');
const outside = join(base, 'elsewhere');
mkdirSync(join(root, 'scratch'), { recursive: true });
mkdirSync(outside);
const put = (p: string, text: string): string => { writeFileSync(p, text); return p; };

const ANNOTATED = ['#!/bin/bash', '# GATE: dry run unless --apply', 'if [ "$1" != --apply ]; then echo dry; exit 0; fi', '# MUTATES: staging queue - deletes one row', 'echo delete', ''].join('\n');

test('a script under the root is shown with its line, MUTATES and GATE counts and modified time', () => {
  const f = readSource(put(join(root, 'scratch', 'ok.sh'), ANNOTATED), [root]);
  assert.equal(f.hidden, undefined);
  assert.equal(f.text, ANNOTATED);
  assert.deepEqual([f.lines, f.mutates, f.gates, f.warn], [5, 1, 1, false]);
  assert.deepEqual(f.marks, { 2: 'gate', 4: 'mutates' });
  assert.match(f.modified ?? '', /^\d{4}-\d\d-\d\dT/);
});

test('MUTATES with no GATE anywhere raises the warning; no markers at all does not', () => {
  const warn = readSource(put(join(root, 'warn.sh'), '# MUTATES: x\n-- MUTATES: y\n'), [root]);
  assert.deepEqual([warn.mutates, warn.gates, warn.warn], [2, 0, true]);
  const plain = readSource(put(join(root, 'plain.sh'), 'echo hi\n'), [root]);
  assert.deepEqual([plain.mutates, plain.gates, plain.warn], [0, 0, false]);
});

test('a line with both markers counts once, as MUTATES', () => {
  assert.deepEqual(markersOf('x # MUTATES: a GATE: b\n'), { marks: { 1: 'mutates' }, mutates: 1, gates: 0 });
});

test('a missing file inside the root says so', () => {
  const f = readSource(join(root, 'nope.sh'), [root]);
  assert.equal(f.hidden, 'missing');
  assert.equal(f.text, undefined);
});

test('a path outside the roots is refused without being read, and a .. is refused', () => {
  const o = put(join(outside, 'x.sh'), 'echo hi\n');
  assert.equal(readSource(o, [root]).hidden, 'outside the script roots');
  assert.equal(readSource(`${root}/../elsewhere/x.sh`, [root]).hidden, 'path contains ..');
  assert.equal(readSource(`${root}/scratch/../ok.sh`, [root]).hidden, 'path contains ..');
  assert.equal(readSource('relative/x.sh', [root]).hidden, 'not an absolute path');
  assert.equal(readSource(join(outside, 'missing.sh'), [root]).hidden, 'outside the script roots', 'the answer must not reveal whether an outside file exists');
});

test('a symlink that leads outside the root is refused; one that stays inside is shown', () => {
  const target = put(join(outside, 'secret-ish.sh'), 'echo hi\n');
  symlinkSync(target, join(root, 'link-out.sh'));
  assert.match(readSource(join(root, 'link-out.sh'), [root]).hidden ?? '', /outside the script roots/);
  put(join(root, 'plain.sh'), 'echo hi\n');
  symlinkSync(join(root, 'plain.sh'), join(root, 'link-in.sh'));
  assert.equal(readSource(join(root, 'link-in.sh'), [root]).text, 'echo hi\n');
});

test('a root that is itself reached through a symlink still works', () => {
  const via = join(base, 'via');
  symlinkSync(root, via);
  put(join(root, 'plain.sh'), 'echo hi\n');
  assert.equal(readSource(join(via, 'plain.sh'), [via]).text, 'echo hi\n');
});

test('secret-bearing file names are never shown, by name or after a link is resolved', () => {
  for (const name of ['.env', '.env.local', '.env.production', 'ssm-prod.json', 'a.tfvars', 'a.tfstate', 'a.tfstate.backup', 'k.pem', 'id.key', 'ID.KEY']) {
    assert.ok(deniedName(name), name);
    const f = readSource(put(join(root, name), 'FOO=bar\n'), [root]);
    assert.equal(f.hidden, 'hidden: secret-bearing file name', name);
    assert.equal(f.text, undefined);
  }
  for (const name of ['env.sh', 'keys.sh', 'tfvars.md', 'run.sh']) assert.equal(deniedName(name), false, name);
  symlinkSync(join(root, '.env'), join(root, 'innocent.sh'));
  assert.equal(readSource(join(root, 'innocent.sh'), [root]).hidden, 'hidden: secret-bearing file name');
});

test('a file that looks like it holds a secret is hidden whole, with counts but no body or marks', () => {
  const key = ['AK', 'IA', 'ABCDEFGHIJKLMNOP'].join('');
  const f = readSource(put(join(root, 'leaky.sh'), `# MUTATES: x\nexport AWS_ACCESS_KEY_ID=${key}\npassword=hunter2hunter2\n`), [root]);
  assert.equal(f.hidden, 'hidden: possible secret');
  assert.equal(f.text, undefined);
  assert.deepEqual(f.marks, {});
  assert.equal(f.mutates, 1);
  const pem = readSource(put(join(root, 'pem.sh'), `cat <<X\n-----BEGIN ${'RSA '}PRIVATE KEY-----\nX\n`), [root]);
  assert.equal(pem.hidden, 'hidden: possible secret');
});

test('a script that merely names a variable is not mistaken for a secret', () => {
  const f = readSource(put(join(root, 'vars.sh'), 'psql "$STAGING_DB_URL" -f "$SQL"\nTOKEN="$STAGING_TOKEN"\n'), [root]);
  assert.equal(f.hidden, undefined);
});

test('a file over the size cap is not read', () => {
  const f = readSource(put(join(root, 'big.sh'), '# x\n'.repeat(MAX_SOURCE_BYTES / 4 + 1)), [root]);
  assert.match(f.hidden ?? '', /too large/);
  assert.equal(f.text, undefined);
  assert.doesNotMatch(readSource(put(join(root, 'edge.sh'), '# x\n'.repeat(MAX_SOURCE_BYTES / 4)), [root]).hidden ?? '', /too large/, 'exactly the cap is read');
});

test('a binary file and a directory are not shown', () => {
  writeFileSync(join(root, 'bin.sh'), Buffer.from([0x23, 0, 1, 2]));
  assert.equal(readSource(join(root, 'bin.sh'), [root]).hidden, 'binary file');
  mkdirSync(join(root, 'dir.sh'));
  assert.equal(readSource(join(root, 'dir.sh'), [root]).hidden, 'not a regular file');
});

test('pathsIn finds a command\'s script, a sourced sibling and a -f sql file, expanding the folder forms', () => {
  assert.deepEqual(pathsIn('/bin/zsh /a/b/run.sh --apply', null), ['/a/b/run.sh']);
  assert.deepEqual(pathsIn('node "/a/x.ts" arg', null), ['/a/x.ts']);
  const text = '. "$(dirname "$0")/lib.sh"\nsource ${SCRIPT_DIR}/two.sh\npsql -f "$HERE/q.sql"\nSQL="${BASH_SOURCE[0]%/*}/r.sql"\nsource three.sh\n';
  assert.deepEqual(pathsIn(text, '/s').sort(), ['/s/lib.sh', '/s/q.sql', '/s/r.sql', '/s/three.sh', '/s/two.sh']);
  assert.deepEqual(pathsIn('. "$(dirname "$0")/lib.sh"', null), [], 'no folder known: nothing is guessed');
  assert.deepEqual(pathsIn('echo hi; ls /usr/bin/env', null), []);
});

test('sourcesOf shows the script then its includes, one level only, each checked on its own', () => {
  const d = join(root, 'chain');
  mkdirSync(d);
  put(join(d, 'main.sh'), '. "$(dirname "$0")/lib.sh"\npsql -f "$(dirname "$0")/q.sql"\n. "$(dirname "$0")/gone.sh"\n');
  put(join(d, 'lib.sh'), '. "$(dirname "$0")/deeper.sh"\n# GATE: g\n');
  put(join(d, 'deeper.sh'), 'echo never listed\n');
  put(join(d, 'q.sql'), '-- MUTATES: one row\nDELETE FROM t WHERE false;\n');
  const files = sourcesOf(`/bin/bash ${join(d, 'main.sh')} --apply`, [root]);
  assert.deepEqual(files.map((f) => [f.path.replace(`${d}/`, ''), f.role, f.hidden ?? 'shown']), [
    ['main.sh', 'script', 'shown'], ['lib.sh', 'include', 'shown'], ['q.sql', 'include', 'shown'], ['gone.sh', 'include', 'missing'],
  ]);
  assert.equal(files[2]?.mutates, 1);
  assert.equal(files[2]?.warn, true);
});

test('an include that points outside the roots is listed as refused and never opened', () => {
  const d = join(root, 'leak');
  mkdirSync(d);
  put(join(outside, 'private.sh'), 'echo hi\n');
  put(join(d, 'main.sh'), `. ${join(outside, 'private.sh')}\n`);
  const files = sourcesOf(join(d, 'main.sh'), [root]);
  assert.equal(files[1]?.hidden, 'outside the script roots');
  assert.equal(files[1]?.text, undefined);
});

test('the route answers for a registered script by id and for nothing else', () => {
  const vault = join(base, 'vault');
  mkdirSync(join(vault, 'Projects', 'p', 'Journal'), { recursive: true });
  const store = openStore({ vault, project: 'p', dryRun: false, warn: () => {} });
  const script = put(join(root, 'registered.sh'), ANNOTATED);
  const out = registerScript({ store, vault, project: 'p', now: new Date('2026-10-18T12:00:00Z'), today: '2026-10-18', askExtras: {}, script: { kind: 'one-time', title: 'T', what: 'w', why: 'y', after: 'a', blocks: 'abcd', command: `/bin/bash ${script} --apply` } });
  assert.ok(out.ok);
  const id = out.ok ? out.entry.id : '';
  const page = { streams: [], repoStreams: {}, vaultName: '', trackerUrlBase: '', ticketNotePath: '', trackerKeyPattern: 'X-\\d+', tz: 'UTC' };
  const routes = dataRoutes({ web: { vault, project: 'p', statusDir: join(vault, 'Status'), page, scriptRoots: [root] }, clientDir: base });
  const call = (path: string): any => { const u = new URL(`http://x${path}`); const r = routes.find((x) => x.pattern.test(u.pathname)); return r?.handler(u, u.pathname.match(r.pattern) as RegExpMatchArray); };
  const got = call(`/api/scripts/${id}/source`);
  assert.equal(got.files.length, 1);
  assert.equal(got.files[0].text, ANNOTATED);
  assert.equal(call('/api/scripts/sc-00000000/source'), undefined);
  assert.equal(call('/api/scripts/..%2F..%2Fetc%2Fpasswd/source'), undefined);
  assert.equal(call(`/api/scripts/${id}/source?path=/etc/passwd`).files.length, 1, 'a path in the query is ignored');
});
