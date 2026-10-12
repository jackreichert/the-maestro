import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dryRunJson, withholdJson } from './json-out.ts';
import { WITHHELD } from './withhold.ts';

const token = `ghp_${'a1B2c3D4e5F6g7H8i9J0'}${'k1L2m3N4o5P6'}`;

test('withholdJson redacts secret-shaped values and keys in place and leaves the rest alone', () => {
  const out = withholdJson({ stream: token, n: 3, ok: true, none: null, list: ['fine', token], nested: { [token]: 'x', day: new Date(0) } });
  assert.deepEqual(out, { stream: WITHHELD, n: 3, ok: true, none: null, list: ['fine', WITHHELD], nested: { [WITHHELD]: 'x', day: '1970-01-01T00:00:00.000Z' } });
  assert.ok(!JSON.stringify(out).includes(token));
});

test('two secret-shaped keys stay two keys', () => {
  const out = withholdJson({ [token]: 1, [`${token}x`]: 2 }) as Record<string, number>;
  assert.equal(Object.keys(out).length, 2);
});

test('keys named like Object.prototype members pass through unchanged', () => {
  const input = JSON.parse('{"model":{"x":3,"toString":1,"constructor":2,"hasOwnProperty":4,"__proto__":5}}') as unknown;
  const out = withholdJson(input) as { model: Record<string, number> };
  assert.deepEqual(Object.keys(out.model), ['x', 'toString', 'constructor', 'hasOwnProperty', '__proto__']);
  assert.equal(JSON.stringify(out), JSON.stringify(input));
  assert.ok(!JSON.stringify(out).includes(WITHHELD));
  assert.equal(Object.getPrototypeOf(out.model), Object.prototype, 'callers get an ordinary object');
});

const splitToken = (sep: string): string => `${token.slice(0, 10)}${sep}${token.slice(10)}`;

test('withholdJson catches a token split by a zero-width character or a space, in a value, a key and mid-string', () => {
  for (const sep of ['\u200b', ' ']) {
    const split = splitToken(sep);
    const out = withholdJson({ stream: split, [split]: 'x', list: [`id ${split} end`] });
    assert.deepEqual(out, { stream: WITHHELD, [WITHHELD]: 'x', list: [WITHHELD] });
    assert.ok(!JSON.stringify(out).includes('ghp_'));
  }
});

test('withholdJson reads a key and its string value together, as the text path does', () => {
  const fake = 'fake_pw_123abc';   // not secret-shaped alone; the key is what makes it one
  assert.deepEqual(withholdJson({ PassWord: fake, note: fake }), { PassWord: WITHHELD, note: fake });
  assert.deepEqual(withholdJson({ nested: [{ api_key: fake }] }), { nested: [{ api_key: WITHHELD }] });
  assert.deepEqual(withholdJson({ tokens: 12, token_count: 'many', password: '<redacted>' }), { tokens: 12, token_count: 'many', password: '<redacted>' });
});

test('withholdJson lets status words under secret-sounding keys through, and still withholds real pairs', () => {
  const words = { tokens: 'unmeasured', token: 'refreshed', credentials: 'missing_file', secrets: 'scanned', access_token: 'present', ['pass' + 'word']: 'unchanged' };   // placeholder status words
  assert.deepEqual(withholdJson(words), words);
  const fake = 'fake_pw_123abc';   // placeholder fixture, not a secret
  assert.deepEqual(withholdJson({ PassWord: fake, api_key: fake }), { PassWord: WITHHELD, api_key: WITHHELD });
});

test('dryRunJson is one line of JSON with secret-shaped values withheld', () => {
  const line = dryRunJson({ text: `in ${token}`, n: 1 });
  assert.equal(line, `{"text":"${WITHHELD}","n":1}`);
});

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOT_PRODUCERS = new Set(['lib/json-out.ts', 'lib/gh-stub.ts', 'journal.cases.ts']);   // the helper itself; two fake gh binaries (test input, not producers)

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name.startsWith('.')) return [];
    const path = join(dir, e.name);
    return e.isDirectory() ? sources(path) : /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [path] : [];
  });
}

test('no script prints JSON.stringify output directly: --json output goes through printJson', () => {
  // any print call with JSON.stringify on the same line, so a `json ? JSON.stringify(x) : text` ternary is caught; a `[dry-run]` line echoes what the caller just typed
  const direct = /(?:console\.(?:log|info)|process\.stdout\.write)\(.*JSON\.stringify\(/;
  const offenders = sources(SCRIPTS).map((f) => relative(SCRIPTS, f)).filter((f) => !NOT_PRODUCERS.has(f)).filter((f) => readFileSync(join(SCRIPTS, f), 'utf8').split('\n').some((l) => direct.test(l) && !l.includes("'[dry-run]'")));
  assert.deepEqual(offenders, [], 'print JSON through printJson (lib/json-out.ts) so secret-shaped values are withheld');
});
