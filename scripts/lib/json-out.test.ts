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

const SINK = /(?:console\.(?:log|info)|process\.stdout\.write|writeSync(?=\(\s*(?:1|process\.stdout\.fd)\s*,))\s*\(/g;
const STRINGIFIED_VAR = /(?:\b(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=(?!=)[^;\n]*?JSON\.stringify\(/g;   // a declaration or assignment whose right side holds the call, so `out = JSON.stringify(x) + '\\n'` counts; a comparison after the call does not (see COMPARES)
const COMPARES = /[!=]==?|[<>]=?/;   // `const a = JSON.stringify(x) !== y` is a boolean, not a string

/** The text between a call's parentheses, which may span lines; strings are skipped so a paren inside one does not end the call early. */
function callArgs(src: string, open: number): string {
  let depth = 0;
  let quote = '';
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(') depth += 1;
    else if (c === ')' && (depth -= 1) === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

/** True when a print call, on one line or several, receives JSON.stringify output directly or through a variable the same file filled from it. A wrapper helper in between is not followed. */
function printsStringified(src: string): boolean {
  const held = [...src.matchAll(STRINGIFIED_VAR)].filter((m) => {
    const rest = src.slice(m.index + m[0].length + callArgs(src, m.index + m[0].length - 1).length + 1);
    return !COMPARES.test(rest.split(/;|\r?\n/)[0]);
  }).map((m) => m[1]);
  return [...src.matchAll(SINK)].some((m) => {
    const args = callArgs(src, m.index + m[0].length - 1);
    return /JSON\.stringify\(/.test(args) || held.some((v) => new RegExp(`(?<![\\w$.])${v.replace(/\$/g, '\\$')}(?![\\w$])`).test(args));
  });
}

test('the guard flags each way a file can print JSON.stringify output itself', () => {
  const caught: Record<string, string> = {
    'same line': 'console.log(JSON.stringify(x));',
    'multi-line console.log': 'console.log(\n  JSON.stringify(x, null, 2),\n);',
    'stringify held in a variable, printed later': 'const out = JSON.stringify(x, null, 2);\nconst n = 1;\nconsole.log(out);',
    'stringify plus a newline held in a variable': "const line = JSON.stringify(row) + '\\n';\nprocess.stdout.write(line);",
    'template literal around stringify': "const t = `${JSON.stringify(x)}`;\nconsole.log(t);",
    'wrapped in String()': "const s = String(JSON.stringify(x));\nconsole.log(s);",
    'assigned after declaration': "let u;\nu = JSON.stringify(x);\nconsole.log(u);",
    'typed variable': 'const out: string = JSON.stringify(x);\nprocess.stdout.write(out + "\\n");',
    'dry-run line (stored values can reach it)': "console.log('[dry-run]', JSON.stringify(x));",
    'writeSync(1, ...)': "writeSync(1, JSON.stringify(x));",
    'writeSync(process.stdout.fd, ...)': "writeSync(process.stdout.fd, JSON.stringify(x));",
    'multi-line writeSync': "writeSync(\n  1,\n  JSON.stringify(x),\n);",
    'ternary': "console.log(json ? JSON.stringify(x) : 'plain');",
  };
  for (const [shape, src] of Object.entries(caught)) assert.ok(printsStringified(src), `guard misses: ${shape}`);
});

test('the guard leaves alone code that stringifies without printing it', () => {
  const quiet: Record<string, string> = {
    'stringify written to a file': "writeFileSync(path, JSON.stringify(x));",
    'stringified variable never printed': "const out = JSON.stringify(x);\nwriteFileSync(p, out);\nconsole.log('saved');",
    'a longer name that contains the variable': "const out = JSON.stringify(x);\nconsole.log(outline);",
    'a paren inside a string does not end the call': "console.log(')');\nconst a = JSON.stringify(x);",
    'writeSync to a file descriptor that is not stdout': 'writeSync(fd, JSON.stringify(row));',
    'stringify used in a comparison, not printed': "const changed = JSON.stringify(a) !== JSON.stringify(b);\nconsole.log(changed);",
    'printJson itself': 'printJson(x);',
  };
  for (const [shape, src] of Object.entries(quiet)) assert.ok(!printsStringified(src), `guard flags: ${shape}`);
});

test('known gap: a wrapper helper that prints for the caller is not followed', () => {
  // the file defines show() around console.log and passes it the stringified value; a source scan cannot see through that, so review has to
  assert.equal(printsStringified("const show = (s: string): void => console.log(s);\nshow(JSON.stringify(x));"), false);
});

test('no script prints JSON.stringify output directly: --json output goes through printJson', () => {
  const offenders = sources(SCRIPTS).map((f) => relative(SCRIPTS, f)).filter((f) => !NOT_PRODUCERS.has(f)).filter((f) => printsStringified(readFileSync(join(SCRIPTS, f), 'utf8')));
  assert.deepEqual(offenders, [], 'print JSON through printJson (lib/json-out.ts) so secret-shaped values are withheld');
});
