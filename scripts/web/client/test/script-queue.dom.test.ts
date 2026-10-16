// Run: node --test scripts/web/client/test/script-queue.dom.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, mount } from './dom-harness.ts';
import type { MarkOutcome, ScriptActions, ScriptRow } from '../src/scripts-api.ts';

installDom();
const { clearScriptQueueState, targetOf } = await import('../src/script-queue.ts');
type Queue = HTMLElement & { actions: ScriptActions; loader: () => Promise<ScriptRow[] | null>; refresh(): Promise<void> };
const wait = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

const row = (over: Partial<ScriptRow>): ScriptRow => ({ id: 'sc-00000001', kind: 'one-time', title: 'Close ticket 12', what: 'Closes one vault ticket.', why: 'The agent cannot write the vault.', after: 'The ticket is closed.', blocks: 'abcd', command: 'node ticket.mjs close 12', createdAt: '2026-10-15T15:00:00.000Z', ask: 'ab12', status: 'blocked', askOpen: true, runs: 0, ...over });
const BLOCKED = row({ blockedBy: 'repo-worker: close ticket' });
const REUSABLE = row({ id: 'sc-00000002', kind: 'reusable', title: 'Refresh cache', status: 'reusable', askOpen: false, ask: 'cd34', runs: 2, lastRun: { at: '2026-10-16T09:00:00.000Z', result: 'done', via: 'marked' }, command: 'echo refresh' });
const DONE = row({ id: 'sc-00000003', title: 'Old one', status: 'history', askOpen: false, ask: 'ef56', runs: 1, lastRun: { at: '2026-10-14T09:00:00.000Z', result: 'failed', via: 'podium' }, command: 'echo old' });

function fakeActions(out: MarkOutcome = { ok: true, resolvedAsk: true }): { actions: ScriptActions; marked: string[] } {
  const marked: string[] = [];
  return { marked, actions: { markRan: async (id: string) => { marked.push(id); return out; } } };
}
const view = async (rows: ScriptRow[] | null, actions: ScriptActions = fakeActions().actions) => { clearScriptQueueState(); const m = await mount<Queue>('../src/script-queue.ts', 'script-queue', { actions, loader: async () => rows }); await wait(); return m; };
const names = (root: ParentNode): string[] => [...root.querySelectorAll('h3.group-name')].map((n) => n.textContent ?? '');

test('sections come in order: Blocked on you, Reusable, then a collapsed History', async () => {
  const { root, cleanup } = await view([BLOCKED, REUSABLE, DONE]);
  assert.deepEqual(names(root), ['Blocked on you (1)', 'Reusable (1)']);
  const history = root.querySelector('details.history') as HTMLDetailsElement;
  assert.equal(history.open, false);
  assert.match(history.querySelector('summary')!.textContent ?? '', /History \(1\)/);
  assert.deepEqual([...root.querySelectorAll('article h4')].map((n) => n.textContent), ['Close ticket 12', 'Refresh cache', 'Old one']);
  cleanup();
});

test('a card shows what, why, after and who was blocked up front, and the command verbatim in a code block', async () => {
  const { root, cleanup } = await view([BLOCKED]);
  const dts = [...root.querySelectorAll('dt')].map((n) => n.textContent);
  const dds = [...root.querySelectorAll('dd')].map((n) => n.textContent);
  assert.deepEqual(dts, ['What it does', 'Why we need it', 'After it runs', 'Blocked']);
  assert.deepEqual(dds, ['Closes one vault ticket.', 'The agent cannot write the vault. (blocks abcd)', 'The ticket is closed.', 'repo-worker: close ticket']);
  assert.equal(root.querySelector('pre code')!.textContent, 'node ticket.mjs close 12');
  assert.equal(root.querySelector('.badge')!.textContent, 'one-time');
  assert.match(root.querySelector('article')!.textContent ?? '', /Not run yet/);
  cleanup();
});

test('a blocked card links to its ask in Needs you', async () => {
  const { root, cleanup } = await view([BLOCKED]);
  const a = root.querySelector('p.meta a') as HTMLAnchorElement;
  assert.equal(a.textContent, 'ab12');
  assert.equal(a.getAttribute('href'), '#tab=dashboard&show=asks');
  cleanup();
});

