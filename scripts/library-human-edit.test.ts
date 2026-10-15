// Run: node --test scripts/library-human-edit.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { humanEdits, recordedShas, sha256 } from './lib/library/human-edit.ts';
import { parseOptions } from './library-check.ts';

const SCRIPT = new URL('./library-check.ts', import.meta.url).pathname;
const REPO = 'avonlea-api';
const A = `Projects/${REPO}/Knowledge/orchard-sync.md`;
const B = `Projects/${REPO}/Knowledge/harvest-export.md`;
const page = (extra = ''): string => `---\ntype: library\nkind: how-it-works\nrepo: ${REPO}\nstream: Avonlea\ncomponents: [orchard-sync]\nstatus: current\nverified-at: 2026-10-08@abc1234\nverify-how: "read src/sync.ts:40"\ncomposed-by: composer\n---\n# Sync\n\nRead when: you change sync.\n\n## Facts\n\n- The sync runs nightly (verified 2026-10-08, src/sync.ts:40).${extra}\n`;
const curated = (path: string, text: string, id = 'c1') => JSON.stringify({ id, kind: 'curated', closes: 'l1', page: path, pageSha: sha256(text) });

function setup(files: Record<string, string>, ledger: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'human-edit-'));
  const all = { [`Projects/${REPO}/INDEX.md`]: `---\ntype: library-index\nrepo: ${REPO}\ncomponents: [orchard-sync]\n---\n`, ...files, [`Projects/${REPO}/Journal/ledger.jsonl`]: ledger.join('\n') + '\n' };
  for (const [p, t] of Object.entries(all)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), t); }
  return root;
}
const run = (root: string, ...args: string[]) => spawnSync(process.execPath, [SCRIPT, '--human-edited', '--vault', root, '--project', REPO, ...args], { encoding: 'utf8' });

test('humanEdits: a matching sha is unchanged, a differing one is edited, no curated row is unrecorded; the latest curated row wins', () => {
  const rows = [{ id: 'a', kind: 'curated', page: A, pageSha: 'old' }, { id: 'b', kind: 'curated', page: A, pageSha: 'new' }];
  assert.equal(recordedShas(rows).get(A), 'new');
  const out = humanEdits([{ path: A, sha: 'new', told: 0 }, { path: B, sha: 'zzz', told: 2 }], rows);
  assert.equal(out[0]?.state, 'unchanged');
  assert.equal(out[1]?.state, 'unrecorded');
  assert.match(out[1]?.detail ?? '', /2 told-by-jack lines are protected/);
  assert.equal(humanEdits([{ path: A, sha: 'old', told: 0 }], rows)[0]?.state, 'edited');
});

test('--human-edited lists a page changed since its last curated sha, and exits 0', () => {
  const written = page();
  const root = setup({ [A]: page('\n- Retries twice (verified 2026-10-09, src/sync.ts:50).'), [B]: page() }, [curated(A, written), curated(B, page(), 'c2')]);
  const r = run(root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`${A}  HUMAN-EDITED`));
  assert.doesNotMatch(r.stdout, new RegExp(`${B}  HUMAN-EDITED`));
  assert.match(r.stdout, /2 pages, 1 human-edited, 0 unrecorded, 1 unchanged/);
});

test('--human-edited reports a page with no curated row as unrecorded, never as fresh', () => {
  const r = run(setup({ [A]: page() }, []));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /orchard-sync\.md  unrecorded/);
  assert.match(r.stdout, /0 human-edited, 1 unrecorded, 0 unchanged/);
});

test('--human-edited --json carries the state of each page', () => {
  const r = run(setup({ [A]: page() }, [curated(A, page())]), '--json');
  assert.deepEqual(JSON.parse(r.stdout).map((x: { state: string }) => x.state), ['unchanged']);
});

test('--human-edited is its own report: not with --stale, --coverage or page arguments, and it needs a project', () => {
  assert.equal(typeof parseOptions(['--human-edited', '--stale']), 'string');
  assert.equal(typeof parseOptions(['--human-edited', '--coverage']), 'string');
  assert.equal(typeof parseOptions(['--human-edited', 'a.md']), 'string');
  assert.equal(typeof parseOptions(['--human-edited', '--project']), 'string');
  const root = setup({ [A]: page() }, []);
  const r = spawnSync(process.execPath, [SCRIPT, '--human-edited', '--vault', root], { encoding: 'utf8', env: { ...process.env, MAESTRO_PROJECT: '', MAESTRO_LOCAL_CONFIG: '' } });
  assert.equal(r.status, 2);
});
