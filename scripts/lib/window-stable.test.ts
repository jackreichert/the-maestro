// Run: node --test scripts/lib/window-stable.test.ts
// Two simulated Claude Code windows share one ledger and run many separate journal.ts processes each; every window keeps its own id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = new URL('../journal.ts', import.meta.url).pathname;
const MARK = ['--model', 'Test Model', '--used', 'skill:the-maestro,tool:journal.ts'];
const WINDOWS: Record<string, Record<string, string>> = {
  a: { CLAUDE_CODE_SESSION_ID: 'aaaaaaaa-1111-4000-8000-000000000001', CLAUDE_PID: '1001' },
  b: { CLAUDE_CODE_SESSION_ID: 'bbbbbbbb-2222-4000-8000-000000000002', CLAUDE_PID: '1002' },
};

function setup() {
  const vault = mkdtempSync(join(tmpdir(), 'window-stable-'));
  const cwd = mkdtempSync(join(tmpdir(), 'window-stable-cwd-'));
  // `sh -c` (not exec'd) puts a fresh parent shell between the test and journal.ts, as each Bash tool call does, so the ppid differs on every call.
  const journal = (extra: Record<string, string>, ...args: string[]) => spawnSync('sh', ['-c', '"$0" "$@"; r=$?; exit $r', process.execPath, SCRIPT, ...args, '--vault', vault, '--project', 'test-proj'], {
    encoding: 'utf8', cwd,
    env: { ...process.env, VAULT_ROOT: '', MAESTRO_LOCAL_CONFIG: '', MAESTRO_WINDOW: '', CLAUDE_CODE_SESSION_ID: '', CLAUDE_PID: '', MAESTRO_UPDATE_CHECK: 'off', MAESTRO_CONTAINER_ROOT: '', MAESTRO_EVENT_DIR: join(vault, 'Events'), ...extra },
  });
  const rows = () => readFileSync(join(vault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { text: string; window: string });
  return { journal, rows, done: () => { rmSync(vault, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); } };
}

test('two windows interleave many separate invocations and each keeps its own id', () => {
  const t = setup();
  try {
    for (let i = 0; i < 6; i++) for (const w of ['a', 'b']) assert.equal(t.journal(WINDOWS[w], 'start', `${w}${i}`, ...MARK).status, 0);
    const byWindow = (w: string) => new Set(t.rows().filter((r) => r.text.startsWith(w)).map((r) => r.window));
    assert.deepEqual([...byWindow('a')], ['aaaaaaaa-111'], 'every call of window a wrote the id of its session');
    assert.deepEqual([...byWindow('b')], ['bbbbbbbb-222']);
    assert.equal(t.rows().length, 12);
  } finally { t.done(); }
});

test('with only the Claude process id, the id is still one per window, and no warning is printed', () => {
  const t = setup();
  try {
    for (let i = 0; i < 4; i++) for (const w of ['a', 'b']) assert.equal(t.journal({ CLAUDE_PID: WINDOWS[w].CLAUDE_PID }, 'start', `${w}${i}`, ...MARK).status, 0);
    assert.deepEqual([...new Set(t.rows().filter((r) => r.text.startsWith('a')).map((r) => r.window))], ['c1001']);
    assert.deepEqual([...new Set(t.rows().filter((r) => r.text.startsWith('b')).map((r) => r.window))], ['c1002']);
    for (const cmd of ['prime', 'status']) assert.doesNotMatch(t.journal({ CLAUDE_PID: '1001' }, cmd).stdout, /UNSTABLE/, cmd);
  } finally { t.done(); }
});

test('with nothing to identify the window, the id changes per call and prime and status say so', () => {
  const t = setup();
  try {
    for (let i = 0; i < 2; i++) assert.equal(t.journal({}, 'start', `x${i}`, ...MARK).status, 0);
    const [one, two] = t.rows().map((r) => r.window);
    assert.match(one, /^p\d+$/);
    assert.notEqual(one, two, 'the shell differs on every call, which is the instability the warning names');
    for (const cmd of ['prime', 'status']) assert.match(t.journal({}, cmd).stdout, /Window id p\d+ is UNSTABLE/, cmd);
    assert.doesNotMatch(t.journal({}, 'status', '--json').stdout, /UNSTABLE/, 'machine output stays clean');
  } finally { t.done(); }
});