test('the command is text, never markup', async () => {
  const { root, cleanup } = await view([row({ command: '<img src=x onerror=alert(1)>; echo "<b>"' })]);
  assert.equal(root.querySelector('pre img'), null);
  assert.equal(root.querySelector('pre code')!.textContent, '<img src=x onerror=alert(1)>; echo "<b>"');
  cleanup();
});

test('Copy command puts exactly the shown command on the clipboard', async () => {
  const copied: string[] = [];
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (t: string) => { copied.push(t); } } }, configurable: true });
  const { root, cleanup } = await view([BLOCKED]);
  (root.querySelector('button.secondary') as HTMLButtonElement).click();
  await wait();
  assert.deepEqual(copied, ['node ticket.mjs close 12']);
  assert.equal(root.querySelector('.msg')!.textContent, 'Copied.');
  cleanup();
});

test('Mark done sends the script id, says what happened, and reloads the list', async () => {
  const f = fakeActions();
  let rows = [BLOCKED];
  clearScriptQueueState();
  const { root, cleanup } = await mount<Queue>('../src/script-queue.ts', 'script-queue', { actions: f.actions, loader: async () => rows });
  await wait();
  const mark = root.querySelector('button.primary') as HTMLButtonElement;
  assert.equal(mark.textContent, 'Mark done (I ran it)');
  rows = [{ ...BLOCKED, status: 'history', askOpen: false, runs: 1, lastRun: { at: '2026-10-15T16:00:00.000Z', result: 'done', via: 'marked' } }];
  mark.click();
  await wait(30);
  assert.deepEqual(f.marked, [BLOCKED.id]);
  assert.deepEqual(names(root), ['Blocked on you (0)', 'Reusable (0)']);
  assert.equal(root.querySelector('.msg')!.textContent, 'Recorded. The ask is resolved.');
  assert.match(root.querySelector('details.history')!.textContent ?? '', /marked done by you/);
  cleanup();
});

test('a refused mark shows the server\'s message and the card stays blocked', async () => {
  const { root, cleanup } = await view([BLOCKED], fakeActions({ ok: false, message: 'The page is being rebuilt. Try again in a moment.' }).actions);
  (root.querySelector('button.primary') as HTMLButtonElement).click();
  await wait(30);
  assert.equal(root.querySelector('.msg')!.textContent, 'The page is being rebuilt. Try again in a moment.');
  assert.equal(names(root)[0], 'Blocked on you (1)');
  cleanup();
});

test('a reusable card stays listed with its last run and offers Mark run; History offers neither action', async () => {
  const { root, cleanup } = await view([REUSABLE, DONE]);
  const reusable = root.querySelectorAll('article')[0]!;
  assert.match(reusable.textContent ?? '', /Last run .*succeeded, marked done by you \(2 runs\)/);
  assert.equal(reusable.querySelector('button.secondary:not(:first-child)')?.textContent, 'Mark run (I ran it)');
  const old = root.querySelectorAll('article')[1]!;
  assert.match(old.textContent ?? '', /failed, run on the Podium/);
  assert.deepEqual([...old.querySelectorAll('button')].map((b) => b.textContent), ['Copy command']);
  cleanup();
});

test('empty states say so, and a failed load says the scripts could not be loaded', async () => {
  const empty = await view([]);
  assert.match(empty.root.textContent ?? '', /Nothing is waiting on you\./);
  assert.match(empty.root.textContent ?? '', /History is empty\./);
  empty.cleanup();
  const failed = await view(null);
  assert.match(failed.root.querySelector('[role=alert]')!.textContent ?? '', /could not be loaded/);
  failed.cleanup();
});

test('#tab=scripts&script=<id> marks that card as the target', async () => {
  assert.equal(targetOf('#tab=scripts&script=sc-00000002'), 'sc-00000002');
  assert.equal(targetOf('#tab=scripts'), null);
  assert.equal(targetOf('#tab=scripts&script=%E0%A4%A'), null);
  window.location.hash = '#tab=scripts&script=sc-00000002';
  const { root, cleanup } = await view([BLOCKED, REUSABLE]);
  assert.deepEqual([...root.querySelectorAll('article.target')].map((a) => a.getAttribute('data-id')), ['sc-00000002']);
  window.location.hash = '';
  cleanup();
});
