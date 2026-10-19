// Run: node --test scripts/superpowers-guardrails.test.ts
// Pins the guardrail text adapted from obra/superpowers so a later edit cannot silently drop it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

test('dispatch.md caps fix rounds at five and escalates rounds 4 and 5', () => {
    const md = read('reference/dispatch.md');
    const section = md.split(/^### Fix-round breaker$/m)[1]?.split(/^## /m)[0] ?? '';
    assert.match(section, /\| 4 and 5 \| A fresh agent/);
    assert.match(section, /\| After 5 \| Nobody/);
    assert.match(section, /Do not start a sixth round unasked/);
});
