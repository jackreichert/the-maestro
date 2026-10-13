// Run: node --test scripts/lib/whats-next/gather.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LedgerItem } from '../ledger-core.ts';
import { askRefs, gatherRankInput, inFlightRefs } from './gather.ts';

const item = (id: string, kind: string, over: Partial<LedgerItem> = {}): LedgerItem => ({ id, kind, text: `text ${id}`, closedBy: null, state: undefined, ...over } as LedgerItem);

test('in flight is open unqueued work plus open blocked rows; asks are open questions and pending decisions', () => {
  const items = [
    item('w1', 'wip', { ticket: 'orchard-1' }), item('w2', 'wip', { queued: true }), item('w3', 'wip', { closedBy: { kind: 'done' } as LedgerItem }),
    item('b1', 'blocked'), item('q1', 'question'), item('d1', 'decision', { pending: true }), item('d2', 'decision'),
  ];
  assert.deepEqual(inFlightRefs(items), [{ id: 'w1', text: 'text w1', ticket: 'orchard-1' }, { id: 'b1', text: 'text b1' }]);
  assert.deepEqual(askRefs(items).map((r) => r.id), ['q1', 'd1']);
});

test('missing sources contribute nothing; present ones are read', () => {
  const none = gatherRankInput({ vaultRoot: '', statusDir: '', items: [], today: '2026-10-13', frozenLabels: [], blockedLabels: [], now: new Date() });
  assert.deepEqual([none.tickets, none.rankFiles, none.tracker, none.goals, none.prs], [[], {}, null, [], []]);
  const vault = mkdtempSync(join(tmpdir(), 'gather-'));
  mkdirSync(join(vault, 'Projects', 'orchard', 'Tickets'), { recursive: true });
  writeFileSync(join(vault, 'Projects', 'orchard', 'Tickets', 'orchard-1.md'), '---\nid: orchard-1\n---\n');
  writeFileSync(join(vault, 'Projects', 'orchard', 'Board-rank.md'), '## Ranked\n1. [[orchard-1]]\n## Blocked on Samwise\n- [[orchard-2]]\n');
  const got = gatherRankInput({ vaultRoot: vault, statusDir: join(vault, 'no-status'), items: [], today: '2026-10-13', frozenLabels: ['x'], blockedLabels: ['y'], now: new Date() });
  assert.deepEqual(got.tickets.map((t) => t.id), ['orchard-1']);
  assert.deepEqual(got.rankFiles, { orchard: { ranked: ['orchard-1'], blocked: ['orchard-2'] } });
  assert.deepEqual([got.frozenLabels, got.blockedLabels], [['x'], ['y']]);
});
