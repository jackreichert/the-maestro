// Run: node --test scripts/lib/journal/store.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LedgerScanError, openStore } from './store.ts';

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

test('a row with a secret-shaped value is refused, dry run or not, and the refusal does not echo the value', () => {
    const token = `ghp_${'a1B2c3D4e5F6g7H8i9J0'}${'k1L2m3N4o5P6'}`;
    for (const dryRun of [true, false]) {
        const root = mkdtempSync(join(tmpdir(), 'store-refuse-'));
        const store = openStore({ vault: root, project: 'p', dryRun });
        const lines: string[] = [];
        const log = console.log;
        console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
        try {
            for (const write of [() => store.append({ id: 'aa01', kind: 'wip', text: `work in ${token}`, n: 2 }), () => store.appendMany([{ id: 'aa02', text: 'fine' }, { id: 'aa03', stream: token }])]) {
                assert.throws(write, (e: Error) => e instanceof LedgerScanError && /github-token/.test(e.message) && !e.message.includes(token));
            }
        } finally { console.log = log; }
        assert.deepEqual(lines, [], 'nothing was printed or written, not even the clean row of the batch');
        assert.deepEqual(store.readLedger(), []);
    }
});

test('machine fields are not scanned: a sha256, a page hash and ids pass', () => {
    const store = openStore({ vault: mkdtempSync(join(tmpdir(), 'store-machine-')), project: 'p', dryRun: false });
    assert.doesNotThrow(() => store.append({ id: 'aa01', kind: 'curated', text: 'page', pageSha: 'a'.repeat(40), sha256: 'b'.repeat(64) }));
});
