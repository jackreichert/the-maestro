// Run: node --test scripts/memory-sort.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseOptions, readHints, sortDir } from './memory-sort.ts';

const SCRIPT = new URL('./memory-sort.ts', import.meta.url).pathname;
const mem = (name: string, type: string, d: string) => `---\nname: ${name}\ndescription: "${d}"\nmetadata:\n  type: ${type}\n---\nSECRET-BODY\n`;

function dir(): string {
    const d = mkdtempSync(join(tmpdir(), 'memsort-'));
    writeFileSync(join(d, 'MEMORY.md'), '- index\n');
    writeFileSync(join(d, 'branching.md'), mem('branching', 'project', 'the widget branches off develop'));
    writeFileSync(join(d, 'tone.md'), mem('tone', 'feedback', 'be kind'));
    return d;
}

test('parseOptions needs --memory-dir and rejects unknown flags', () => {
    assert.equal(typeof parseOptions([]), 'string');
    assert.equal(typeof parseOptions(['--x']), 'string');
    assert.deepEqual(parseOptions(['--memory-dir', 'd', '--json']), { memoryDir: 'd', hints: '', json: true });
    assert.deepEqual(parseOptions(['--memory-dir', 'd', '--hints', 'h.json']), { memoryDir: 'd', hints: 'h.json', json: false });
    assert.equal(typeof parseOptions(['--memory-dir', 'd', '--hints']), 'string');
});

test('sortDir skips the index and sorts by name', () => {
    assert.deepEqual(sortDir(dir(), [[/widget/i, 'widget-api']]).map((r) => [r.name, r.kind]), [['branching', 'project-fact'], ['tone', 'behaviour-rule']]);
});

test('the report is read-only and prints no body text', () => {
    const d = dir();
    const before = readdirSync(d).map((f) => readFileSync(join(d, f), 'utf8'));
    const hints = join(d, '..', `hints-${Date.now()}.json`);
    writeFileSync(hints, JSON.stringify([['widget', 'widget-api']]));
    const r = spawnSync(process.execPath, [SCRIPT, '--memory-dir', d, '--hints', hints], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /project-fact +branching +-> +Projects\/widget-api\/Knowledge\/branching\.md/);
    assert.match(r.stdout, /2 files: 1 project-fact, 1 behaviour-rule, 0 decision-or-status, 0 unsure\./);
    assert.ok(!r.stdout.includes('SECRET-BODY'));
    assert.deepEqual(readdirSync(d).map((f) => readFileSync(join(d, f), 'utf8')), before);
});

test('a missing directory exits 2', () => {
    assert.equal(spawnSync(process.execPath, [SCRIPT, '--memory-dir', '/nonexistent-dir-x'], { encoding: 'utf8' }).status, 2);
});

test('readHints takes regex/project pairs and refuses any other shape', () => {
    const d = mkdtempSync(join(tmpdir(), 'memhints-'));
    const write = (v: unknown) => { const f = join(d, 'h.json'); writeFileSync(f, JSON.stringify(v)); return f; };
    const [first] = readHints(write([['widget', 'widget-api']]));
    assert.deepEqual([first[0].test('A Widget'), first[1]], [true, 'widget-api']);
    assert.throws(() => readHints(write({ a: 1 })), /JSON array/);
    assert.throws(() => readHints(write([['only-one']])), /each hint/);
    assert.throws(() => readHints(write([['x', '']])), /each hint/);
});

test('a bad hints file exits 2 and writes nothing', () => {
    const d = dir();
    const bad = join(d, '..', `badhints-${Date.now()}.json`);
    writeFileSync(bad, '{"nope":1}');
    assert.equal(spawnSync(process.execPath, [SCRIPT, '--memory-dir', d, '--hints', bad], { encoding: 'utf8' }).status, 2);
});
