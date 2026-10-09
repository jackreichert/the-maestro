import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { continuityLines, dirtyPaths, errorLine, hitMarker, newestHandoff, snapshotDirty, unledgeredDecisions, userMessages } from './continuous-roll.ts';

const line = (o: object): string => JSON.stringify(o);
const T0 = '2026-10-09T12:00:00.000Z';
const at = (min: number): string => new Date(Date.parse(T0) + min * 60_000).toISOString();

test('userMessages keeps typed text and drops tool results, meta rows and injected tags', () => {
  const t = [
    line({ type: 'user', timestamp: at(0), message: { content: 'always use drafts' } }),
    line({ type: 'user', timestamp: at(1), message: { content: [{ type: 'tool_result', content: 'x' }] } }),
    line({ type: 'user', timestamp: at(2), isMeta: true, message: { content: 'meta' } }),
    line({ type: 'user', timestamp: at(3), message: { content: '<command-name>/x</command-name>' } }),
    line({ type: 'user', timestamp: at(4), message: { content: [{ type: 'text', text: 'ok to push' }] } }),
    'not json "user"',
  ].join('\n');
  assert.deepEqual(userMessages(t).map((m) => m.text), ['always use drafts', 'ok to push']);
});

const msg = (n: number, text = `from now on rule number ${n} applies`) => ({ ts: at(n), text });
const askFor = (m: { ts: string; text: string }, minute = 100) => ({ kind: 'question', ts: at(minute), text: `unledgered decision? ${hitMarker(m)} x`, used: ['hook:precompact'] });

test('a decision is handled only by its own marker or a rule row that restates it; nothing else, however near in time', () => {
  const m = { ts: at(0), text: 'from now on never merge without a green suite' };
  assert.equal(unledgeredDecisions([m], []).raise.length, 1);
  assert.equal(unledgeredDecisions([m], [askFor(m)]).raise.length, 0, 'its own marker');
  assert.equal(unledgeredDecisions([m], [{ kind: 'rule', ts: at(5), text: 'never merge without a green suite: the suite must pass first' }]).raise.length, 0, 'a rule restating it');
  assert.equal(unledgeredDecisions([m], [{ kind: 'rule', ts: at(5), text: 'merge needs green' }]).raise.length, 1, 'a short unrelated rule does not');
});

test('failure 1: two decisions, then an unrelated orchestrator ask, are both still raised', () => {
  const msgs = [msg(0, 'from now on never push to main'), msg(1, 'always open drafts first')];
  const unrelated = { kind: 'question', ts: at(5), text: 'Which model should the review use?' };
  assert.equal(unledgeredDecisions(msgs, [unrelated]).raise.length, 2);
});

test('failure 2: resolving one raised ask does not stop the rest of 25 decisions', () => {
  const msgs = Array.from({ length: 25 }, (_, n) => msg(n));
  const first = unledgeredDecisions(msgs, []);
  assert.deepEqual({ n: first.raise.length, pending: first.pending }, { n: 10, pending: 15 });
  const rows = [...msgs.slice(0, 10).map((m) => askFor(m)), { kind: 'resolved', ts: at(101), text: 'answered the first ask' }];
  const second = unledgeredDecisions(msgs, rows);
  assert.deepEqual({ n: second.raise.length, pending: second.pending }, { n: 10, pending: 5 });
});

test('failure 3: one human decision row hides only the message it restates, not its neighbours', () => {
  const msgs = [msg(0, 'from now on deploys need a ticket reference'), ...Array.from({ length: 9 }, (_, n) => msg(n + 1))];
  const human = { kind: 'decision', ts: at(2), text: 'deploys need a ticket reference from now on' };
  const out = unledgeredDecisions(msgs, [human]);
  assert.equal(out.raise.length, 9);
  assert.ok(!out.raise.some((q) => /deploys need a ticket/.test(q)));
});

test('failure 4: two messages in the same millisecond each get their own marker and both are raised', () => {
  const a = { ts: at(0), text: 'always squash merge feature branches' };
  const b = { ts: at(0), text: 'never force push shared branches' };
  assert.notEqual(hitMarker(a), hitMarker(b));
  const first = unledgeredDecisions([a, b], []);
  assert.equal(first.raise.length, 2);
  assert.equal(unledgeredDecisions([a, b], [askFor(a)]).raise.length, 1);
});

test('a decision message that carries a secret shape is withheld, not quoted', () => {
  const key = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
  const [q] = unledgeredDecisions([{ ts: at(0), text: `always use this key ${key}` }], []).raise;
  assert.match(q, /withheld/);
  assert.ok(!q.includes(key));
});

