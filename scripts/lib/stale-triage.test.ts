// Run: node --test scripts/lib/stale-triage.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fold } from './ledger-core.ts';
import type { LedgerRow } from './ledger-core.ts';
import { prRefsIn, renderEvidence, staleEvidence, ticketStatus } from './stale-triage.ts';

const row = (id: string, date: string, o: Partial<LedgerRow> = {}): LedgerRow => ({ id, kind: 'wip', ts: `${date}T09:00:00Z`, date, text: id, ...o });
const evidence = (rows: LedgerRow[], today = '2026-10-12', vault?: string) => staleEvidence(rows, fold(rows, null).items, today, vault);

function ticketsVault(): string {
    const v = mkdtempSync(join(tmpdir(), 'stale-tickets-'));
    mkdirSync(join(v, 'Projects', 'widgets', 'Tickets'), { recursive: true });
    writeFileSync(join(v, 'Projects', 'widgets', 'Tickets', 'widgets-12.md'), '---\nid: "widgets-12"\nstatus: "closed"\n---\n# body\nstatus: open\n');
    writeFileSync(join(v, 'Projects', 'widgets', 'Tickets', 'widgets-13.md'), '---\nid: "widgets-13"\nstatus: "open"\n---\n');
    return v;
}

test('only open in-flight rows are listed, oldest first; queued and closed rows are not (MAESTRO-319)', () => {
    const rows = [row('b', '2026-10-05'), row('a', '2026-10-01'), row('q', '2026-10-02', { queued: true }), row('d', '2026-10-03'), { id: 'x', kind: 'done', date: '2026-10-04', ts: '2026-10-04T09:00:00Z', closes: 'd', text: 'd' }];
    assert.deepEqual(evidence(rows).map((e) => e.id), ['a', 'b']);
});

test('a closed ticket is hard evidence to close; an open ticket and a missing note are not', () => {
    const v = ticketsVault();
    const rows = [row('t1', '2026-10-01', { ticket: 'widgets-12' }), row('t2', '2026-10-01', { ticket: 'widgets-13' }), row('t3', '2026-10-01', { ticket: 'widgets-99' }), row('t4', '2026-10-01')];
    const by = Object.fromEntries(evidence(rows, '2026-10-12', v).map((e) => [e.id, e]));
    assert.equal(by.t1.proposal, 'close');
    assert.deepEqual(by.t1.because, ['ticket widgets-12 is closed']);
    assert.equal(by.t1.ticketStatus, 'closed', 'the frontmatter status, not a line in the body');
    assert.equal(by.t2.proposal, 'ask');
    assert.equal(by.t2.ticketStatus, 'open');
    assert.equal(by.t3.ticketStatus, null);
    assert.equal(by.t3.proposal, 'ask');
    assert.equal(by.t4.proposal, 'ask');
    assert.equal(ticketStatus(undefined, 'widgets-12'), null);
    assert.equal(ticketStatus(v, '../../etc/passwd'), null, 'an id that is not a ticket id is never joined into a path');
});

test('a parent whose children are all closed is hard evidence; one open child is not, and no children is not', () => {
    const rows = [
        row('p1', '2026-10-01'), row('c1', '2026-10-01', { parent: 'p1' }), { id: 'dc1', kind: 'done', date: '2026-10-02', ts: '2026-10-02T09:00:00Z', closes: 'c1', text: 'c1' },
        row('p2', '2026-10-01'), row('c2', '2026-10-01', { parent: 'p2' }), row('c3', '2026-10-01', { parent: 'p2' }), { id: 'dc2', kind: 'done', date: '2026-10-02', ts: '2026-10-02T09:00:00Z', closes: 'c2', text: 'c2' },
        row('p3', '2026-10-01'),
    ];
    const by = Object.fromEntries(evidence(rows).map((e) => [e.id, e]));
    assert.equal(by.p1.proposal, 'close');
    assert.deepEqual(by.p1.children, { total: 1, open: 0 });
    assert.equal(by.p2.proposal, 'ask');
    assert.deepEqual(by.p2.children, { total: 2, open: 1 });
    assert.equal(by.p3.proposal, 'ask');
});

test('last touch is the newest row that points at the item, and idle days count from it', () => {
    const rows = [row('a', '2026-10-01'), { id: 'n1', kind: 'tag', date: '2026-10-09', ts: '2026-10-09T09:00:00Z', tags: 'a', text: 'stream x' }, { id: 'n2', kind: 'note', date: '2026-10-11', ts: '2026-10-11T09:00:00Z', text: 'unrelated' }];
    const [e] = evidence(rows);
    assert.equal(e.lastTouch, '2026-10-09');
    assert.equal(e.ageDays, 11);
    assert.equal(e.idleDays, 3);
});

test('prRefsIn finds owner/repo#N and PR URLs once each', () => {
    assert.deepEqual(prRefsIn('see acme/widgets#12 and https://github.com/acme/widgets/pull/12 and acme/api#7'), ['acme/widgets#12', 'acme/api#7']);
    assert.deepEqual(prRefsIn('no refs, only #12'), []);
});

test('renderEvidence leads with the totals and names the proof behind a close', () => {
    const rows = [row('p1', '2026-10-01'), row('c1', '2026-10-01', { parent: 'p1' }), { id: 'dc1', kind: 'done', date: '2026-10-02', ts: '2026-10-02T09:00:00Z', closes: 'c1', text: 'c1' }, row('z', '2026-10-03')];
    const lines = renderEvidence(evidence(rows), '2026-10-12');
    assert.match(lines[0], /Open in-flight rows on 2026-10-12: 2 \(1 with hard evidence to close, 1 for a batch ask\)/);
    assert.ok(lines.some((l) => /because: all 1 child row\(s\) are closed/.test(l)));
});
