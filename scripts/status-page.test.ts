// Run: node --test scripts/status-page.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installGhStub, prNode } from './lib/gh-stub.ts';

const JOURNAL = new URL('./journal.ts', import.meta.url).pathname;
const MARK = ['--model', 'Test Model', '--used', 'tool:test'];
const cwd = mkdtempSync(join(tmpdir(), 'sp-cwd-'));

/** A ledger with one ask and one item in flight, a status dir, and a gh stub serving one open PR. */
function setup() {
  const ledger = mkdtempSync(join(tmpdir(), 'sp-ledger-'));
  const statusDir = join(mkdtempSync(join(tmpdir(), 'sp-vault-')), 'Status');
  const env = {
    ...installGhStub({ pages: [[prNode(12, { title: 'feat: widgets FAKE-12', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', commits: { nodes: [] } })]] }),
    LEDGER_ROOT: '', VAULT_ROOT: '', MAESTRO_STATUS_REPO_STREAMS: 'repo=Alpha', MAESTRO_STATUS_STREAMS: 'Alpha', MAESTRO_UPDATE_CHECK: 'off', MAESTRO_CONTAINER_ROOT: '',
  };
  const run = (...args: string[]) => spawnSync(process.execPath, [JOURNAL, ...args, '--vault', ledger, '--project', 'proj', '--status-dir', statusDir], { encoding: 'utf8', cwd, env });
  assert.equal(run('ask', 'Merge widgets #12?', '--stream', 'Alpha', '--new-stream', ...MARK).status, 0);
  assert.equal(run('start', 'build a thing', '--stream', 'Alpha', ...MARK).status, 0);
  return { run, statusDir, env };
}

test('journal.ts status-page reads the ledger and gh, writes NOW.md, and --dry-run writes nothing', () => {
  const { run, statusDir } = setup();
  assert.equal(run('priorities', 'set', 'Get widgets out | Alpha').status, 0);
  const dry = run('status-page', '--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /1\. Get widgets out _\[Alpha: awaiting 1 · in flight 1 · open PRs 1\]_/);
  assert.equal(existsSync(join(statusDir, 'NOW.md')), false);
  const real = run('status-page', '--snapshot');
  assert.equal(real.status, 0, real.stderr);
  const page = readFileSync(join(statusDir, 'NOW.md'), 'utf8');
  assert.match(page, /\| `[a-z0-9]{4}` \| Alpha \| - \| - \| Merge widgets #12\? \|/);
  assert.match(page, /### Alpha \(1\)\n\n\| Ticket \| Develop PR/);
  assert.equal(readdirSync(statusDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).length, 1, 'snapshot written');
});

test('a gh failure exits 1 with a message and writes no page', () => {
  const { statusDir, env } = setup();
  const broken = spawnSync(process.execPath, [JOURNAL, 'status-page', '--vault', mkdtempSync(join(tmpdir(), 'sp-l-')), '--project', 'proj', '--status-dir', statusDir], {
    encoding: 'utf8', cwd, env: { ...env, PATH: '/nonexistent-dir' },
  });
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /status-page: /);
  assert.equal(existsSync(join(statusDir, 'NOW.md')), false);
});

test('status --footer ends with the status page URI only when one is configured', () => {
  const { run, env } = setup();
  assert.doesNotMatch(run('status', '--footer').stdout, /Status page/);
  const withUri = spawnSync(process.execPath, [JOURNAL, 'status', '--footer', '--vault', mkdtempSync(join(tmpdir(), 'sp-l-')), '--project', 'proj'], {
    encoding: 'utf8', cwd, env: { ...env, MAESTRO_STATUS_PAGE_URI: 'obsidian://open?vault=Example&file=Projects%2Fx%2FStatus%2FNOW' },
  });
  const lines = withUri.stdout.trim().split('\n');
  assert.equal(lines[lines.length - 1], '**Status page:** obsidian://open?vault=Example&file=Projects%2Fx%2FStatus%2FNOW');
});

test('status --footer derives the URI from status_dir inside vault_root and obsidian_vault', () => {
  const { env } = setup();
  const out = spawnSync(process.execPath, [JOURNAL, 'status', '--footer', '--vault', mkdtempSync(join(tmpdir(), 'sp-l-')), '--project', 'proj'], {
    encoding: 'utf8', cwd, env: { ...env, VAULT_ROOT: '/v/Notes', MAESTRO_STATUS_DIR: '/v/Notes/Projects/proj/Status', MAESTRO_OBSIDIAN_VAULT: 'Notes' },
  });
  assert.match(out.stdout, /\*\*Status page:\*\* obsidian:\/\/open\?vault=Notes&file=Projects%2Fproj%2FStatus%2FNOW\n$/);
});
