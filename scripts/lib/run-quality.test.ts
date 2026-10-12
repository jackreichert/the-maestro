// Run: node --test scripts/lib/run-quality.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runQuality } from './run-quality.ts';

const NOW = new Date('2026-10-07T12:00:00Z');
const sizes: Record<string, number> = { '/r/full.md': 10, '/r/empty.md': 0 };
const size = (p: string): number | null => sizes[p] ?? null;

test('a send-back after the item was done, or of an item done outside the window, is not a retry', () => {
    const q = runQuality([
        { id: 'd1', kind: 'done', closes: 'a', ts: '2026-10-06T12:00:00Z' },
        { id: 'q1', kind: 'queue', queues: 'a', ts: '2026-10-06T13:00:00Z' },
        { id: 'd2', kind: 'done', closes: 'b', ts: '2026-09-01T12:00:00Z' },
        { id: 'q2', kind: 'queue', queues: 'b', ts: '2026-08-31T12:00:00Z' },
    ], NOW, 14, size);
    assert.deepEqual([q.completed, q.retries, q.retriesPerRun], [1, 0, 0]);
});

test('a brief whose report is missing, empty or unnamed is silent; a written one is not; nothing briefed gives zero', () => {
    const brief = (id: string, report?: string) => ({ id: `b-${id}`, kind: 'brief', briefs: id, report, ts: '2026-10-06T12:00:00Z' });
    const q = runQuality([brief('x', '/r/full.md'), brief('y', '/r/empty.md'), brief('z', '/r/none.md'), brief('w')], NOW, 14, size);
    assert.deepEqual([q.briefed, q.silent, q.silentIds], [4, 3, ['y', 'z', 'w']]);
    const none = runQuality([], NOW, 14, size);
    assert.deepEqual([none.briefed, none.silent, none.retriesPerRun], [0, 0, null]);
});
