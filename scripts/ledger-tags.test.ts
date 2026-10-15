// Run: node --test scripts/ledger-tags.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_TABLE, normaliseMark, normaliseUsed, tableModel } from './lib/ledger-tags.ts';
import { canonicalModel, fold } from './lib/ledger-core.ts';
import { openStore } from './lib/journal/store.ts';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('every spelling in the table folds to its canonical id, case-insensitively, and ids are unique', () => {
    const seen = new Map<string, string>();
    for (const [canon, { aliases }] of Object.entries(MODEL_TABLE)) {
        for (const spelling of [canon, ...aliases]) {
            assert.equal(tableModel(spelling), canon);
            assert.equal(tableModel(spelling.toUpperCase()), canon);
            assert.equal(seen.get(spelling.toLowerCase()) ?? canon, canon, `${spelling} is claimed by two ids`);
            seen.set(spelling.toLowerCase(), canon);
        }
    }
    assert.equal(tableModel('Sonnet 5.5'), 'claude-sonnet-5-5');
    assert.equal(tableModel('sonnet'), 'claude-sonnet-5-5');
    assert.equal(tableModel('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
    assert.equal(tableModel('Some Old Model'), null);
    assert.equal(tableModel(undefined), null);
});

test('the registry models section overrides the built-in table; the table is the floor', () => {
    const reg = { streams: {}, models: { 'house-model': { aliases: ['hm'] }, 'claude-opus-5-5': { aliases: ['top'] } } };
    assert.equal(canonicalModel(reg, 'HM'), 'house-model');
    assert.equal(canonicalModel(reg, 'top'), 'claude-opus-5-5');
    assert.equal(canonicalModel(reg, 'Opus 5.5'), 'claude-opus-5-5');
    assert.equal(canonicalModel(null, 'opus'), 'claude-opus-5-5');
    assert.equal(canonicalModel(null, 'mystery'), null);
});

test('tool marks lose script extensions, case and aliases; other marks are left alone', () => {
    assert.equal(normaliseMark('tool:journal.mjs'), 'tool:journal');
    assert.equal(normaliseMark('tool:journal.ts'), 'tool:journal');
    assert.equal(normaliseMark('tool:Bash'), 'tool:bash');
    assert.equal(normaliseMark('tool:db-snapshot.sh'), 'tool:db-snapshot');
    assert.equal(normaliseMark('tool:jira-mcp'), 'tool:atlassian-mcp');
    assert.equal(normaliseMark('tool:.ts'), 'tool:.ts');   // nothing left to name: not stripped
    assert.equal(normaliseMark('skill:the-maestro'), 'skill:the-maestro');
    assert.equal(normaliseMark('hook:precompact'), 'hook:precompact');
    assert.equal(normaliseMark('unrecorded'), 'unrecorded');
});

test('normaliseUsed dedupes a list, handles a bare string, and passes odd values through', () => {
    assert.deepEqual(normaliseUsed(['skill:x', 'tool:journal.mjs', 'tool:journal.ts', 'tool:Bash']), ['skill:x', 'tool:journal', 'tool:bash']);
    assert.equal(normaliseUsed('tool:journal.mjs'), 'tool:journal');
    assert.deepEqual(normaliseUsed([1, 'tool:x.py']), [1, 'tool:x']);
    assert.equal(normaliseUsed(undefined), undefined);
    assert.equal(normaliseUsed(7), 7);
});

test('fold normalises model and used on read, for items and closers, and never edits the rows', () => {
    const rows = [
        { id: 'aaaa', kind: 'wip', text: 'a', model: 'Claude Opus 5.5', used: ['tool:journal.mjs', 'skill:the-maestro'] },
        { id: 'bbbb', kind: 'done', closes: 'aaaa', text: 'a', model: 'sonnet-5.5', used: ['tool:journal.ts'] },
        { id: 'cccc', kind: 'wip', text: 'c', model: 'unrecorded', used: ['unrecorded'] },
        { id: 'dddd', kind: 'wip', text: 'd', model: 'Mystery 9' },
    ];
    const copy = JSON.stringify(rows);
    const { items } = fold(rows, null);
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    assert.deepEqual([byId.aaaa.model, byId.aaaa.used], ['claude-opus-5-5', ['tool:journal', 'skill:the-maestro']]);
    assert.deepEqual([byId.aaaa.closedBy?.model, byId.aaaa.closedBy?.used], ['claude-sonnet-5-5', ['tool:journal']]);
    assert.deepEqual([byId.cccc.model, byId.cccc.used], ['unrecorded', ['unrecorded']]);
    assert.equal(byId.dddd.model, 'Mystery 9');
    assert.equal(JSON.stringify(rows), copy);
});

test('a stamp row is normalised on read like any other mark', () => {
    const { items } = fold([
        { id: 'aaaa', kind: 'wip', text: 'a' },
        { id: 'bbbb', kind: 'stamp', annotates: 'aaaa', model: 'Haiku 5.5', used: ['tool:merge-sweep.ts'], text: 's' },
    ], null);
    assert.deepEqual([items[0].model, items[0].used], ['claude-haiku-5-5', ['tool:merge-sweep']]);
});

test('the store writes every row with canonical tool marks, whoever the writer is', () => {
    const vault = mkdtempSync(join(tmpdir(), 'tags-store-'));
    const store = openStore({ vault, project: 'p', dryRun: false });
    store.append({ id: 'aaaa', kind: 'note', used: ['tool:journal.mjs', 'tool:journal.ts'] });
    store.appendMany([{ id: 'bbbb', kind: 'note', used: ['tool:Bash'] }, { id: 'cccc', kind: 'note' }]);
    const rows = readFileSync(store.ledgerPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(rows.map((r) => r.used), [['tool:journal'], ['tool:bash'], undefined]);
});
