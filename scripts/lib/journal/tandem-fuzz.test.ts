// Run: node --test scripts/lib/journal/tandem-fuzz.test.ts
// Two to four processes, each a "window", write handoffs and ledger rows into one scratch root at the same time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WORKER = new URL('./tandem-fuzz-worker.ts', import.meta.url).pathname;
const HANDOFFS = 6;   // 4 windows x 6 stays inside the b..z suffix series (26 names)
const ROWS = 40;

interface Done { window: string; created: string[] }

function runWorker(vault: string, window: string, startAt: number): Promise<Done> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [WORKER, vault, window, String(startAt), String(HANDOFFS), String(ROWS)], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        child.on('close', (code) => (code === 0 ? resolve(JSON.parse(out) as Done) : reject(new Error(`worker ${window} exited ${code}: ${err}`))));
    });
}

for (const windows of [2, 3, 4]) {
    test(`${windows} windows writing handoffs and ledger rows at once lose no row and overwrite no handoff`, async () => {
        const vault = mkdtempSync(join(tmpdir(), 'tandem-fuzz-'));
        const startAt = Date.now() + 1500;
        const names = Array.from({ length: windows }, (_, i) => `w${i}`);
        const done = await Promise.all(names.map((w) => runWorker(vault, w, startAt)));
        const dir = join(vault, 'Projects', 'fuzz', 'Journal');

        // Every handoff each window created exists, holds that window's own text, and no two windows share a name.
        const all = done.flatMap((d) => d.created);
        assert.equal(new Set(all).size, windows * HANDOFFS, 'every write got its own name');
        assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith('HANDOFF-')).sort(), [...all].sort(), 'no file is missing, none extra, no temp left behind');
        for (const d of done) {
            d.created.forEach((name, i) => assert.equal(readFileSync(join(dir, name), 'utf8'), `from ${d.window} #${i}\n`, `${name} still holds what ${d.window} wrote`));
        }
        assert.ok(!readdirSync(dir).some((f) => f.endsWith('.tmp')), 'no temp file is left');

        // Every ledger row is there once, whole, and names the window that wrote it.
        const rows = readFileSync(join(dir, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { id: string; window: string });
        assert.equal(rows.length, windows * ROWS);
        assert.equal(new Set(rows.map((r) => r.id)).size, windows * ROWS);
        for (const r of rows) assert.equal(r.id.split('-')[0], r.window);
    });
}
