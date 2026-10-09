// Run: node --test scripts/snapshot-baseline.test.ts
// The idle-tick refresh must not eat the baseline `prs-snapshot.ts --diff` compares against, and the footer must still see the fresher board.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { installGhStub, prNode } from './lib/gh-stub.ts';

const ledger = mkdtempSync(join(tmpdir(), 'sb-ledger-'));
process.env.MAESTRO_LOCAL_CONFIG = '';
process.env.LEDGER_ROOT = ledger;
const { currentPath, snapshotPath, freshestSnapshotPath } = await import('./prs-snapshot.ts');
const { realIo } = await import('./event-types/status-refresh.ts');
const { readSnapshotPrs } = await import('./lib/review-queue.ts');

const withStub = (config: Parameters<typeof installGhStub>[0]): NodeJS.ProcessEnv => { const env = installGhStub(config); process.env.PATH = env.PATH; process.env.GH_STUB_CONFIG = env.GH_STUB_CONFIG; return env; };
const cli = (env: NodeJS.ProcessEnv, args: string[]) => spawnSync(process.execPath, [join(import.meta.dirname, 'prs-snapshot.ts'), ...args, '--vault', ledger], { encoding: 'utf8', env: { ...process.env, ...env, LEDGER_ROOT: ledger, MAESTRO_LOCAL_CONFIG: '' } });
const backdate = (path: string, ms: number): void => { const s = JSON.parse(readFileSync(path, 'utf8')); s.takenAt = new Date(Date.now() - ms).toISOString(); writeFileSync(path, JSON.stringify(s)); };

test('a loop refresh between two greetings leaves the draft promotion in the next --diff, and the footer reads the fresher file', () => {
  mkdirSync(dirname(snapshotPath(ledger)), { recursive: true });
  const morning = withStub({ pages: [[prNode(7, { isDraft: true })]] });
  assert.equal(cli(morning, []).status, 0, 'morning run writes the baseline');
  backdate(snapshotPath(ledger), 11 * 60_000);
  const baseline = readFileSync(snapshotPath(ledger), 'utf8');

  withStub({ pages: [[prNode(7, { isDraft: false })]] }); // the draft is promoted
  assert.equal(realIo.refreshSnapshot(), undefined);
  assert.equal(readFileSync(snapshotPath(ledger), 'utf8'), baseline, 'the refresh leaves the baseline byte for byte');
  assert.ok(existsSync(currentPath(ledger)));

  const out = cli(withStub({ pages: [[prNode(7, { isDraft: false })]] }), ['--diff', '--dry-run']).stdout;
  assert.doesNotMatch(out, /No actionable changes/);
  assert.match(out, /org\/repo#7/);
  assert.match(out, /ready/i);

  assert.equal(freshestSnapshotPath(ledger), currentPath(ledger), 'the newer file wins');
  assert.equal(readSnapshotPrs(freshestSnapshotPath(ledger))?.prs.filter((p) => !p.isDraft).length, 1, 'the footer counts the promoted PR');
  assert.equal(readSnapshotPrs(snapshotPath(ledger))?.prs.filter((p) => !p.isDraft).length, 0, 'the baseline still holds the draft');
});

test('after a greeting run writes a newer baseline, the baseline is the freshest again', () => {
  backdate(currentPath(ledger), 30 * 60_000);
  assert.equal(cli(withStub({ pages: [[prNode(7, { isDraft: false })]] }), []).status, 0);
  assert.equal(freshestSnapshotPath(ledger), snapshotPath(ledger));
});

test('with neither file, the freshest path is the baseline path and reads as no snapshot', () => {
  const empty = mkdtempSync(join(tmpdir(), 'sb-empty-'));
  assert.equal(freshestSnapshotPath(empty), snapshotPath(empty));
  assert.equal(readSnapshotPrs(freshestSnapshotPath(empty)), null);
});