test('dirtyPaths reads porcelain -z: renames consume their source, deletions are dropped', () => {
  assert.deepEqual(dirtyPaths(' M a.ts\0?? b/c.ts\0R  new.ts\0old.ts\0 D gone.ts\0'), ['a.ts', 'b/c.ts', 'new.ts']);
});

function repoWithDirt(): { container: string; wt: string } {
  const container = mkdtempSync(join(tmpdir(), 'cr-'));
  const wt = join(container, '.worktrees', 'w1');
  mkdirSync(wt, { recursive: true });
  const git = (...a: string[]): void => { assert.equal(spawnSync('git', ['-C', wt, ...a], { encoding: 'utf8' }).status, 0); };
  git('init', '-q');
  writeFileSync(join(wt, 'tracked.ts'), 'export const a = 1;\n');
  git('add', 'tracked.ts');
  git('-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'init');
  writeFileSync(join(wt, 'tracked.ts'), 'export const a = 2;\n');
  writeFileSync(join(wt, 'new.ts'), 'export const b = 1;\n');
  writeFileSync(join(wt, '.env.local'), 'X=1\n');
  writeFileSync(join(wt, 'leak.txt'), `token ${['AKIA', 'ABCDEFGHIJKLMNOP'].join('')}\n`);
  return { container, wt };
}

test('snapshotDirty copies modified and untracked source, skips secret names and secret shapes, and is idempotent', () => {
  const { container } = repoWithDirt();
  const dest = join(container, 'snap');
  const r = snapshotDirty(container, dest);
  assert.deepEqual({ worktrees: r.worktrees, files: r.files, skipped: r.skipped }, { worktrees: 1, files: 2, skipped: 2 });
  assert.equal(readFileSync(join(dest, 'w1', 'tracked.ts'), 'utf8'), 'export const a = 2;\n');
  assert.ok(existsSync(join(dest, 'w1', 'new.ts')));
  assert.ok(!existsSync(join(dest, 'w1', '.env.local')) && !existsSync(join(dest, 'w1', 'leak.txt')));
  assert.equal(snapshotDirty(container, dest).files, 2);
  assert.equal(readFileSync(join(container, '.gitignore'), 'utf8').trim(), '*', 'the folder holding the dated snapshots ignores itself');
});

test('snapshotDirty is an allowlist: dotfiles, config files and symlinks (including into an env store) never leave the worktree', () => {
  const { container, wt } = repoWithDirt();
  for (const [f, body] of [['.envrc', 'export APP_SECRET hunter2hunter2\n'], ['.netrc', 'machine h login u password p4ssw0rd\n'], ['.pgpass', 'h:5432:db:u:p4ssw0rd\n'], ['secrets.json', '{"k":"v"}\n'], ['app.conf', 'x=1\n']]) writeFileSync(join(wt, f), body);
  const store = mkdtempSync(join(tmpdir(), 'store-'));
  writeFileSync(join(store, 'app.pgpass'), 'h:5432:db:u:p4ssw0rd\n');
  writeFileSync(join(store, 'real.ts'), 'export const secret = 1;\n');
  symlinkSync(join(store, 'app.pgpass'), join(wt, 'local-db.conf'));
  symlinkSync(join(store, 'real.ts'), join(wt, 'linked.ts'));
  symlinkSync(store, join(wt, 'linkdir'));
  const dest = join(container, 'snap');
  const r = snapshotDirty(container, dest);
  assert.equal(r.files, 2, 'only tracked.ts and new.ts');
  for (const f of ['.envrc', '.netrc', '.pgpass', 'secrets.json', 'app.conf', 'local-db.conf', 'linked.ts', 'linkdir']) assert.ok(!existsSync(join(dest, 'w1', f)), f);
});

test('snapshotDirty stops at its deadline and says so', () => {
  const { container } = repoWithDirt();
  const r = snapshotDirty(container, join(container, 'snap'), Date.now(), Date.now() - 1);
  assert.deepEqual({ files: r.files, partial: r.partial }, { files: 0, partial: true });
});

test('snapshotDirty leaves a worktree whose dirt is older than 72 hours', () => {
  const { container, wt } = repoWithDirt();
  const old = new Date(Date.now() - 100 * 3_600_000);
  for (const f of ['tracked.ts', 'new.ts', '.env.local', 'leak.txt']) utimesSync(join(wt, f), old, old);
  assert.equal(snapshotDirty(container, join(container, 'snap')).worktrees, 0);
});

test('newestHandoff prefers the generated_at marker and falls back to mtime', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ho-'));
  assert.equal(newestHandoff(dir), null);
  writeFileSync(join(dir, 'HANDOFF-2026-10-09-all.md'), `---\ngenerated_at: ${at(0)}\n---\n`);
  writeFileSync(join(dir, 'HANDOFF-2026-10-09b-all.md'), `---\ngenerated_at: ${at(30)}\n---\n`);
  assert.deepEqual(newestHandoff(dir), { name: 'HANDOFF-2026-10-09b-all.md', at: at(30) });
});

