// Run: node --test scripts/lib/web/purity.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// A preload that makes file system and environment access throw when the caller is a loaded module (a file:// frame in the stack),
// while Node's own module loader, which also uses fs, still works. Importing the two modules must not read a file, stat a path or
// read an environment variable; calling them is covered by their own tests.
const GUARD = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const fromUserModule = () => (new Error().stack ?? '').split('\\n').some((l) => l.includes('file://') && !l.includes('guard.mjs'));
for (const name of ['readFileSync', 'writeFileSync', 'existsSync', 'statSync', 'lstatSync', 'realpathSync', 'readdirSync', 'openSync', 'mkdirSync']) {
  const real = fs[name];
  fs[name] = (...args) => { if (fromUserModule()) throw new Error(name + ' called at import'); return real(...args); };
}
syncBuiltinESMExports();
const realEnv = process.env;
process.env = new Proxy(realEnv, {
  get: (t, key) => { if (fromUserModule()) throw new Error('env.' + String(key) + ' read at import'); return Reflect.get(t, key); },
  has: (t, key) => { if (fromUserModule()) throw new Error('env probed at import'); return Reflect.has(t, key); },
});
`;

test('importing charts.ts and state.ts touches no file and no environment variable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'web-purity-'));
  writeFileSync(join(dir, 'guard.mjs'), GUARD);
  const urls = ['charts.ts', 'state.ts'].map((f) => pathToFileURL(join(import.meta.dirname, f)).href);
  writeFileSync(join(dir, 'entry.mjs'), `${urls.map((u) => `await import(${JSON.stringify(u)});`).join('\n')}\nconsole.log('imported');\n`);
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(join(dir, 'guard.mjs')).href, join(dir, 'entry.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /imported/);
});

test('the guard itself bites: a module that reads a file at import fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'web-purity-'));
  writeFileSync(join(dir, 'guard.mjs'), GUARD);
  writeFileSync(join(dir, 'bad.mjs'), "import { readFileSync } from 'node:fs';\nreadFileSync('/etc/hosts');\n");
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(join(dir, 'guard.mjs')).href, join(dir, 'bad.mjs')], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /readFileSync called at import/);
});
