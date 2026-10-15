// Run: node --test scripts/lib/journal/store.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './store.ts';

/** A ledger with one good row and one malformed line, and a streams.json that is not JSON. */
function damagedRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'store-warn-'));
    mkdirSync(join(root, 'Projects', 'p', 'Journal'), { recursive: true });
    writeFileSync(join(root, 'Projects', 'p', 'Journal', 'ledger.jsonl'), '{"id":"aaa1","kind":"wip","text":"x"}\nnot json\n');
    writeFileSync(join(root, 'Projects', 'p', 'streams.json'), '{ nope');
    return root;
}

test('store diagnostics go to the warn callback, not to stderr', () => {
    const warnings: string[] = [];
    const store = openStore({ vault: damagedRoot(), project: 'p', dryRun: false, warn: (m) => warnings.push(m) });
    assert.equal(store.readLedger().length, 1);
    assert.equal(store.loadRegistry(), null);
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /malformed line 2/);
    assert.match(warnings[1], /streams\.json is malformed/);
});

test('a store opened per call sees a streams.json edit that a long-lived one would not', () => {
    const root = mkdtempSync(join(tmpdir(), 'store-fresh-'));
    mkdirSync(join(root, 'Projects', 'p'), { recursive: true });
    const registry = join(root, 'Projects', 'p', 'streams.json');
    writeFileSync(registry, JSON.stringify({ streams: { alpha: { aliases: [], status: 'active' } } }));
    const long = openStore({ vault: root, project: 'p', dryRun: false });
    assert.ok(long.loadRegistry()?.streams.alpha);
    writeFileSync(registry, JSON.stringify({ streams: { beta: { aliases: [], status: 'active' } } }));
    assert.ok(long.loadRegistry()?.streams.alpha, 'the long-lived store caches the registry');
    assert.ok(openStore({ vault: root, project: 'p', dryRun: false }).loadRegistry()?.streams.beta, 'a fresh store reads the edit');
});

test('a dry-run line does not echo a secret-shaped value from the row', () => {
    const token = `ghp_${'a1B2c3D4e5F6g7H8i9J0'}${'k1L2m3N4o5P6'}`;
    const root = mkdtempSync(join(tmpdir(), 'store-dry-'));
    const store = openStore({ vault: root, project: 'p', dryRun: true });
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
    try { store.append({ id: 'aa01', kind: 'wip', text: `work in ${token}`, n: 2 }); store.appendMany([{ id: 'aa02', stream: token }]); } finally { console.log = log; }
    assert.equal(lines.length, 2);
    assert.ok(lines.every((l) => l.startsWith('[dry-run] ') && !l.includes(token)), lines.join('\n'));
    assert.deepEqual(JSON.parse(lines[0].slice('[dry-run] '.length)), { id: 'aa01', kind: 'wip', text: '[withheld: secret shape]', n: 2 });
});
