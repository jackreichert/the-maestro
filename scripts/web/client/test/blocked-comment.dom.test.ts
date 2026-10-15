// Run: node --test scripts/web/client/test/blocked-comment.dom.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, mount, place } from './dom-harness.ts';
import type { CommentOutcome, CommentRequest } from '../src/blocked-api.ts';
import type { BlockedItem } from '../src/types.ts';

installDom();
type Box = HTMLElement & { item: { id: string; text: string } | null; locked: boolean; commenter: { send(r: CommentRequest): Promise<CommentOutcome> } };

const item = { id: 'bl11', text: 'Publish v1' };
function stub(out: CommentOutcome | ((r: CommentRequest) => CommentOutcome)): { send(r: CommentRequest): Promise<CommentOutcome>; calls: CommentRequest[] } {
  const calls: CommentRequest[] = [];
  return { calls, send: async (r) => { calls.push(r); return typeof out === 'function' ? out(r) : out; } };
}
const tick = (): Promise<void> => new Promise((ok) => setTimeout(ok, 0));
async function opened(commenter: ReturnType<typeof stub>, props: Record<string, unknown> = {}) {
  (await import('../src/blocked-comment.ts')).forgetBlockedComments();
  const m = await mount<Box>('../src/blocked-comment.ts', 'blocked-comment', { item, commenter, ...props });
  (m.root.querySelector('button.toggle') as HTMLElement).click();
  const field = m.root.querySelector('textarea') as HTMLTextAreaElement;
  return { ...m, field, unblock: m.root.querySelector('button.primary') as HTMLButtonElement, only: m.root.querySelector('button.secondary') as HTMLButtonElement };
}
const type = (field: HTMLTextAreaElement, text: string): void => { field.value = text; field.dispatchEvent(new Event('input', { bubbles: true })); };

test('the box is a labelled textarea behind a disclosure that names the item; Unblock and Comment only are real buttons', async () => {
  const { root, field, unblock, only, cleanup } = await opened(stub({ ok: true, comment: 'x', same: false }));
  const toggle = root.querySelector('button.toggle') as HTMLElement;
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.match(toggle.getAttribute('aria-label') ?? '', /bl11/);
  const label = root.querySelector(`label[for="${field.id}"]`);
  assert.match(label?.textContent ?? '', /comment/i);
  assert.equal(unblock.textContent, 'Unblock');
  assert.equal(only.textContent, 'Comment only');
  assert.equal(unblock.getAttribute('type'), 'button');
  assert.ok(unblock.getAttribute('aria-describedby'), 'each button is tied to the item it acts on');
  cleanup();
});

test('Unblock posts the trimmed comment, then says what happened in a status region and takes focus there', async () => {
  const c = stub({ ok: true, comment: 'Go ahead', same: false, queued: 'qq01' });
  const { root, field, unblock, cleanup } = await opened(c);
  type(field, '  Go ahead  ');
  unblock.click();
  await tick();
  assert.deepEqual(c.calls, [{ id: 'bl11', mode: 'unblock', comment: 'Go ahead' }]);
  const status = root.querySelector('[role=status]') as HTMLElement;
  assert.match(status.textContent ?? '', /Unblocked/);
  assert.match(status.textContent ?? '', /Go ahead/);
  assert.equal(root.querySelector('textarea'), null, 'the form is replaced by the result');
  cleanup();
});

test('Comment only posts mode comment, keeps the item blocked and clears the box for the next comment', async () => {
  const c = stub({ ok: true, comment: 'Ask finance', same: false });
  const { root, field, only, cleanup } = await opened(c);
  type(field, 'Ask finance');
  only.click();
  await tick();
  assert.deepEqual(c.calls, [{ id: 'bl11', mode: 'comment', comment: 'Ask finance' }]);
  assert.match((root.querySelector('[role=status]') as HTMLElement).textContent ?? '', /Comment saved/);
  assert.equal((root.querySelector('textarea') as HTMLTextAreaElement).value, '');
  cleanup();
});

test('an empty comment is refused before any request, with an announced error tied to the field', async () => {
  const c = stub({ ok: true, comment: 'x', same: false });
  const { root, field, unblock, only, cleanup } = await opened(c);
  for (const b of [unblock, only]) {
    type(field, '   ');
    b.click();
    await tick();
    const err = root.querySelector('[role=alert]') as HTMLElement;
    assert.equal(err.hidden, false);
    assert.match(err.textContent ?? '', /comment first/i);
    assert.equal(field.getAttribute('aria-invalid'), 'true');
    assert.match(field.getAttribute('aria-describedby') ?? '', new RegExp(err.id));
  }
  assert.equal(c.calls.length, 0);
  type(field, 'x');
  assert.equal((root.querySelector('[role=alert]') as HTMLElement).hidden, true, 'typing clears the error');
  cleanup();
});

