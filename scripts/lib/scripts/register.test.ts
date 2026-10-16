// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/lib/scripts/register.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../journal/store.ts';
import { askText, registerScript } from './register.ts';
import { recordRan, scriptsPath } from './registry.ts';
import type { NewScript } from './registry.ts';
import { buildScriptViews, markRefusal } from './view.ts';

const T0 = new Date('2026-10-15T15:00:00Z');
const SCRIPT: NewScript = { kind: 'one-time', title: 'Close ticket 12', what: 'Closes one vault ticket.', why: 'The agent cannot write the vault.', after: 'The ticket is closed.', blocks: 'abcd', blockedBy: 'repo-worker: close ticket', command: 'echo hello' };

function rig() {
  const vault = mkdtempSync(join(tmpdir(), 'scripts-register-'));
  const store = openStore({ vault, project: 'p', dryRun: false, warn: () => {}, window: undefined });
  const views = () => buildScriptViews({ vault, project: 'p', ledger: store.readLedger(), registry: store.loadRegistry() });
  const register = (s: NewScript = SCRIPT, now = T0) => registerScript({ store, vault, project: 'p', script: s, now, today: now.toISOString().slice(0, 10) });
  const closeAsk = (id: string, kind = 'resolved') => store.append({ id: store.newId(store.readLedger()), ts: T0.toISOString(), date: '2026-10-15', kind, closes: id, text: 'closed' });
  return { vault, store, views, register, closeAsk };
}

test('registering writes the block file, a run-this ask that names the script, and the entry, in that order of dependence', () => {
  const r = rig();
  const out = r.register();
  assert.ok(out.ok && out.created);
  if (!out.ok) return;
  const ask = r.store.readLedger().find((row) => row.id === out.entry.ask);
  assert.equal(ask?.kind, 'question');
  assert.equal(ask?.box, 'paste');
  assert.equal(ask?.script, out.entry.id);
  assert.equal(readFileSync(String(ask?.paste), 'utf8'), 'echo hello\n', 'the ask points at the block file, which holds exactly the command');
  assert.equal(ask?.recommend, undefined, 'a run-this ask takes none of the decision fields');
  assert.match(String(ask?.text), /^Run this script: Close ticket 12\n/);
  for (const part of ['**What it does:** Closes one vault ticket.', '**Why we need it:** The agent cannot write the vault. (blocks abcd)', '**After it runs:** The ticket is closed.', '**Blocked:** repo-worker: close ticket']) assert.ok(String(ask?.text).includes(part), part);
  assert.equal(r.views()[0]?.status, 'blocked');
});

test('a refused entry writes nothing at all', () => {
  const r = rig();
  const out = r.register({ ...SCRIPT, command: 'printenv' });
  assert.equal(out.ok, false);
  assert.equal(r.store.readLedger().length, 0);
  assert.equal(existsSync(scriptsPath(r.vault, 'p')), false);
});

test('registering twice while it still waits returns the same entry and raises no second ask', () => {
  const r = rig();
  const a = r.register();
  const b = r.register({ ...SCRIPT, what: 'reworded' });
  assert.ok(a.ok && b.ok && a.entry.id === b.entry.id && !b.created);
  assert.equal(r.store.readLedger().filter((row) => row.kind === 'question').length, 1);
});

test('a one-time script whose ask has closed is History, and registering it again starts a new round', () => {
  const r = rig();
  const a = r.register();
  assert.ok(a.ok);
  if (!a.ok) return;
  r.closeAsk(a.entry.ask);
  const [v] = r.views();
  assert.equal(v?.status, 'history');
  assert.equal(v?.askOpen, false);
  assert.match(markRefusal(v!) ?? '', /already finished/);
  const again = r.register();
  assert.ok(again.ok && again.created && again.entry.id !== a.entry.id);
  assert.deepEqual(r.views().map((x) => x.status), ['blocked', 'history']);
});