test('continuityLines: silent with no marker or a fresh handoff, loud on an incomplete marker or a stale handoff', () => {
  const work = { kind: 'wip', ts: at(10), text: 'work' };
  const mark = { kind: 'note', ts: at(20), text: 'precompact: handoff delta written' };
  assert.deepEqual(continuityLines([work], null), []);
  assert.deepEqual(continuityLines([work, mark], { name: 'h.md', at: at(15) }), []);
  const stale = continuityLines([work, mark], { name: 'h.md', at: at(5) });
  assert.match(stale[0], /^!! HANDOFF STALE: the newest handoff \(h\.md/);
  assert.match(continuityLines([work, mark], null)[0], /there is no handoff/);
  const raised = { kind: 'question', ts: at(19), used: ['hook:precompact'], text: 'unledgered decision? x' };
  assert.deepEqual(continuityLines([work, raised, mark], { name: 'h.md', at: at(15) }), [], 'asks the hook raised after its handoff are not missed work');
  const bad = { kind: 'note', ts: at(20), text: 'precompact incomplete: handoff: boom (trigger auto)' };
  const lines = continuityLines([work, bad], { name: 'h.md', at: at(15) });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^!! precompact incomplete: handoff: boom/);
  const healed = [work, bad, { kind: 'note', ts: at(30), text: 'precompact: handoff delta written' }];
  assert.deepEqual(continuityLines(healed, { name: 'h.md', at: at(29) }), []);
});

test('every pending decision is raised, oldest first, ten per run; the overflow is counted and taken by the next run', () => {
  const msgs = Array.from({ length: 13 }, (_, n) => ({ ts: at(n), text: `from now on rule number ${n} applies` }));
  const first = unledgeredDecisions(msgs, []);
  assert.equal(first.raise.length, 10);
  assert.equal(first.pending, 3);
  assert.match(first.raise[0], /rule number 0 /);
  const rows = first.raise.map((q, n) => ({ kind: 'question', ts: at(100 + n), text: q }));
  const second = unledgeredDecisions(msgs, rows);
  assert.deepEqual({ n: second.raise.length, pending: second.pending }, { n: 3, pending: 0 });
  assert.match(second.raise[0], /rule number 10 /);
});

test('another session compacting first cannot hide this transcript: there is no time cutoff, only the per-message marker', () => {
  const mine = [{ ts: at(0), text: 'from now on session B decides this' }];
  const otherSessionMark = { kind: 'note', ts: at(5), text: 'precompact: handoff written, 0 file(s) snapshotted from 0 worktree(s), 0 unledgered decision(s) raised (trigger auto, session aaaa1111)' };
  assert.equal(unledgeredDecisions(mine, [otherSessionMark]).raise.length, 1);
});

test('errorLine picks the Error line of a crashed child, not the Node banner', () => {
  assert.equal(errorLine('file:///x.ts:3\nthrow new Error("bad");\n^\n\nError: boom happened\n    at x\n\nNode.js v24.18.0\n'), 'Error: boom happened');
  assert.equal(errorLine('handoff suffixes b..z for 2026-10-09 are used up; start a fresh session.\n'), 'handoff suffixes b..z for 2026-10-09 are used up; start a fresh session.');
  assert.equal(errorLine(''), '');
});

test('a snapshot that hits the file cap says capped', () => {
  const { container, wt } = repoWithDirt();
  for (let n = 0; n < 305; n++) writeFileSync(join(wt, `gen${n}.ts`), `export const n${n} = ${n};\n`);
  const r = snapshotDirty(container, join(container, 'snap'));
  assert.deepEqual({ files: r.files, capped: r.capped, partial: r.partial }, { files: 300, capped: true, partial: false });
});

test('a started row with no result of its own run stays loud: a newer handoff, or another session finishing, does not clear it', () => {
  const work = { kind: 'wip', ts: at(10), text: 'work' };
  const startedA = { kind: 'note', ts: at(20), text: 'precompact started (trigger auto, session aaaa1111)' };
  const startedB = { kind: 'note', ts: at(21), text: 'precompact started (trigger auto, session bbbb2222)' };
  const doneB = { kind: 'note', ts: at(22), text: 'precompact: handoff written, 0 file(s) snapshotted from 0 worktree(s), 0 unledgered decision(s) raised (trigger auto, session bbbb2222)' };
  assert.match(continuityLines([work, startedA], { name: 'h.md', at: at(5) })[0], /precompact started .*aaaa1111.* never finished/);
  assert.match(continuityLines([work, startedA], { name: 'h.md', at: at(21) })[0], /never finished/, 'the hook\'s own handoff is written before the snapshot, so it proves nothing');
  const mixed = continuityLines([work, startedA, startedB, doneB], { name: 'h.md', at: at(21.5) });
  assert.equal(mixed.length, 1);
  assert.match(mixed[0], /aaaa1111/);
  const doneA = { kind: 'note', ts: at(23), text: 'precompact incomplete: snapshot: boom (trigger auto, session aaaa1111)' };
  assert.equal(continuityLines([work, startedA, startedB, doneB, doneA], { name: 'h.md', at: at(21.5) }).every((l) => !/never finished/.test(l)), true);
  const ack = { kind: 'note', ts: at(24), text: 'precompact ack' };
  assert.deepEqual(continuityLines([work, startedA, ack], null), []);
});

