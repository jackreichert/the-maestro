// Run: node --test scripts/journal-script.test.ts
// Hermetic: a temp ledger root, status dir and HOME. Never the live ledger.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MAESTRO_LOCAL_CONFIG = '';
const SCRIPT = new URL('./journal.ts', import.meta.url).pathname;
const MARK = ['--model', 'Test Model', '--used', 'skill:the-maestro,tool:journal.ts'];
const FIELDS = ['--title', 'Close ticket 12', '--what', 'Closes one vault ticket.', '--why', 'The agent cannot write the vault.', '--after', 'The ticket is closed.', '--blocks', 'abcd'];

let vault: string;
let work: string;
interface Run { code: number | null; out: string; err: string }
interface Row { id?: string; kind?: string; text?: string; paste?: string; script?: string; closes?: string; box?: string }

function run(args: string[]): Run {
  // The ledger flags go before any `--`: everything after it is the script's command.
  const stop = args.indexOf('--');
  const full = [...(stop === -1 ? args : args.slice(0, stop)), '--vault', vault, '--project', 'test-proj', ...(stop === -1 ? [] : args.slice(stop))];
  const r = spawnSync(process.execPath, [SCRIPT, ...full], {
    encoding: 'utf8',
    env: { ...process.env, VAULT_ROOT: '', LEDGER_ROOT: '', MAESTRO_STATUS_DIR: join(work, 'status'), MAESTRO_CONTAINER_ROOT: '', MAESTRO_UPDATE_CHECK: 'off', MAESTRO_EVENT_DIR: join(work, 'events'), MAESTRO_LAUNCH_AGENTS_DIR: join(work, 'agents'), MAESTRO_MEMORY_DIR: join(work, 'memory') },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const ledger = (): Row[] => { const f = join(vault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl'); return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Row) : []; };
const registryFile = (): string => join(vault, 'Projects', 'test-proj', 'Journal', 'scripts.jsonl');
const idOf = (out: string): string => /sc-[0-9a-f]{8}/.exec(out)?.[0] ?? '';

beforeEach(() => { vault = mkdtempSync(join(tmpdir(), 'journal-script-')); work = mkdtempSync(join(tmpdir(), 'journal-script-work-')); mkdirSync(join(work, 'status')); });
afterEach(() => { rmSync(vault, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); });

test('add registers the entry and raises one run-this ask that carries the script id and what/why/after', () => {
  const r = run(['script', 'add', '--kind', 'one-time', ...FIELDS, '--blocked-by', 'repo-worker: close ticket', ...MARK, '--', 'echo', 'hello world']);
  assert.equal(r.code, 0, r.err);
  const id = idOf(r.out);
  assert.ok(id, r.out);
  const asks = ledger().filter((x) => x.kind === 'question');
  assert.equal(asks.length, 1);
  assert.equal(asks[0]?.box, 'paste');
  assert.equal(asks[0]?.script, id);
  assert.match(String(asks[0]?.text), /\*\*Why we need it:\*\* The agent cannot write the vault\. \(blocks abcd\)/);
  assert.equal(readFileSync(String(asks[0]?.paste), 'utf8'), "echo 'hello world'\n", 'words after -- are re-quoted so the stored command is what the shell would have run');
  assert.match(readFileSync(registryFile(), 'utf8'), /"kind":"one-time"/);
});

test('the command can come from --command or --command-file; none, or two at once, is refused', () => {
  assert.equal(run(['script', 'add', '--kind', 'reusable', ...FIELDS, ...MARK, '--command', 'echo one']).code, 0);
  const file = join(work, 'cmd.sh');
  writeFileSync(file, 'echo two\n');
  assert.equal(run(['script', 'add', '--kind', 'reusable', ...FIELDS, '--title', 'Other', ...MARK, '--command-file', file]).code, 0);
  const none = run(['script', 'add', '--kind', 'reusable', ...FIELDS, ...MARK]);
  assert.equal(none.code, 1);
  assert.match(none.err, /exactly one way/);
  const both = run(['script', 'add', '--kind', 'reusable', ...FIELDS, ...MARK, '--command', 'echo a', '--', 'echo', 'b']);
  assert.equal(both.code, 1);
});

test('a refused script writes nothing: a secret-shaped command, an env dump, a bad kind', () => {
  const key = ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('');
  for (const [command, kind] of [[`aws s3 ls --access-key ${key}`, 'one-time'], ['printenv', 'one-time'], ['echo hi', 'whenever']] as const) {
    const r = run(['script', 'add', '--kind', kind, ...FIELDS, ...MARK, '--command', command]);
    assert.equal(r.code, 1, command);
    assert.match(r.err, /refused, nothing written/);
  }
  assert.equal(ledger().length, 0);
  assert.equal(existsSync(registryFile()), false);
});

test('add is idempotent while the ask waits, and --dry-run writes nothing', () => {
  const args = ['script', 'add', '--kind', 'one-time', ...FIELDS, ...MARK, '--command', 'echo hi'];
  assert.match(run([...args, '--dry-run']).out, /dry run/);
  assert.equal(existsSync(registryFile()), false);
  const a = run(args); const b = run(args);
  assert.equal(idOf(a.out), idOf(b.out));
  assert.match(b.out, /already registered/);
  assert.equal(ledger().filter((x) => x.kind === 'question').length, 1);
});

test('ran on a one-time script resolves its ask and moves it to History; a second ran is refused', () => {
  const id = idOf(run(['script', 'add', '--kind', 'one-time', ...FIELDS, ...MARK, '--command', 'echo hi']).out);
  assert.match(run(['script', 'list']).out, new RegExp(`blocked\\s+${id}`));
  const done = run(['script', 'ran', id, ...MARK]);
  assert.equal(done.code, 0, done.err);
  assert.match(done.out, /resolved/);
  assert.equal(ledger().filter((x) => x.kind === 'resolved').length, 1);
  assert.match(run(['script', 'list']).out, /No scripts are waiting/);
  assert.match(run(['script', 'list', '--all']).out, new RegExp(`history\\s+${id}.*last run`));
  const again = run(['script', 'ran', id, ...MARK]);
  assert.equal(again.code, 1);
  assert.match(again.err, /already finished/);
});

test('ran on a reusable script resolves the ask once, stays listed with its last run, and may be recorded again', () => {
  const id = idOf(run(['script', 'add', '--kind', 'reusable', ...FIELDS, ...MARK, '--command', 'echo hi']).out);
  assert.equal(run(['script', 'ran', id, ...MARK]).code, 0);
  assert.equal(run(['script', 'ran', id, '--result', 'failed', ...MARK]).code, 0);
  const rows = ledger();
  assert.equal(rows.filter((x) => x.kind === 'resolved').length, 1, 'the ask resolves once; a later run opens nothing');
  const json = JSON.parse(run(['script', 'list', '--json']).out) as { scripts: { id: string; status: string; runs: number; lastRun: { result: string } }[] };
  assert.deepEqual(json.scripts.map((s) => [s.id, s.status, s.runs, s.lastRun.result]), [[id, 'reusable', 2, 'failed']]);
});

test('a failed run leaves the ask waiting; an unknown id and a bad result are refused', () => {
  const id = idOf(run(['script', 'add', '--kind', 'one-time', ...FIELDS, ...MARK, '--command', 'echo hi']).out);
  assert.equal(run(['script', 'ran', id, '--result', 'failed', ...MARK]).code, 0);
  assert.equal(ledger().filter((x) => x.kind === 'resolved').length, 0);
  assert.match(run(['script', 'list']).out, /blocked/);
  assert.equal(run(['script', 'ran', 'sc-00000000', ...MARK]).code, 1);
  assert.equal(run(['script', 'ran', id, '--result', 'sure']).code, 1);
});

test('help lists the subcommands and a bare `script` prints usage', () => {
  assert.match(run(['script', '--help']).out, /--blocks <id>/);
  const bare = run(['script']);
  assert.equal(bare.code, 2);
  assert.match(bare.err, /script add/);
});
