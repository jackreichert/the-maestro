// Run: node --test scripts/scratch.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { headerPurpose, propose, scratchRows, scratchReport } from './lib/scratch.ts';

const NOW = Date.UTC(2026, 5, 30);
const DAY = 86400000;

/** A shelf with scratch files; each is [name, text, idleDays]. */
function shelf(files) {
    const root = mkdtempSync(join(tmpdir(), 'scratch-'));
    mkdirSync(join(root, 'scratch'));
    for (const [name, text, idle] of files) {
        const p = join(root, 'scratch', name);
        writeFileSync(p, text);
        const t = new Date(NOW - idle * DAY);
        utimesSync(p, t, t);
    }
    return root;
}

test('headerPurpose reads the first comment line across comment styles, skipping a shebang', () => {
    assert.equal(headerPurpose('#!/usr/bin/env bash\n# count open rows\n# 2026-06-01 x-1\n'), 'count open rows');
    assert.equal(headerPurpose('// sum the totals\nconst a = 1;'), 'sum the totals');
    assert.equal(headerPurpose('-- list tables\nselect 1;'), 'list tables');
    assert.equal(headerPurpose('/* one-off */\nx'), 'one-off');
    assert.equal(headerPurpose('/**\n * sum the totals\n * 2026-06-01 x-1\n */\nx'), 'sum the totals');
    assert.equal(headerPurpose('/*\n   one-off\n*/\nx'), 'one-off');
    assert.equal(headerPurpose('echo no header\n'), '');
    assert.equal(headerPurpose(''), '');
});

test('scratchRows reads only the head of a large file', () => {
    const root = shelf([['big.sh', '# big purpose\n' + 'x'.repeat(5_000_000), 1]]);
    assert.equal(scratchRows(root, [], NOW)[0].purpose, 'big purpose');
});

test('propose: promote needs reuse and some age; delete needs more than 14 idle days; reuse beats staleness', () => {
    assert.equal(propose({ idleDays: 3, uses: 2 }), 'promote');
    assert.equal(propose({ idleDays: 2, uses: 5 }), 'keep');
    assert.equal(propose({ idleDays: 5, uses: 1 }), 'keep');
    assert.equal(propose({ idleDays: 14, uses: 0 }), 'keep');
    assert.equal(propose({ idleDays: 15, uses: 0 }), 'delete-candidate');
    assert.equal(propose({ idleDays: 40, uses: 1 }), 'delete-candidate');
    assert.equal(propose({ idleDays: 40, uses: 2 }), 'promote');
});

test('scratchRows counts ledger uses by file name, ignores dotfiles and directories, sorts oldest first', () => {
    const root = shelf([
        ['fresh.sh', '# fresh job\n', 0],
        ['reused.mjs', '// reused job\n', 6],
        ['stale.py', '# stale job\n', 30],
        ['.hidden', '# no\n', 99],
    ]);
    mkdirSync(join(root, 'scratch', 'sub'));
    const rows = scratchRows(root, ['ran reused.mjs for x', 'again reused.mjs', 'unrelated'], NOW);
    assert.deepEqual(rows.map((r) => [r.name, r.idleDays, r.uses, r.proposal]), [
        ['stale.py', 30, 0, 'delete-candidate'],
        ['reused.mjs', 6, 2, 'promote'],
        ['fresh.sh', 0, 0, 'keep'],
    ]);
    assert.equal(rows[1].purpose, 'reused job');
});

test('scratchReport proposes only: it never moves or deletes anything', () => {
    const root = shelf([['old.sh', 'echo hi\n', 40], ['new.sh', '# new\n', 1]]);
    const before = readdirSync(join(root, 'scratch')).sort();
    const out = scratchReport(root, [], NOW).join('\n');
    assert.match(out, /old\.sh \| 40 \| 0 \| \(no header\) \| delete-candidate/);
    assert.match(out, /new\.sh \| 1 \| 0 \| new \| keep/);
    assert.deepEqual(readdirSync(join(root, 'scratch')).sort(), before);
    assert.equal(readFileSync(join(root, 'scratch', 'old.sh'), 'utf8'), 'echo hi\n');
});

test('a shelf with no scratch folder or no files reports one line', () => {
    assert.match(scratchReport(mkdtempSync(join(tmpdir(), 'scratch-')), [], NOW)[0], /nothing in/);
    assert.match(scratchReport(shelf([]), [], NOW)[0], /nothing in/);
});
