// Run: node --test scripts/lib/journal/handoff.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fold } from '../ledger-core.ts';
import type { LedgerRow } from '../ledger-core.ts';
import { artifactsOf, cleanupWorktreeLines, handoffText, updateContextLink, yesterday } from './handoff.ts';
import type { HandoffContext } from './handoff.ts';

const D = '2026-10-03';
const rows: LedgerRow[] = [
    { id: 'aaaa', kind: 'wip', ts: `${D}T09:00:00Z`, date: D, text: 'build the widget, see src/widget.ts and PR #12', stream: 'Alpha', ticket: 'FAKE-3' },
    { id: 'bbbb', kind: 'blocked', ts: `${D}T09:01:00Z`, date: D, text: 'wait for review', stream: 'Alpha', gate: 'date:2099-01-01' },
    { id: 'cccc', kind: 'question', ts: `${D}T09:02:00Z`, date: D, text: 'which policy do we pick?', stream: 'Alpha' },
    { id: 'dddd', kind: 'wip', ts: `${D}T09:03:00Z`, date: D, text: 'learned that retries need a cap', stream: 'Alpha' },
    { id: 'eeee', kind: 'done', ts: `${D}T09:30:00Z`, date: D, text: 'closed', closes: 'dddd', stream: 'Alpha' },
    { id: 'ffff', kind: 'wip', ts: `${D}T09:04:00Z`, date: D, text: 'other stream work', stream: 'Beta' },
];
const ctx: HandoffContext = { fold: (entries) => fold(entries, null), readLedger: () => rows, today: () => D, claudeProjectsDir: mkdtempSync(join(tmpdir(), 'handoff-')) };

test('artifactsOf lists PRs, tickets, refs and paths once each', () => {
    const items = ctx.fold(rows).items.filter((i) => i.id === 'aaaa');
    assert.deepEqual(artifactsOf(items).map((a) => `${a.kind} ${a.v}`).sort(), ['path src/widget.ts', 'pr #12', 'ticket FAKE-3']);
});

test('handoffText scaffolds the five sections for one stream, with the stream filter and the author prompts', () => {
    const text = handoffText(ctx, 'Alpha', '2026-10-02', [], {});
    assert.match(text, /^---\nstatus: draft\nstream: Alpha\ngenerated: 2026-10-03\ngenerated_at: \d{4}-\d\d-\d\dT[\d:.]+Z\nsince: 2026-10-02\ntype: handoff\n---\n/);
    assert.match(text, /\*\*Session:\*\* unavailable \(no sessions in /);
    assert.match(text, /- `aaaa` \[in flight\] build the widget/);
    assert.match(text, /- `bbbb` \[blocked\] wait for review — gate: date:2099-01-01/);
    assert.match(text, /- `dddd` \[done 2026-10-03\] learned that retries need a cap/);
    assert.match(text, /\*\*Needs Jack\*\*\n\n- `cccc` \[question\]/);
    assert.match(text, /- PRs: #12\n- Tickets: FAKE-3\n- Paths: src\/widget\.ts/);
    assert.doesNotMatch(text, /other stream work/);
    assert.match(text, /## 5\. Next concrete action\n\n_Author: one concrete first step/);
    const all = handoffText(ctx, null, '2026-10-02', [], { learn: 'cap retries', next: 'ship it' });
    assert.match(all, /stream: all\n/);
    assert.match(all, /other stream work — stream: Beta/);
    assert.match(all, /## 2\. Learnings[^]*- cap retries/);
    assert.match(all, /## 5\. Next concrete action\n\nship it/);
});

test('handoffText falls back to the ts day for a missing date, and lists items with neither under Undated', () => {
    const old = '2026-09-01';
    const hand: LedgerRow[] = [
        { id: 't001', kind: 'wip', ts: `${old}T09:00:00Z`, text: 'old, no date field', stream: 'Alpha' },
        { id: 't002', kind: 'done', ts: `${D}T09:00:00Z`, text: 'recent, ts only', closes: 't001', stream: 'Alpha' },
        { id: 't003', kind: 'wip', ts: `${old}T09:00:00Z`, text: 'ancient ts only', stream: 'Alpha' },
        { id: 't004', kind: 'done', ts: `${old}T10:00:00Z`, text: 'ancient closer', closes: 't003', stream: 'Alpha' },
        { id: 't005', kind: 'wip', text: 'no date at all', stream: 'Alpha' },
        { id: 't006', kind: 'done', text: 'closer, no date at all', closes: 't005', stream: 'Alpha' },
    ];
    const text = handoffText({ ...ctx, readLedger: () => hand }, 'Alpha', '2026-10-02', [], {});
    assert.match(text, /- `t001` \[done 2026-10-03\] old, no date field/);
    assert.doesNotMatch(text, /ancient ts only/);
    assert.match(text, /### Undated\n\n[^\n]*\n\n- `t005` \[done, undated\] no date at all/);
    assert.doesNotMatch(text.split('### Undated')[0] ?? '', /t005/);
    assert.doesNotMatch(handoffText(ctx, 'Alpha', '2026-10-02', [], {}), /Undated/);
});

test('cleanupWorktreeLines lists kept worktrees, or summarises a sweep', () => {
    const kept = [{ path: '/w/a', repo: 'r', reason: 'uncommitted changes (2 files)' }];
    assert.deepEqual(cleanupWorktreeLines(kept, null), ['Worktrees the roll sweep keeps, because they hold work or are in use:', '', '- `/w/a` (r): uncommitted changes (2 files)', '']);
    assert.deepEqual(cleanupWorktreeLines([], null), []);
    const summary = cleanupWorktreeLines(kept, { removed: [], pruned: [], kept, notes: [], skipped: [], envAsks: [] });
    assert.match(summary[0] ?? '', /^Worktree sweep \(dry run\): 0 would be removed, 0 pruned, 1 kept\./);
    assert.ok(summary.includes('- uncommitted changes: 1'));
});

test('updateContextLink adds one Latest handoff line under the first heading, replaces it, and is idempotent', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'context-')), 'CONTEXT.md');
    writeFileSync(file, '---\ntype: context\n---\n# Project\n\nBody.\n');
    updateContextLink(ctx, file, '/x/HANDOFF-2026-10-03-Alpha.md');
    assert.equal(readFileSync(file, 'utf8'), '---\ntype: context\n---\n# Project\n\nLatest handoff: [[HANDOFF-2026-10-03-Alpha]] (2026-10-03)\n\nBody.\n');
    updateContextLink(ctx, file, '/x/HANDOFF-2026-10-03-Alpha.md');
    updateContextLink({ today: () => '2026-10-04' }, file, '/x/HANDOFF-2026-10-04-all.md');
    assert.match(readFileSync(file, 'utf8'), /Latest handoff: \[\[HANDOFF-2026-10-04-all\]\] \(2026-10-04\)\n/);
    assert.equal((readFileSync(file, 'utf8').match(/Latest handoff/g) || []).length, 1);
    assert.match(yesterday(), /^\d{4}-\d{2}-\d{2}$/);
});
