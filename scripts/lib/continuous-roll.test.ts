import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { continuityLines, isAllScopeHandoff, dirtyPaths, errorLine, handoffFresh, hitMarker, newestHandoff, snapshotDirty, unledgeredDecisions, userMessages } from './continuous-roll.ts';

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

const asRows = (raise: string[], minute = 100) => raise.map((q, n) => ({ kind: 'question', ts: at(minute + n), text: q, used: ['hook:precompact'] }));

test('a decision is handled only by its own marker; no rule, decision or learned row hides it, however much it resembles the message', () => {
  const m = { ts: at(0), text: 'from now on never merge without a green suite' };
  assert.equal(unledgeredDecisions([m], []).count, 1);
  assert.equal(unledgeredDecisions([m], [askFor(m)]).count, 0, 'its own marker');
  for (const kind of ['rule', 'decision', 'learned']) assert.equal(unledgeredDecisions([m], [{ kind, ts: at(5), text: 'never merge without a green suite: the suite must pass first' }]).count, 1, kind);
});

test('a recorded decision does not hide its own reversal, and a develop rule does not hide a staging decision', () => {
  const rule = { kind: 'decision', ts: at(1), text: 'a staging PR merges only after its develop twin merged', approval: 'standing' };
  const reversal = { ts: at(10), text: 'from now on a staging PR merges only before its develop twin merged' };
  assert.equal(unledgeredDecisions([reversal], [rule]).count, 1);
  const develop = { kind: 'decision', ts: at(1), text: 'from now on develop PRs need a green suite before merge' };
  const staging = { ts: at(11), text: 'from now on staging PRs need a green suite before merge' };
  assert.equal(unledgeredDecisions([staging], [develop]).count, 1);
});

test('failure 1: two decisions, then an unrelated orchestrator ask, are both still raised', () => {
  const msgs = [msg(0, 'from now on never push to main'), msg(1, 'always open drafts first')];
  const unrelated = { kind: 'question', ts: at(5), text: 'Which model should the review use?' };
  assert.equal(unledgeredDecisions(msgs, [unrelated]).count, 2);
});

test('failure 2: resolving one raised ask does not stop the rest of 25 decisions', () => {
  const msgs = Array.from({ length: 25 }, (_, n) => msg(n));
  const first = unledgeredDecisions(msgs, []);
  assert.deepEqual({ asks: first.raise.length, count: first.count }, { asks: 2, count: 25 });
  const rows = [...asRows(first.raise.slice(0, 1)), { kind: 'resolved', ts: at(101), text: 'answered the first ask' }];
  assert.deepEqual(unledgeredDecisions(msgs, rows).count, 5, 'only the second batch is still unhandled');
});

test('failure 3: one human decision row hides nothing', () => {
  const msgs = [msg(0, 'from now on deploys need a ticket reference'), ...Array.from({ length: 9 }, (_, n) => msg(n + 1))];
  const human = { kind: 'decision', ts: at(2), text: 'deploys need a ticket reference from now on' };
  assert.equal(unledgeredDecisions(msgs, [human]).count, 10);
});

