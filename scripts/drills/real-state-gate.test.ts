import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildScratch, fixtureRows, PROJECT } from './lib.ts';
import { pendingFacts, realStateGate, truthFacts } from './real-state-gate.ts';

/** A fictional "real" ledger on disk: the gate is pointed at its Journal directory and vault, as it would be at the real ones. */
function source() {
  const s = buildScratch();
  return { s, opts: { project: PROJECT, journalDir: join(s.ledgerRoot, 'Projects', PROJECT, 'Journal'), vault: s.vault } };
}

test('the gate passes on a copy of a ledger and names every open id, ask and the priorities file', () => {
  const { s, opts } = source();
  try {
    const r = realStateGate(opts);
    assert.deepEqual(r.missing, []);
    assert.equal(r.ok, true);
    // wip1, wip2, blk1, wip3, ask1 and the priorities file, each checked against all three sources.
    assert.equal(r.checked, 6 * 3);
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test('the gate fails when an open row is withheld from the copy, by kind and id only', () => {
  const { s, opts } = source();
  try {
    const r = realStateGate({ ...opts, withhold: ['wip3'] });
    assert.equal(r.ok, false);
    assert.deepEqual(r.missing, ['startup: open-id wip3', 'compact: open-id wip3', 'clear: open-id wip3']);
    assert.ok(r.missing.every((m) => !/rotate the mirror keys/.test(m)), 'no ledger text in the report');
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test('the gate fails when a pending ask is withheld', () => {
  const { s, opts } = source();
  try {
    assert.deepEqual(realStateGate({ ...opts, withhold: ['ask1'] }).missing.map((m) => m.split(': ')[1]), ['ask ask1', 'ask ask1', 'ask ask1']);
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test('the original ledger is only read: its bytes are unchanged after a run with a withheld row', () => {
  const { s, opts } = source();
  try {
    const path = join(opts.journalDir, 'ledger.jsonl');
    const before = readFileSync(path, 'utf8');
    realStateGate({ ...opts, withhold: ['wip1', 'ask1'] });
    assert.equal(readFileSync(path, 'utf8'), before);
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test('the temp copy is removed and the startup context is written only where asked', () => {
  const { s, opts } = source();
  const out = join(mkdtempSync(join(tmpdir(), 'gate-emit-')), 'context.md');
  try {
    realStateGate({ ...opts, emitContext: out });
    assert.match(readFileSync(out, 'utf8'), /Cold start/);
  } finally { rmSync(s.root, { recursive: true, force: true }); rmSync(join(out, '..'), { recursive: true, force: true }); }
});

test('a missing ledger is an error, not a pass', () => {
  assert.throws(() => realStateGate({ project: 'x', journalDir: join(tmpdir(), 'no-such-journal-dir') }), /no ledger\.jsonl/);
});

test('truth is the open items only; pending facts are the recorded worktree or branch and recent decisions', () => {
  const rows = [
    ...fixtureRows('2026-10-11', '2026-10-10'),
    { ts: '2026-10-10T13:00:00.000Z', date: '2026-10-10', id: 'dcn1', kind: 'decision', stream: 'Rivendell', text: 'ship the northern gate' },
    { ts: '2026-10-10T13:00:00.000Z', date: '2026-10-10', id: 'wip4', kind: 'wip', stream: 'Rivendell', text: 'chart the pass', worktree: '/tmp/fictional/pass', branch: 'feat/pass' },
  ];
  assert.deepEqual(truthFacts(rows, null).map((f) => f.id).sort(), ['ask1', 'blk1', 'wip1', 'wip2', 'wip3', 'wip4']);
  assert.deepEqual(pendingFacts(rows, null).map((f) => f.id).sort(), ['dcn1.decision', 'wip4.branch', 'wip4.worktree']);
});
