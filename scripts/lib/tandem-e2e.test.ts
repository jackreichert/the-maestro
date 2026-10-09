// Run: node --test scripts/lib/tandem-e2e.test.ts
// The tandem end to end: two windows are separate journal.ts and event-loop.ts processes, with different window ids, over one ledger root and one event dir.
// Proves, with nothing mocked: no double claim of an item or an event, events reach only the window that owns their repo, a lapsed lease hands its events to
// the other window, handoffs are created exclusively, and no ledger row or event is lost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvents } from './event-inbox.ts';

const JOURNAL = new URL('../journal.ts', import.meta.url).pathname;
const LOOP = new URL('../event-loop.ts', import.meta.url).pathname;
const PROJECT = 'tandem';
const MARK = ['--model', 'Test Model', '--used', 'skill:the-maestro,tool:journal.ts'];
const MIN = 60_000;

interface Run { status: number | null; stdout: string; stderr: string }

function setup() {
  const vault = mkdtempSync(join(tmpdir(), 'tandem-e2e-'));
  const cwd = mkdtempSync(join(tmpdir(), 'tandem-e2e-cwd-'));
  const events = join(vault, 'Events');
  const env = {
    ...process.env, VAULT_ROOT: vault, LEDGER_ROOT: vault, MAESTRO_PROJECT: PROJECT, MAESTRO_LOCAL_CONFIG: '', MAESTRO_WINDOW: '', CLAUDE_CODE_SESSION_ID: '', CLAUDE_PID: '',
    MAESTRO_UPDATE_CHECK: 'off', MAESTRO_CONTAINER_ROOT: '', MAESTRO_EVENT_DIR: events, MAESTRO_WATCH_QUIET_HOURS: 'off', MAESTRO_STATUS_REPO_STREAMS: '',
  };
  const exec = (script: string, args: string[]): Promise<Run> => new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  const journal = (window: string, ...args: string[]) => exec(JOURNAL, [...args, '--vault', vault, '--project', PROJECT, '--window', window]);
  const loop = (window: string, ...args: string[]) => exec(LOOP, [...args, '--window', window]);
  const wait = (window: string) => loop(window, 'events', 'wait', '--timeout-hours', '0.00003', '--poll-seconds', '0.05');
  const ledger = (): Record<string, unknown>[] => readFileSync(join(vault, 'Projects', PROJECT, 'Journal', 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  return { vault, events, journal, loop, wait, ledger, done: () => { rmSync(vault, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); } };
}
type T = ReturnType<typeof setup>;

const digest = (repo: string, n: number) => ({ watch: 'prs', type: 'pr-watch', at: '2026-10-01T12:00:00.000Z', summary: `THREAD ${repo}#${n} by someone: u`, actionable: true, report: '' });
const numberOf = (line: string): number => Number(line.match(/number=(\d+)/)![1]);
const repoOf = (line: string): string => line.match(/repo=(\S+)/)![1];

/** What one window did over a run: the event lines it was handed, in order, and the ledger rows it wrote. */
interface Outcome { window: string; lines: string[]; logged: number }

/** One window's life: wait for events, log a row, ack what it was given, until the producer is finished and two waits in a row come back empty. */
async function live(t: T, window: string, producing: { done: boolean }): Promise<Outcome> {
  const out: Outcome = { window, lines: [], logged: 0 };
  let idle = 0;
  while (idle < 2) {
    const [r, row] = await Promise.all([t.wait(window), t.journal(window, 'log', `row ${out.logged} from ${window}`, ...MARK)]);
    assert.equal(row.status, 0, row.stderr);
    out.logged += 1;
    const lines = r.stdout.split('\n').filter(Boolean);
    assert.ok(r.status === 0 || r.status === 10, `${window}: events wait exited ${r.status}: ${r.stderr}`);
    if (lines.length) {
      out.lines.push(...lines);
      const ack = await t.loop(window, 'events', 'ack', ...lines.map((l) => l.split(' ')[0]));
      assert.equal(ack.status, 0, ack.stderr);
      idle = 0;
    } else if (producing.done) idle += 1;
  }
  return out;
}

test('two windows, one ledger: each event is handled once, by the window that owns its repo; no row or event is lost', async () => {
  const t = setup();
  try {
    const id = (r: Run): string => r.stdout.match(/wip\s+(\S+)/)![1];
    const [a, b] = await Promise.all([t.journal('wa', 'start', 'api work', '--repo', 'api', ...MARK), t.journal('wb', 'start', 'web work', '--repo', 'web', ...MARK)]);
    assert.equal(a.status, 0, a.stderr);
    assert.equal(b.status, 0, b.stderr);
    const itemA = id(a);
    assert.equal((await t.journal('wb', 'start', itemA, ...MARK)).status, 1, 'no double claim: the other window is refused the item a window already holds');

    const producing = { done: false };
    const produce = (async () => {
      for (let batch = 0; batch < 3; batch++) {
        appendEvents(t.events, [1, 2].flatMap((n) => [digest('acme/api', batch * 10 + n), digest('acme/web', batch * 10 + n), digest('acme/docs', batch * 10 + n)]));
        await new Promise((r) => setTimeout(r, 250));
      }
      producing.done = true;
    })();
    const [oa, ob] = (await Promise.all([live(t, 'wa', producing), live(t, 'wb', producing), produce])).slice(0, 2) as [Outcome, Outcome];

    const all = [...oa.lines, ...ob.lines];
    assert.equal(all.length, 18, 'every event was handed out');
    assert.equal(new Set(all.map((l) => l.split(' ')[0])).size, 18, 'and none twice: no double claim');
    for (const l of oa.lines.filter((l) => repoOf(l) !== 'acme/docs')) assert.equal(repoOf(l), 'acme/api', 'wa only got events for the repo it leases');
    for (const l of ob.lines.filter((l) => repoOf(l) !== 'acme/docs')) assert.equal(repoOf(l), 'acme/web', 'wb only got events for the repo it leases');
    assert.equal(all.filter((l) => repoOf(l) === 'acme/api').length, 6, 'all api events reached a window');
    assert.equal(oa.lines.filter((l) => repoOf(l) === 'acme/api').length, 6, 'and it was the owner');
    assert.equal(ob.lines.filter((l) => repoOf(l) === 'acme/web').length, 6);
    assert.equal(all.filter((l) => repoOf(l) === 'acme/docs').length, 6, 'events nobody owns were taken by exactly one window each');

    const listed = JSON.parse((await t.loop('wa', 'events', '--all', '--json')).stdout) as { handled: boolean; seenWindows: string[] }[];
    assert.equal(listed.length, 18);
    assert.ok(listed.every((e) => e.handled), 'every event was acked');
    const rows = t.ledger();
    assert.equal(rows.filter((r) => r.window === 'wa' && r.kind === 'note').length, oa.logged, 'no row of wa was lost');
    assert.equal(rows.filter((r) => r.window === 'wb' && r.kind === 'note').length, ob.logged, 'no row of wb was lost');
    assert.equal(new Set(rows.map((r) => r.id).filter(Boolean)).size, rows.filter((r) => r.id).length, 'row ids are unique');
    assert.equal((await t.journal('wa', 'verify')).status, 0);
  } finally { t.done(); }
});

test('a lapsed lease hands its events to the other window; before it lapses they wait for the owner', async () => {
  const t = setup();
  try {
    const dir = join(t.vault, 'Projects', PROJECT, 'Journal');
    mkdirSync(dir, { recursive: true });
    // wa leases the api work for one minute, written 57 seconds ago: live now, lapsed in about three seconds. wa is not running: this is the window that died.
    appendFileSync(join(dir, 'ledger.jsonl'), `${JSON.stringify({ id: 'dead', kind: 'wip', text: 'api work', repo: 'api', ts: new Date(Date.now() - 57_000).toISOString(), window: 'wa', leaseTtl: 1 })}\n`);
    appendEvents(t.events, [1, 2, 3].map((n) => digest('acme/api', n)));
    const early = await t.wait('wb');
    assert.equal(early.status, 0, 'while wa\'s lease is live the events are wa\'s, not wb\'s');
    assert.equal(early.stdout, '');
    await new Promise((r) => setTimeout(r, 3500));
    const late = await t.wait('wb');
    assert.equal(late.status, 10, late.stderr);
    assert.deepEqual(late.stdout.split('\n').filter(Boolean).map(numberOf).sort(), [1, 2, 3], 'once it lapsed, wb got all three: none was dropped');
    assert.equal((await t.wait('wa')).stdout, '', 'and wa, back from the dead, is not offered what wb already took');
    assert.equal((await t.wait('wb')).stdout, '', 'nor is wb offered them twice');
  } finally { t.done(); }
});

test('handoffs written by two windows at once are created exclusively: every one exists, whole, with its own name', async () => {
  const t = setup();
  try {
    assert.equal((await t.journal('wa', 'log', 'seed row', ...MARK)).status, 0);
    const rounds = await Promise.all(['wa', 'wb', 'wa', 'wb', 'wa', 'wb'].map((w) => t.journal(w, 'handoff', '--all', '--delta')));
    const names = rounds.map((r) => (r.stdout.match(/wrote \S*\/(HANDOFF-\S+\.md)/) ?? ['', ''])[1]);
    assert.ok(rounds.every((r) => r.status === 0), rounds.map((r) => r.stderr).join('\n'));
    assert.equal(new Set(names).size, 6, 'six concurrent handoffs, six different files');
    const files = readdirSync(join(t.vault, 'Projects', PROJECT, 'Journal')).filter((f) => f.startsWith('HANDOFF-'));
    assert.deepEqual([...files].sort(), [...names].sort(), 'no file is missing and none was overwritten');
    assert.equal(files.filter((f) => /\.tmp$/.test(f)).length, 0);
  } finally { t.done(); }
});
