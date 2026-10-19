// Run: node --test scripts/superpowers-guardrails.test.ts
// Pins the guardrail text adapted from obra/superpowers so a later edit cannot silently drop it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

/** The first text fence under the standing-block heading of brief.md. */
function standingBlock(): string {
    const after = read('reference/brief.md').split(/^### Standing brief block.*$/m)[1] ?? '';
    return (after.match(/^```text\n([\s\S]*?)^```/m) ?? [])[1] ?? '';
}

test('definition-of-done.md has a claim-to-proof table covering tests, diffs and ready', () => {
    const md = read('reference/definition-of-done.md');
    assert.match(md, /^\| Claim \| Proof that counts \| Does not count \|$/m);
    for (const claim of ['"Tests pass"', '"I changed X"', '"PR is ready"']) assert.ok(md.includes(claim), claim);
});

test('the standing brief block carries the claims line and points at the table', () => {
    const block = standingBlock();
    assert.match(block, /^- Claims: /m);
    assert.match(block, /definition-of-done\.md/);
});

test('the brief has a Model field and the standing block bans unasked sub-agents and implicit models', () => {
    assert.match(read('reference/brief.md'), /^9\. \*\*Model\*\* /m);
    const block = standingBlock();
    assert.match(block, /^- Sub-agents: dispatch none unless this brief says so/m);
    assert.match(block, /the model named in this brief/);
    assert.match(block, /every call names a model explicitly/);
    assert.match(read('reference/brief.md'), /a line starting `Model:`/);
});

test('the cold read is defined in definition-of-done.md and is the closing step of grill.md', () => {
    const dod = read('reference/definition-of-done.md');
    assert.match(dod, /^### Cold read /m);
    assert.match(dod, /`--one-point`\) skips this/);
    const grill = read('reference/grill.md');
    assert.match(grill, /^## Closing step: cold read$/m);
    assert.ok(grill.includes('definition-of-done.md#cold-read-non-trivial-briefs-after-the-four-items'));
    assert.ok(dod.includes('### Cold read (non-trivial briefs, after the four items)'));
});

test('dispatch.md caps fix rounds at five and escalates rounds 4 and 5', () => {
    const md = read('reference/dispatch.md');
    const section = md.split(/^### Fix-round breaker$/m)[1]?.split(/^## /m)[0] ?? '';
    assert.match(section, /\| 4 and 5 \| A fresh agent/);
    assert.match(section, /\| After 5 \| Nobody/);
    assert.match(section, /Do not start a sixth round unasked/);
});