test('a reusable script stays listed after its ask closes, keeps its last run, and is registered once however often it is asked for', () => {
  const r = rig();
  const a = r.register({ ...SCRIPT, kind: 'reusable' });
  assert.ok(a.ok);
  if (!a.ok) return;
  r.closeAsk(a.entry.ask);
  assert.equal(r.views()[0]?.status, 'reusable');
  assert.equal(markRefusal(r.views()[0]!), null, 'a reusable script may be marked run as often as it runs');
  recordRan({ vault: r.vault, project: 'p', id: a.entry.id, result: 'done', via: 'podium', now: new Date('2026-10-16T09:00:00Z') });
  recordRan({ vault: r.vault, project: 'p', id: a.entry.id, result: 'failed', via: 'cli', now: new Date('2026-10-17T09:00:00Z') });
  const v = r.views()[0]!;
  assert.deepEqual([v.status, v.runs, v.lastRun], ['reusable', 2, { at: '2026-10-17T09:00:00.000Z', result: 'failed', via: 'cli' }]);
  const again = r.register({ ...SCRIPT, kind: 'reusable' });
  assert.ok(again.ok && !again.created && again.entry.id === a.entry.id);
});

test('the Podium\'s own run rows for the ask count as the last run, and the newest of both sources wins', () => {
  const r = rig();
  const a = r.register();
  assert.ok(a.ok);
  if (!a.ok) return;
  r.store.append({ id: r.store.newId(r.store.readLedger()), ts: '2026-10-15T16:00:00.000Z', date: '2026-10-15', kind: 'run', runSource: 'ask', runTarget: a.entry.ask, status: 'done', exitCode: 0, text: 'Podium ran ask' });
  r.store.append({ id: r.store.newId(r.store.readLedger()), ts: '2026-10-15T16:05:00.000Z', date: '2026-10-15', kind: 'run', runSource: 'ask', runTarget: 'zzzz', status: 'failed', exitCode: 1, text: 'another ask' });
  assert.deepEqual(r.views()[0]?.lastRun, { at: '2026-10-15T16:00:00.000Z', result: 'done', via: 'podium' });
  recordRan({ vault: r.vault, project: 'p', id: a.entry.id, result: 'done', via: 'podium', now: new Date('2026-10-15T17:00:00Z') });
  assert.deepEqual(r.views()[0]?.lastRun, { at: '2026-10-15T17:00:00.000Z', result: 'done', via: 'marked' });
});

test('views come blocked first (longest wait first), then reusable by title, then history newest first', () => {
  const r = rig();
  const ids = (['B first', 'A second'] as const).map((t, i) => { const o = r.register({ ...SCRIPT, title: t, command: `echo ${t}` }, new Date(T0.getTime() + i * 1000)); assert.ok(o.ok); return o.ok ? o.entry : null; });
  const reu = r.register({ ...SCRIPT, kind: 'reusable', title: 'Z reusable', command: 'echo z' });
  const reu2 = r.register({ ...SCRIPT, kind: 'reusable', title: 'M reusable', command: 'echo m' });
  assert.ok(reu.ok && reu2.ok);
  if (reu.ok) r.closeAsk(reu.entry.ask);
  if (reu2.ok) r.closeAsk(reu2.entry.ask);
  r.closeAsk(ids[0]!.ask);
  assert.deepEqual(r.views().map((v) => v.title), ['A second', 'M reusable', 'Z reusable', 'B first']);
});

test('the ask text names the kind and the way to run it', () => {
  assert.match(askText({ ...SCRIPT, kind: 'reusable' }), /This is a reusable script\. Review the command on the Scripts tab/);
});

test('an entry edited to name another ask cannot close it: the ask must name the script and its block file', () => {
  const r = rig();
  const a = r.register();
  assert.ok(a.ok);
  if (!a.ok) return;
  const other = r.store.append({ id: r.store.newId(r.store.readLedger()), ts: T0.toISOString(), date: '2026-10-15', kind: 'question', text: 'An unrelated ask' });
  const file = scriptsPath(r.vault, 'p');
  writeFileSync(file, readFileSync(file, 'utf8').replace(`"ask":"${a.entry.ask}"`, `"ask":"${other.id}"`));
  assert.equal(r.views()[0]?.askOpen, false);
  assert.equal(r.views()[0]?.status, 'history');
});
