// Run: node --test scripts/rule-audit.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./rule-audit.ts', import.meta.url));

function run(args: string[]) {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
    return { code: result.status, out: result.stdout, err: result.stderr };
}

function tempDir(): string {
    return mkdtempSync(join(tmpdir(), 'rule-audit-'));
}

function section(out: string, title: string): string {
    const start = out.indexOf(`${title}:\n`);
    assert.notEqual(start, -1, out);
    const rest = out.slice(start + title.length + 2);
    const next = rest.search(/^(?:missing enforced-by|promotion candidates|prune candidates|deleted):/m);
    return next === -1 ? rest : rest.slice(0, next);
}

test('a missing directory argument exits 2 and prints no report', () => {
    const result = run([]);
    assert.equal(result.code, 2);
    assert.equal(result.out, '');
    assert.match(result.err, /directory argument is missing/);
});

test('lists a file missing enforced-by and omits a file with a valid field', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'bare.md'), '# Bare rule\nNo field on this page.\n');
    writeFileSync(join(dir, 'invalid.md'), 'enforced-by: maybe\n');
    writeFileSync(join(dir, 'hooked.md'), '---\nenforced-by: hook\n---\n# Hooked\n');
    writeFileSync(join(dir, 'scripted.md'), 'enforced-by: script: scripts/rule-audit.ts\n');
    writeFileSync(join(dir, 'convention.md'), 'enforced-by: convention\n');
    const result = run([dir, '--now', '2026-10-08']);
    assert.equal(result.code, 0, result.err);
    const missing = section(result.out, 'missing enforced-by');
    assert.match(missing, /bare\.md/);
    assert.match(missing, /invalid\.md/);
    assert.doesNotMatch(missing, /hooked\.md/);
    assert.doesNotMatch(missing, /scripted\.md/);
    assert.doesNotMatch(missing, /convention\.md/);
    assert.equal(existsSync(join(dir, 'bare.md')), true);
    assert.equal(existsSync(join(dir, 'hooked.md')), true);
});

test('a convention-only rule cited within 30 days is a promotion candidate', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'repeat.md'), 'enforced-by: convention\n');
    writeFileSync(join(dir, 'edge.md'), 'enforced-by: convention\n');
    writeFileSync(join(dir, 'stale-cite.md'), 'enforced-by: convention\n');
    writeFileSync(join(dir, 'hooked.md'), 'enforced-by: hook\n');
    const records = join(dir, 'records.json');
    writeFileSync(records, JSON.stringify([
        { path: 'repeat.md', cited: '2026-09-20', lastReference: '2026-09-20' },
        { path: 'edge.md', cited: '2026-09-08', 'last-reference': '2026-09-08' },
        { path: 'stale-cite.md', cited: '2026-09-07', lastReference: '2026-09-07' },
        { path: 'hooked.md', cited: '2026-10-01', lastReference: '2026-10-01' },
    ]));
    const result = run([dir, '--records', records, '--now', '2026-10-08']);
    assert.equal(result.code, 0, result.err);
    const promotion = section(result.out, 'promotion candidates');
    assert.match(promotion, /repeat\.md/);
    assert.match(promotion, /edge\.md/);
    assert.doesNotMatch(promotion, /stale-cite\.md/);
    assert.doesNotMatch(promotion, /hooked\.md/);
    assert.doesNotMatch(section(result.out, 'missing enforced-by'), /repeat\.md/);
});

test('a rule with no reference in 60 days is a prune candidate, and an unlisted file is not', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'stale.md'), 'enforced-by: hook\n');
    writeFileSync(join(dir, 'just-out.md'), 'enforced-by: convention\n');
    writeFileSync(join(dir, 'fresh.md'), 'enforced-by: convention\n');
    writeFileSync(join(dir, 'never.md'), 'enforced-by: convention\n');
    writeFileSync(join(dir, 'unlisted.md'), 'enforced-by: hook\n');
    const records = join(dir, 'records.json');
    writeFileSync(records, JSON.stringify([
        { path: 'stale.md', lastReference: '2026-07-01' },
        { path: 'just-out.md', lastReference: '2026-08-08' },
        { path: 'fresh.md', lastReference: '2026-08-09' },
        { path: 'never.md' },
    ]));
    const result = run([dir, '--records', records, '--now', '2026-10-08']);
    assert.equal(result.code, 0, result.err);
    const prune = section(result.out, 'prune candidates');
    assert.match(prune, /stale\.md/);
    assert.match(prune, /just-out\.md/);
    assert.match(prune, /never\.md/);
    assert.doesNotMatch(prune, /fresh\.md/);
    assert.doesNotMatch(prune, /unlisted\.md/);
});

test('refuses to delete and leaves the temp files in place', () => {
    const dir = tempDir();
    const keep = join(dir, 'keep.md');
    writeFileSync(keep, 'enforced-by: convention\n');
    const records = join(dir, 'records.json');
    writeFileSync(records, JSON.stringify([{ path: 'keep.md', cited: '2026-10-01', lastReference: '2026-01-01' }]));
    const result = run([dir, '--records', records, '--now', '2026-10-08', '--delete']);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /deleted: none/);
    assert.match(result.out, /refused to delete/);
    assert.equal(existsSync(keep), true);
    assert.equal(existsSync(records), true);
    assert.equal(readFileSync(keep, 'utf8'), 'enforced-by: convention\n');
    const src = readFileSync(SCRIPT, 'utf8');
    assert.doesNotMatch(src, /\b(unlink|rmSync|rmdir|writeFile|appendFile|truncate|rename|copyFile)\b/);
});