test('failure 4: two messages in the same millisecond each get their own marker and both are raised', () => {
  const a = { ts: at(0), text: 'always squash merge feature branches' };
  const b = { ts: at(0), text: 'never force push shared branches' };
  assert.notEqual(hitMarker(a), hitMarker(b));
  const first = unledgeredDecisions([a, b], []);
  assert.equal(first.count, 2);
  assert.equal(unledgeredDecisions([a, b], [askFor(a)]).count, 1);
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
  const again = snapshotDirty(container, dest);
  assert.deepEqual({ copied: again.copied, current: again.current }, { copied: 0, current: 2 }, 'a second run copies nothing: the bytes are already there');
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

test('newestHandoff(dir, true) ignores a newer single-stream or custom handoff, since only --all covers the whole ledger', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ho-'));
  writeFileSync(join(dir, 'HANDOFF-2026-10-09-all.md'), `---\ngenerated_at: ${at(0)}\n---\n`);
  writeFileSync(join(dir, 'HANDOFF-2026-10-09-options.md'), `---\ngenerated_at: ${at(30)}\n---\n`);
  writeFileSync(join(dir, 'HANDOFF-eod.md'), `---\ngenerated_at: ${at(40)}\n---\n`);
  assert.equal(newestHandoff(dir)?.name, 'HANDOFF-eod.md', 'the plain read still sees every scope');
  assert.deepEqual(newestHandoff(dir, true), { name: 'HANDOFF-2026-10-09-all.md', at: at(0) });
  writeFileSync(join(dir, 'HANDOFF-2026-10-09-precompact-win1.md'), `---\ngenerated_at: ${at(50)}\n---\n`);
  assert.equal(newestHandoff(dir, true)?.name, 'HANDOFF-2026-10-09-precompact-win1.md');
  assert.deepEqual(['HANDOFF-2026-10-09b-all.md', 'HANDOFF-2026-10-09-precompact-w.md'].map(isAllScopeHandoff), [true, true]);
  assert.deepEqual(['HANDOFF-2026-10-09-Options.md', 'HANDOFF-2026-10-09-allies.md'].map(isAllScopeHandoff), [false, false]);
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

test('every pending decision is raised in one run, oldest first, 20 per ask row', () => {
  const msgs = Array.from({ length: 45 }, (_, n) => msg(n));
  const out = unledgeredDecisions(msgs, []);
  assert.deepEqual(out.raise.map((q) => /^unledgered decision\? \((\d+)\)/.exec(q)?.[1]), ['20', '20', '5']);
  assert.match(out.raise[0], /rule number 0 applies/);
  assert.equal(unledgeredDecisions(msgs, asRows(out.raise)).count, 0, 'a second run raises nothing');
});

test('another session compacting first cannot hide this transcript: there is no time cutoff, only the per-message marker', () => {
  const mine = [{ ts: at(0), text: 'from now on session B decides this' }];
  const otherSessionMark = { kind: 'note', ts: at(5), text: 'precompact: handoff written, 0 file(s) snapshotted from 0 worktree(s), 0 unledgered decision(s) raised (trigger auto, session aaaa1111)' };
  assert.equal(unledgeredDecisions(mine, [otherSessionMark]).count, 1);
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

test('after /clear the next run, from a fresh transcript read of the same file, raises nothing twice and loses nothing', () => {
  const msgs = Array.from({ length: 25 }, (_, n) => msg(n));
  const rows = asRows(unledgeredDecisions(msgs, []).raise);
  assert.equal(unledgeredDecisions(msgs, rows).count, 0);
  const more = [...msgs, msg(26), msg(27)];
  assert.equal(unledgeredDecisions(more, rows).count, 2, 'only the new decisions');
});

test('two sessions: session A raising asks does not hide session B\'s decision', () => {
  const a = [msg(0, 'from now on A decides this')];
  const b = [msg(1, 'from now on B decides this')];
  assert.equal(unledgeredDecisions(b, asRows(unledgeredDecisions(a, []).raise)).count, 1);
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

test('handoffFresh ignores precompact markers and hook or loop rows, flags a later normal row, and handles a missing handoff', () => {
  const work = { kind: 'note', ts: at(0), text: 'work' };
  const hook = { kind: 'question', ts: at(20), text: 'asks', used: ['hook:precompact'] };
  const loop = { kind: 'note', ts: at(21), text: 'tick', used: ['loop:continuity'] };
  const mark = { kind: 'note', ts: at(22), text: 'precompact: all current (trigger auto, session aaaa1111)' };
  const handoff = { name: 'h.md', at: at(10) };
  assert.deepEqual(handoffFresh([work, hook, loop, mark], handoff), { fresh: true, behindMs: 0, lastRowTs: at(0) });
  const later = { kind: 'note', ts: at(25), text: 'more work' };
  const stale = handoffFresh([work, hook, mark, later], handoff);
  assert.deepEqual({ fresh: stale.fresh, behindMs: stale.behindMs, lastRowTs: stale.lastRowTs }, { fresh: false, behindMs: 15 * 60_000, lastRowTs: at(25) });
  assert.deepEqual(handoffFresh([work], null), { fresh: false, behindMs: Infinity, lastRowTs: at(0) });
  assert.deepEqual(handoffFresh([], handoff), { fresh: true, behindMs: 0, lastRowTs: null });
  assert.equal(handoffFresh([work], { name: 'h.md', at: at(0) }).fresh, true, 'generated at the same instant as the row counts as covering it');
});

test('snapshotDirty run twice copies nothing the second time and reports the files as current', () => {
  const { container } = repoWithDirt();
  const dest = join(container, 'snaps', '2026-10-09');
  const first = snapshotDirty(container, dest);
  assert.deepEqual({ copied: first.copied, files: first.files, current: first.current }, { copied: 2, files: 2, current: 0 });
  const second = snapshotDirty(container, dest);
  assert.deepEqual({ copied: second.copied, files: second.files, current: second.current }, { copied: 0, files: 0, current: 2 });
});

test('snapshotDirty recopies a file that changed since the last snapshot', () => {
  const { container, wt } = repoWithDirt();
  const dest = join(container, 'snaps', '2026-10-09');
  snapshotDirty(container, dest);
  writeFileSync(join(wt, 'new.ts'), 'export const b = 22;\n');
  const r = snapshotDirty(container, dest);
  assert.deepEqual({ copied: r.copied, current: r.current }, { copied: 1, current: 1 });
  assert.equal(readFileSync(join(dest, 'w1', 'new.ts'), 'utf8'), 'export const b = 22;\n');
});

test('snapshotDirty counts a copy in the previous UTC date dir as current and writes nothing new', () => {
  const { container } = repoWithDirt();
  const yesterday = join(container, 'snaps', '2026-10-08');
  snapshotDirty(container, yesterday);
  const today = join(container, 'snaps', '2026-10-09');
  const r = snapshotDirty(container, today);
  assert.deepEqual({ copied: r.copied, current: r.current }, { copied: 0, current: 2 });
  assert.ok(!existsSync(join(today, 'w1', 'new.ts')));
});

test('snapshotDirty: a file reverted to yesterday\'s bytes after a same-day edit is recopied, so today\'s dir holds the newest version', () => {
  const { container, wt } = repoWithDirt();
  const yesterday = join(container, 'snaps', '2026-10-08');
  const today = join(container, 'snaps', '2026-10-09');
  const original = readFileSync(join(wt, 'new.ts'), 'utf8');
  snapshotDirty(container, yesterday);
  writeFileSync(join(wt, 'new.ts'), 'export const b = 22;\n');
  snapshotDirty(container, today);
  writeFileSync(join(wt, 'new.ts'), original);
  const r = snapshotDirty(container, today);
  assert.equal(r.copied, 1, 'the revert differs from today\'s copy, so it is copied');
  assert.equal(readFileSync(join(today, 'w1', 'new.ts'), 'utf8'), original);
});
