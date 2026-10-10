// Run: node --test scripts/lib/journal/retro.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fold, mapStreamWith } from '../ledger-core.ts';
import type { LedgerRow } from '../ledger-core.ts';
import { parseArgs } from './args.ts';
import { LEARNING, archiveBlockers, findRetro, retroStatus, retroText, unfilledPromotions } from './retro.ts';
import type { RetroContext } from './retro.ts';

const D = '2026-10-03';
const rows: LedgerRow[] = [
    { id: 'aaaa', kind: 'wip', ts: `${D}T09:00:00Z`, date: D, text: 'ship the widget, PR #12', stream: 'Alpha', ticket: 'FAKE-7' },
    { id: 'bbbb', kind: 'done', ts: `${D}T10:00:00Z`, date: D, text: 'widget shipped', closes: 'aaaa' },
    { id: 'cccc', kind: 'wip', ts: `${D}T09:30:00Z`, date: D, text: 'learned that retries need a cap', stream: 'Alpha' },
    { id: 'dddd', kind: 'fact', ts: `${D}T09:40:00Z`, date: D, text: 'f', stream: 'Alpha', key: 'latency', value: '40ms' },
];

function ctxFor(argv: string[] = ['retro'], over: Partial<RetroContext> = {}): RetroContext {
    const retros = mkdtempSync(join(tmpdir(), 'retro-'));
    return {
        vault: '/nowhere', project: 'smoke', ticketsBase: () => '/nowhere', retroDir: () => retros,
        readLedger: () => rows, fold: (entries) => fold(entries, null), mapStream: (s) => mapStreamWith(null, s), today: () => D,
        arg: parseArgs(argv).arg, ticketStatuses: (ids) => new Map(ids.map((id) => [id, { id, status: 'open', title: `Title of ${id}` }])),
        ...over,
    };
}

test('retroText summarises the stream, lists shipped work, facts, referenced tickets and learnings', () => {
    const text = retroText(ctxFor(), 'Alpha');
    assert.match(text, /^---\nstatus: draft\nstream: Alpha\ngenerated: 2026-10-03\ntype: retro\n---\n/);
    assert.match(text, /- Items done: 1\n- Items dropped: 0\n- Items open: 1\n/);
    assert.match(text, /\| latency \| 40ms \| 2026-10-03 \|/);
    assert.match(text, /## Shipped\n\n- `aaaa` ship the widget, PR #12 — widget shipped \(#12\)/);
    assert.match(text, /\| FAKE-7 \| open \| Title of FAKE-7 \|/);
    assert.match(text, /## Learnings\n\n- `cccc` learned that retries need a cap/);
    assert.match(text, /- \[ \] learned that retries need a cap \(`cccc`\) — Promoted to: /);
    assert.match(retroText(ctxFor(['retro'], { ticketStatuses: () => null }), 'Alpha'), /\| FAKE-7 \| index unavailable \| \|/);
});

test('a sentence that only says cause is not a learning, and a lesson still is', () => {
    const causeOnly = 'The delay had one cause and nothing else.';
    const lesson = 'One lesson: cap the retries.';
    assert.equal(LEARNING.test(causeOnly), false);
    assert.equal(LEARNING.test(lesson), true);
    const text = retroText(ctxFor(['retro'], {
        readLedger: () => [
            { id: 'c001', kind: 'note', ts: `${D}T09:00:00Z`, date: D, text: causeOnly, stream: 'Alpha' },
            { id: 'l001', kind: 'note', ts: `${D}T09:01:00Z`, date: D, text: lesson, stream: 'Alpha' },
        ],
    }), 'Alpha');
    const learnings = text.split('## Learnings\n\n')[1]?.split('\n## ')[0] ?? '';
    assert.equal(learnings.includes(causeOnly), false);
    assert.match(learnings, /`l001` One lesson: cap the retries\./);
});

test('retroStatus and unfilledPromotions read the front matter and the Promoted to checklist', () => {
    assert.equal(retroStatus('---\nstatus: reviewed\n---\nbody'), 'reviewed');
    assert.equal(retroStatus('no front matter'), 'draft');
    const text = '## Promoted to\n\n- [ ] one — Promoted to: DECISIONS.md\n- [ ] two — Promoted to: \n- [x] three — Promoted to:   \n\n## Next\n- [ ] ignored\n';
    assert.deepEqual(unfilledPromotions(text), ['- [ ] two — Promoted to: ', '- [x] three — Promoted to:   ']);
    assert.deepEqual(unfilledPromotions('nothing here'), []);
});

test('findRetro and archiveBlockers find the newest retro and list what still blocks an archive', () => {
    const ctx = ctxFor();
    assert.equal(findRetro(ctx, 'Alpha'), null);
    const none = archiveBlockers(ctx, 'Alpha', fold(rows, null).items);
    assert.equal(none.retro, null);
    assert.match(none.blockers.join('\n'), /open item cccc \[wip\]/);
    assert.match(none.blockers.join('\n'), /no retro doc found in /);
    const older = join(ctx.retroDir(), 'Alpha-retro-2026-10-01.md');
    const newest = join(ctx.retroDir(), 'Alpha-retro-2026-10-03.md');
    writeFileSync(older, '---\nstatus: reviewed\n---\n');
    writeFileSync(newest, '---\nstatus: draft\n---\n## Promoted to\n\n- [ ] x — Promoted to: \n');
    assert.equal(findRetro(ctx, 'Alpha'), newest);
    const blockers = archiveBlockers(ctx, 'Alpha', fold(rows, null).items).blockers.join('\n');
    assert.match(blockers, /still has status: draft/);
    assert.match(blockers, /1 "Promoted to" line\(s\)/);
    const explicit = ctxFor(['archive', '--retro', older]);
    assert.equal(findRetro(explicit, 'Alpha'), older);
});
