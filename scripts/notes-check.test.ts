// Run: node --test scripts/notes-check.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const JOURNAL = new URL('./journal.ts', import.meta.url).pathname;
const MARK = ['--model', 'Test Model', '--used', 'skill:the-maestro'];
function cli(world: { ledger: string; vault: string; events: string }, ...args: string[]) {
  const r = spawnSync(process.execPath, [JOURNAL, ...args, '--vault', world.ledger, '--project', 'test-proj'], {
    encoding: 'utf8', cwd: tmpdir(),
    env: { ...process.env, MAESTRO_LOCAL_CONFIG: '', VAULT_ROOT: world.vault, MAESTRO_STATUS_DIR: join(world.vault, 'Projects', 'test-proj', 'Status'), MAESTRO_EVENT_DIR: world.events, MAESTRO_LAUNCH_AGENTS_DIR: join(world.events, 'LaunchAgents'), MAESTRO_UPDATE_CHECK: 'off', MAESTRO_CONTAINER_ROOT: '', MAESTRO_PROJECTS_DIR: tmpdir() },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const put = (root: string, path: string, text: string): void => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };

/** A throwaway vault with one project mapped to the stream Avonlea (which has an open item), and one note in it. */
function world(note: string) {
  const w = { ledger: mkdtempSync(join(tmpdir(), 'nc-ledger-')), vault: mkdtempSync(join(tmpdir(), 'nc-vault-')), events: mkdtempSync(join(tmpdir(), 'nc-events-')) };
  put(w.vault, 'Projects/orchard/CONTEXT.md', '# Orchard\n');
  put(w.vault, 'Projects/orchard/Plans/harvest.md', note);
  put(w.vault, 'Projects/test-proj/Status/stream-homes.json', JSON.stringify({ version: 1, streams: { Avonlea: { projects: ['orchard'] } } }));
  assert.equal(cli(w, 'log', 'tend the orchard', '--kind', 'wip', '--stream', 'Avonlea', '--new-stream', ...MARK).code, 0);
  return w;
}

test('notes-check exits 1 and names an unattributed note with its fix, then 0 once the note carries a stream', () => {
  const w = world('# Harvest plan\n');
  const bad = cli(w, 'notes-check');
  assert.equal(bad.code, 1, bad.err);
  assert.match(bad.out, /1 of 2 notes .* listed on no stream tab \(Avonlea 1\)/);
  assert.match(bad.out, /Projects\/orchard\/Plans\/harvest\.md: names no ticket and no stream/);
  assert.match(bad.out, /fix: add "stream: Avonlea"/);
  put(w.vault, 'Projects/orchard/Plans/harvest.md', '---\nstream: Avonlea\n---\n# Harvest plan\n');
  const good = cli(w, 'notes-check');
  assert.equal(good.code, 0, good.out + good.err);
  assert.match(good.out, /0 of 2 notes/);
});

test('notes-check --json carries the report, and an unset vault root is exit 2, never a pass', () => {
  const w = world('# Harvest plan\n');
  assert.equal(JSON.parse(cli(w, 'notes-check', '--json').out).report.unreachable.length, 1);
  const blind = cli({ ...w, vault: '' }, 'notes-check');
  assert.equal(blind.code, 2);
  assert.match(blind.err, /no vault root is configured/);
});

test('the standing row notes-reachable refuses done while a note is unreachable, and the roll prints the list without failing', () => {
  const w = world('# Harvest plan\n');
  const done = cli(w, 'standing', 'done', 'notes-reachable', '--evidence', 'trust me');
  assert.equal(done.code, 1);
  assert.match(done.err, /not done: its check says 1 to fix, first: Projects\/orchard\/Plans\/harvest\.md/);
  const roll = cli(w, 'roll', '--fast', '--allow-unmarked');
  assert.equal(roll.code, 0, roll.err);
  assert.match(roll.out, /Notes reachability: 1 of 2 notes/);
});