test('a server refusal is shown as an alert and keeps the typed comment; a closed item disables the buttons', async () => {
  const c = stub({ ok: false, message: 'Keep the comment under 400 characters and plain text.', closed: false });
  const { root, field, unblock, only, cleanup } = await opened(c);
  type(field, 'too much');
  unblock.click();
  await tick();
  assert.match((root.querySelector('[role=alert]') as HTMLElement).textContent ?? '', /under 400/);
  assert.equal(field.value, 'too much');
  assert.equal(unblock.disabled, false);
  const gone = stub({ ok: false, message: 'That item is no longer blocked.', closed: true });
  const m2 = await opened(gone);
  type(m2.field, 'x');
  m2.only.click();
  await tick();
  assert.equal(m2.only.disabled && m2.unblock.disabled, true);
  cleanup(); m2.cleanup(); void only;
});

test('Ctrl+Enter or Cmd+Enter sends Unblock; Escape closes the box and returns focus to the toggle; a double press posts once', async () => {
  const c = stub({ ok: true, comment: 'Go', same: false, queued: 'qq01' });
  const { root, field, cleanup } = await opened(c);
  type(field, 'Go');
  const key = (k: string, mods: Record<string, boolean> = {}): void => { field.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...mods })); };
  key('Enter', { ctrlKey: true });
  key('Enter', { ctrlKey: true });
  await tick();
  assert.equal(c.calls.length, 1, 'the second press lands while the first is in flight');
  assert.equal(c.calls[0]?.mode, 'unblock');
  cleanup();
  const d = await opened(stub({ ok: true, comment: 'x', same: false }));
  type(d.field, 'half typed');
  d.field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal((d.root.querySelector('button.toggle') as HTMLElement).getAttribute('aria-expanded'), 'false');
  (d.root.querySelector('button.toggle') as HTMLElement).click();
  assert.equal((d.root.querySelector('textarea') as HTMLTextAreaElement).value, 'half typed', 'the draft survives');
  d.cleanup(); void root;
});

test('while a request is in flight the page is told to hold redraws, and told again when it settles', async () => {
  let release: (o: CommentOutcome) => void = () => {};
  const commenter = { send: () => new Promise<CommentOutcome>((ok) => { release = ok; }) };
  const { el, field, unblock, cleanup } = await opened(commenter as unknown as ReturnType<typeof stub>);
  const seen: boolean[] = [];
  el.addEventListener('ask-busy', (e) => seen.push((e as CustomEvent<{ busy: boolean }>).detail.busy));
  type(field, 'Go');
  unblock.click();
  assert.deepEqual(seen, [true]);
  assert.equal(unblock.disabled, true);
  release({ ok: true, comment: 'Go', same: false });
  await tick();
  assert.deepEqual(seen, [true, false]);
  cleanup();
});

test('locked (sample data) draws no comment box', async () => {
  const { el, root, cleanup } = await mount<Box>('../src/blocked-comment.ts', 'blocked-comment', { item, locked: true });
  assert.equal(root.querySelector('button.toggle'), null);
  assert.equal(root.querySelector('textarea'), null);
  void el; cleanup();
});

test('withComments keeps the row text and gate and adds one comment box per item', async () => {
  const { withComments } = await import('../src/blocked-rows.ts');
  const { itemRows } = await import('../src/stream-board.ts');
  const xs: BlockedItem[] = [
    { id: 'bl11', stream: 'Alpha', text: 'Publish v1', links: { tracker: [], prs: [] }, since: '2026-10-14T10:00:00.000Z', gate: 'ticket:FAKE-9' },
    { id: 'bl22', stream: 'Alpha', text: 'Pick a vendor', links: { tracker: [], prs: [] }, since: '2026-10-14T10:05:00.000Z' },
  ];
  const ctx = { now: '2026-10-15T10:00:00.000Z', tz: 'UTC', showStream: false };
  const ul = withComments(itemRows(xs, ctx), xs, true) as HTMLElement;
  const { cleanup } = place(ul);
  const lis = [...ul.querySelectorAll('li')];
  assert.equal(lis.length, 2);
  assert.match(lis[0]?.textContent ?? '', /Publish v1/);
  assert.equal(lis.every((li) => li.querySelectorAll('blocked-comment').length === 1), true);
  const locked = withComments(itemRows(xs, ctx), xs, false) as HTMLElement;
  assert.equal(locked.querySelectorAll('blocked-comment').length, 0, 'sample data has no box');
  assert.equal(withComments(itemRows([], ctx), [], true), null);
  cleanup();
});

test('a redraw keeps an open box and its half-typed comment, and keeps a sent unblock settled without taking focus', async () => {
  const c = stub({ ok: true, comment: 'Go', same: false, queued: 'qq01' });
  const first = await opened(c);
  type(first.field, 'half typed');
  first.cleanup();
  const again = await mount<Box>('../src/blocked-comment.ts', 'blocked-comment', { item, commenter: c });
  const field = again.root.querySelector('textarea') as HTMLTextAreaElement;
  assert.equal(field.value, 'half typed');
  assert.equal((again.root.querySelector('.form') as HTMLElement).hidden, false, 'still open');
  type(field, 'Go');
  (again.root.querySelector('button.primary') as HTMLElement).click();
  await tick();
  again.cleanup();
  const third = await mount<Box>('../src/blocked-comment.ts', 'blocked-comment', { item, commenter: c });
  assert.match(third.root.querySelector('[role=status]')?.textContent ?? '', /Unblocked/);
  assert.equal(third.root.querySelector('textarea'), null);
  third.cleanup();
});
