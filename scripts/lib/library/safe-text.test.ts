// Run: node --test scripts/lib/library/safe-text.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { neutralise, safeLine, WITHHELD } from './safe-text.ts';

// Shapes are assembled at run time so this file holds no literal token.
const BODY36 = 'abcdefghijklmnopqrstuvwxyz0123456789';
const GH = ['gh', 'p_'].join('');
const AWS = ['AK', 'IA'].join('');
const SK = ['s', 'k-'].join('');
const CLEAN = (s: string): boolean => !s.includes('<!--') && !s.includes('-->');

const SECRET_BYPASSES: [string, string][] = [
    ['a comment inside a GitHub token', `${GH}<!---->${BODY36}`],
    ['a comment inside an AWS key', `${AWS}<!---->ABCDEFGHIJKLMNOP`],
    ['a comment inside an sk- key', `${SK}<!---->${BODY36}`],
    ['nested comments inside a token', `${GH}<!<!---->-->${BODY36}`],
    ['a comment that rebuilds from its own pieces inside a token', `${GH}<!<!---->--${BODY36}`],
    ['a zero-width space inside a token', `${GH}​${BODY36}`],
    ['a BOM and a soft hyphen inside a token', `${GH}﻿${BODY36.slice(0, 10)}­${BODY36.slice(10)}`],
    ['a control character inside a token', `${GH}\u0001${BODY36}`],
    ['a zero-width character inside a comment delimiter inside a token', `${GH}<!​--${BODY36}`],
];

for (const [name, raw] of SECRET_BYPASSES) {
    test(`${name} is withheld, not emitted as a clean token`, () => {
        assert.equal(safeLine(raw, 140), WITHHELD);
    });
}

const MARKER_REBUILDS: [string, string][] = [
    ['pieces that rebuild an opener', 'a <!<!---->-- b'],
    ['pieces that rebuild a closer', 'a --<!---->> b'],
    ['deeply nested pieces', '<!<!<!<!---->---->---->--'],
    ['a delimiter split by a zero-width space', 'x <!​-- y -​-> z'],
    ['a delimiter split by a control character', 'x <!\u0000-- y'],
    ['the end marker spelled through pieces', 'orchard <!<!---->-- library-index:end --<!---->> tail'],
];

for (const [name, raw] of MARKER_REBUILDS) {
    test(`${name} leaves no comment delimiter, and normalising again changes nothing`, () => {
        const once = safeLine(raw, 140);
        assert.ok(CLEAN(once), once);
        assert.ok(CLEAN(neutralise(raw)));
        assert.equal(neutralise(neutralise(raw)), neutralise(raw));
    });
}

test('ordinary text keeps its words, an arrow keeps its meaning, and long text is clipped', () => {
    assert.equal(safeLine('step A --> step B', 140), 'step A → step B');
    assert.equal(safeLine('  two   words\n', 140), 'two words');
    assert.equal(safeLine('x'.repeat(200), 20), `${'x'.repeat(19)}…`);
    assert.equal(safeLine('', 20), '');
});

test('text too long to scan is withheld', () => {
    assert.equal(safeLine('word '.repeat(1000), 140), WITHHELD);
});
