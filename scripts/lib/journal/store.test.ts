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
