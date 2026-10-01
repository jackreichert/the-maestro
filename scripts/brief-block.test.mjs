// Run: node --test scripts/brief-block.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';

// Hermetic: never read the user's config file (see local-config.mjs). The import comes after this
// line because local-config.mjs reads its files when it is first loaded.
process.env.MAESTRO_LOCAL_CONFIG = '';
const { extractBlock, parseSlotValues, fillBlock, SLOTS } = await import('./brief-block.mjs');

const SCRIPT = new URL('./brief-block.mjs', import.meta.url).pathname;
const BRIEF = new URL('../reference/brief.md', import.meta.url).pathname;
const VALUES = [
    '## Standing brief block, filled',
    '',
    '- `<user git emails>` → `dev@example.com (or dev2@example.org)`',
    '- `<tracker key example>` → FAKE-1',
    '',
].join('\n');

/** Runs the CLI with one throwaway config file as the only config source. */
function run(configText) {
    const dir = mkdtempSync(join(tmpdir(), 'bb-'));
    const file = join(dir, 'config.md');
    writeFileSync(file, configText);
    const env = { PATH: process.env.PATH, HOME: dir, MAESTRO_LOCAL_CONFIG: file };
    return spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env });
}

test('the shipped block has exactly the documented slots', () => {
    const block = extractBlock(readFileSync(BRIEF, 'utf8'));
    assert.match(block, /^Standing rules \(hard limits\):/);
    for (const slot of SLOTS) assert.ok(block.includes(slot), slot);
});

test('parseSlotValues reads bullets, strips wrapping backticks, stops at the next heading', () => {
    const v = parseSlotValues(`${VALUES}\n## Other\n- \`<x>\` → nope\n`);
    assert.deepEqual(v, { '<user git emails>': 'dev@example.com (or dev2@example.org)', '<tracker key example>': 'FAKE-1' });
});

test('fillBlock flags a slot with no value and keeps the block own <base>, <check> wording', () => {
    const block = extractBlock(readFileSync(BRIEF, 'utf8'));
    assert.deepEqual(fillBlock(block, {}).problems, ['<user git emails>', '<tracker key example>']);
    assert.deepEqual(fillBlock(block, { '<user git emails>': 'a@b.c', '<tracker key example>': 'K-1' }).problems, []);
    assert.deepEqual(fillBlock(block, { '<user git emails>': '<your email>', '<tracker key example>': 'K-1' }).problems, ['<your email>']);
});

test('CLI prints the block with both slots filled and exits 0', () => {
    const r = run(VALUES);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /every author is dev@example\.com \(or dev2@example\.org\)\./);
    assert.match(r.stdout, /cap retry count FAKE-1`/);
    assert.ok(!r.stdout.includes('<user git emails>') && !r.stdout.includes('<tracker key example>'));
    assert.ok(r.stdout.includes('<base>'), 'the block own <base> wording is untouched');
});

test('CLI exits 1, with nothing on stdout, when a slot is left unfilled', () => {
    const r = run(VALUES.replace(/^- `<tracker key example>`.*$/m, ''));
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /unfilled <tracker key example>/);
});

test('CLI exits 1 when no config holds any value', () => {
    const r = run('# nothing here\n');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /<user git emails>, <tracker key example>/);
});

test('the shipped block tells workers to run the PR size gate before opening a PR', () => {
    const block = extractBlock(readFileSync(BRIEF, 'utf8'));
    assert.match(block, /Open every PR with `node <maestro scripts dir>\/pr-open\.mjs --repo \. --base <base> --title "\.\.\." --body-file BODY\.md`, never a bare `gh pr create`/);
    assert.match(block, /If it refuses, stop and report a split plan instead of opening\./);
    assert.ok(fillBlock(block, { '<user git emails>': 'a@b.c', '<tracker key example>': 'K-1' }).problems.length === 0, 'the new line adds no unfilled slot');
});

test('the filled block names an absolute, existing path to pr-open.mjs, and no <skill> placeholder', () => {
    const r = run(VALUES);
    assert.equal(r.status, 0, r.stderr);
    const m = r.stdout.match(/`node (\/[^ `]+\/pr-open\.mjs) --repo/);
    assert.ok(m, 'an absolute path precedes pr-open.mjs');
    assert.ok(existsSync(m[1]), m[1]);
    assert.ok(isAbsolute(m[1]));
    assert.doesNotMatch(r.stdout, /<skill>|<maestro scripts dir>/);
});