test('rows other writers add while the hook runs are not missed work', () => {
  const work = { kind: 'wip', ts: at(10), text: 'work' };
  const started = { kind: 'note', ts: at(20), text: 'precompact started (trigger auto, session aaaa1111)' };
  const lateWriter = { kind: 'wip', ts: at(21), text: 'another agent logged during the hook' };
  const done = { kind: 'note', ts: at(22), text: 'precompact: handoff written (trigger auto, session aaaa1111)' };
  assert.deepEqual(continuityLines([work, started, lateWriter, done], { name: 'h.md', at: at(20.5) }), []);
});

test('an incomplete row clears on a newer handoff only when the handoff step failed; other failures need an ack', () => {
  const work = { kind: 'wip', ts: at(10), text: 'work' };
  const ho = { kind: 'note', ts: at(20), text: 'precompact incomplete: handoff: boom (trigger auto)' };
  const sn = { kind: 'note', ts: at(20), text: 'precompact incomplete: snapshot: boom (trigger auto)' };
  assert.equal(continuityLines([work, ho], { name: 'h.md', at: at(15) }).length, 1);
  assert.deepEqual(continuityLines([work, ho], { name: 'h.md', at: at(25) }), []);
  const kept = continuityLines([work, sn], { name: 'h.md', at: at(25) });
  assert.match(kept[0], /A handoff does not fix this; dismiss with `journal\.ts log "precompact ack"/);
  assert.deepEqual(continuityLines([work, sn, { kind: 'note', ts: at(26), text: 'precompact ack' }], { name: 'h.md', at: at(25) }), []);
});

test('30 recent decisions converge to all raised exactly once across runs', () => {
  const msgs = Array.from({ length: 30 }, (_, n) => msg(n));
  const rows: ReturnType<typeof askFor>[] = [];
  for (let pass = 0; pass < 6; pass++) {
    const { raise, pending } = unledgeredDecisions(msgs, rows);
    raise.forEach((q, n) => rows.push({ kind: 'question', ts: at(31 + pass), text: q, used: ['hook:precompact', String(n)] }));
    if (!pending) break;
  }
  assert.equal(rows.length, 30);
  assert.equal(new Set(rows.map((r) => r.text)).size, 30);
  assert.equal(unledgeredDecisions(msgs, rows).raise.length, 0);
});

test('two sessions: session A raising asks does not hide session B\'s decision', () => {
  const a = [msg(0, 'from now on A decides this')];
  const b = [msg(1, 'from now on B decides this')];
  const raisedA = unledgeredDecisions(a, []).raise.map((q) => ({ kind: 'question', ts: at(2), text: q, used: ['hook:precompact'] }));
  assert.equal(unledgeredDecisions(b, raisedA).raise.length, 1);
});

test('an incomplete row from one session survives another session succeeding, and clears only on its own success or an ack', () => {
  const work = { kind: 'wip', ts: at(10), text: 'work' };
  const badA = { kind: 'note', ts: at(20), text: 'precompact incomplete: decisions: EACCES (trigger auto, session aaaa1111)' };
  const okB = { kind: 'note', ts: at(21), text: 'precompact: handoff written, 0 file(s) snapshotted from 0 worktree(s), 0 unledgered decision(s) raised (trigger auto, session bbbb2222)' };
  const shown = continuityLines([work, badA, okB], { name: 'h.md', at: at(25) });
  assert.equal(shown.length, 1);
  assert.match(shown[0], /decisions: EACCES .*aaaa1111/);
  const okA = { kind: 'note', ts: at(22), text: 'precompact: handoff written (trigger auto, session aaaa1111)' };
  assert.deepEqual(continuityLines([work, badA, okB, okA], { name: 'h.md', at: at(25) }), []);
  assert.deepEqual(continuityLines([work, badA, okB, { kind: 'note', ts: at(23), text: 'precompact ack' }], { name: 'h.md', at: at(25) }), []);
});
