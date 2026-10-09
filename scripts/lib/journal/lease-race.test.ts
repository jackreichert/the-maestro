// Run: node --test scripts/lib/journal/lease-race.test.ts
// Real processes racing for the same leases: every item ends with exactly one winner, and the ledger agrees with what each process was told.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './store.ts';
import { foldLeases } from './leases.ts';

const WORKER = new URL('./lease-race-worker.ts', import.meta.url).pathname;
const ITEMS = 25;
const STEAL_ITEMS = 4;   // wide slots (400 ms) so every stealer reads before any steal lands

function runWorker(vault: string, window: string, startAt: number, items = ITEMS, mode?: string): Promise<{ window: string; won: string[] }> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [WORKER, vault, window, String(startAt), String(items), ...(mode ? [mode] : [])], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        child.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`worker ${window} exited ${code}: ${err}`))));
    });
}

for (const windows of [2, 4, 6]) {
    test(`${windows} processes racing for ${ITEMS} items: each item has exactly one winner, and it is the holder the ledger folds to`, async () => {
        const vault = mkdtempSync(join(tmpdir(), 'lease-race-'));
        const startAt = Date.now() + 1500;   // each item then has its own 40 ms slot after this
        const names = Array.from({ length: windows }, (_, i) => `w${i}`);
        const results = await Promise.all(names.map((w) => runWorker(vault, w, startAt)));
        const held = foldLeases(openStore({ vault, project: 'race', dryRun: false }).readLedger());
        for (let i = 0; i < ITEMS; i++) {
            const winners = results.filter((r) => r.won.includes(`it${i}`)).map((r) => r.window);
            assert.equal(winners.length, 1, `it${i} was reported won by ${winners.join(', ') || 'nobody'}`);
            assert.equal(held.get(`it${i}`)?.holder, winners[0], `the ledger names the process that was told it won it${i}`);
        }
    });
}

/** Put a live lease held by window `h` on every item, so the racers have something to steal. */
function seedHolder(vault: string): void {
    const store = openStore({ vault, project: 'race', dryRun: false, window: 'h' });
    store.ensureDir();
    for (let i = 0; i < STEAL_ITEMS; i++) {
        const ts = new Date().toISOString();
        store.append({ ts, date: ts.slice(0, 10), kind: 'lease', leases: `it${i}`, window: 'h', ttl: 30, text: `lease it${i}` });
    }
}

for (const windows of [2, 4, 6]) {
    for (let round = 1; round <= 3; round++) {
        test(`${windows} processes stealing ${STEAL_ITEMS} held items (round ${round}): each item has exactly one winner, and it is the holder the ledger folds to`, async () => {
            const vault = mkdtempSync(join(tmpdir(), 'lease-steal-'));
            seedHolder(vault);
            const startAt = Date.now() + 3000;
            const names = Array.from({ length: windows }, (_, i) => `s${i}`);
            const results = await Promise.all(names.map((w) => runWorker(vault, w, startAt, STEAL_ITEMS, 'steal')));
            const held = foldLeases(openStore({ vault, project: 'race', dryRun: false }).readLedger());
            for (let i = 0; i < STEAL_ITEMS; i++) {
                const winners = results.filter((r) => r.won.includes(`it${i}`)).map((r) => r.window);
                assert.equal(winners.length, 1, `it${i} was reported stolen by ${winners.join(', ') || 'nobody'}`);
                assert.equal(held.get(`it${i}`)?.holder, winners[0], `the ledger names the process that was told it won it${i}`);
            }
        });
    }
}
