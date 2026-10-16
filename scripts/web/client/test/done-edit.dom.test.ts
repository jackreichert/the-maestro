// Run: node --test scripts/web/client/test/done-edit.dom.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, place } from './dom-harness.ts';
import { home } from './home-fixture.ts';
import type { DoneSource, StreamHome } from '../src/types.ts';
import type { DoneApi, DoneRef } from '../src/done-api.ts';

installDom();
const { doneTop, doneBackend, forgetDoneEdits } = await import('../src/done-view.ts');
const { PAGES } = await import('../src/pager.ts');
const { createDoneApi } = await import('../src/done-api.ts');

const src = (over: Partial<DoneSource> = {}): DoneSource => ({
  kind: 'epic', name: 'FAKE-1', ref: { label: 'FAKE-1' }, items: [{ text: 'Exporter live', checked: false }], prose: null, more: 0, progress: null, finished: false, ...over,
});
const tick = (): Promise<void> => new Promise((ok) => setTimeout(ok, 0));
const draw = (sources: DoneSource[], fix: string | null = null): HTMLElement => {
  PAGES.clear();
  const el = doneTop({ ...home(), stream: 'acme-widgets', done: { sources, fix } } as unknown as StreamHome);
  place(el);
  return el;
};

interface Calls { loads: DoneRef[]; saves: { ref: DoneRef; rev: string; text: string }[] }
function fake(over: Partial<DoneApi> = {}): Calls {
  const calls: Calls = { loads: [], saves: [] };
  doneBackend.api = {
    load: async (ref) => { calls.loads.push(ref); return { ok: true, text: '- [ ] Exporter live', rev: 'abcdef012345' }; },
    save: async (ref, rev, text) => { calls.saves.push({ ref, rev, text }); return { ok: true, rev: 'fedcba543210' }; },
    ...over,
  };
  return calls;
}
beforeEach(() => forgetDoneEdits());

test('Edit opens a labelled textarea prefilled with the current markdown, and hides the read view', async () => {
  const calls = fake();
  const el = draw([src()]);
  (el.querySelector('.dc-edit') as HTMLButtonElement).click();
  await tick();
  assert.deepEqual(calls.loads, [{ stream: 'acme-widgets', kind: 'epic', name: 'FAKE-1' }]);
  const field = el.querySelector('textarea') as HTMLTextAreaElement;
  assert.equal(field.value, '- [ ] Exporter live');
  const label = el.querySelector(`label[for="${field.id}"]`);
  assert.match(label?.textContent ?? '', /Edit what done looks like: FAKE-1/);
  assert.equal((el.querySelector('ul') as HTMLElement).hidden, true);
});

test('Save sends the stream, source, revision and text, then closes the editor and says so', async () => {
  const calls = fake();
  const el = draw([src()]);
  (el.querySelector('.dc-edit') as HTMLButtonElement).click();
  await tick();
  (el.querySelector('textarea') as HTMLTextAreaElement).value = '- [x] Exporter live';
  (el.querySelector('.primary') as HTMLButtonElement).click();
  await tick();
  assert.deepEqual(calls.saves, [{ ref: { stream: 'acme-widgets', kind: 'epic', name: 'FAKE-1' }, rev: 'abcdef012345', text: '- [x] Exporter live' }]);
  assert.equal(el.querySelector('textarea'), null);
  assert.match(el.querySelector('.done-saved')?.textContent ?? '', /Saved/);
  assert.equal((el.querySelector('ul') as HTMLElement).hidden, false);
});

test('keyboard: Ctrl+Enter saves and Escape cancels without saving, returning focus to Edit', async () => {
  const calls = fake();
  const el = draw([src()]);
  const edit = el.querySelector('.dc-edit') as HTMLButtonElement;
  edit.click();
  await tick();
  let field = el.querySelector('textarea') as HTMLTextAreaElement;
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(el.querySelector('textarea'), null);
  assert.equal(calls.saves.length, 0);
  assert.equal(edit.hidden, false);
  edit.click();
  await tick();
  field = el.querySelector('textarea') as HTMLTextAreaElement;
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  await tick();
  assert.equal(calls.saves.length, 1);
});

test('a failed save shows the error in an alert tied to the field and keeps the text', async () => {
  fake({ save: async () => ({ ok: false, message: 'This definition changed since you opened it.', changed: true }) });
  const el = draw([src()]);
  (el.querySelector('.dc-edit') as HTMLButtonElement).click();
  await tick();
  const field = el.querySelector('textarea') as HTMLTextAreaElement;
  field.value = 'my words';
  (el.querySelector('.primary') as HTMLButtonElement).click();
  await tick();
  const err = el.querySelector('.de-error') as HTMLElement;
  assert.equal(err.getAttribute('role'), 'alert');
  assert.equal(err.hidden, false);
  assert.match(err.textContent ?? '', /changed since/);
  assert.equal(field.getAttribute('aria-invalid'), 'true');
  assert.match(field.getAttribute('aria-describedby') ?? '', new RegExp(err.id));
  assert.equal(field.value, 'my words');
});

test('an empty text is refused in the page without a request', async () => {
  const calls = fake();
  const el = draw([src()]);
  (el.querySelector('.dc-edit') as HTMLButtonElement).click();
  await tick();
  (el.querySelector('textarea') as HTMLTextAreaElement).value = '  ';
  (el.querySelector('.primary') as HTMLButtonElement).click();
  await tick();
  assert.equal(calls.saves.length, 0);
  assert.match(el.querySelector('.de-error')?.textContent ?? '', /empty definition/);
});

test('a definition that cannot be opened says so and opens no editor', async () => {
  fake({ load: async () => ({ ok: false, message: 'Could not open this definition to edit.' }) });
  const el = draw([src()]);
  (el.querySelector('.dc-edit') as HTMLButtonElement).click();
  await tick();
  assert.equal(el.querySelector('textarea'), null);
  assert.match(el.querySelector('.done-edit-error:not([hidden])')?.textContent ?? '', /Could not open/);
});

test('a stream with nothing written offers to write it, as a new definition', async () => {
  const calls = fake({ load: async (ref) => ({ ok: true, text: '', rev: ref.kind === 'new' ? '0123456789ab' : 'x' }) });
  const el = draw([], 'No definition of done yet.');
  const add = el.querySelector('.dc-edit') as HTMLButtonElement;
  assert.match(add.textContent ?? '', /Write it here/);
  add.click();
  await tick();
  (el.querySelector('textarea') as HTMLTextAreaElement).value = '1. Staged';
  (el.querySelector('.primary') as HTMLButtonElement).click();
  await tick();
  assert.deepEqual(calls.saves[0], { ref: { stream: 'acme-widgets', kind: 'new', name: '' }, rev: '0123456789ab', text: '1. Staged' });
});

test('a redraw while the editor is open brings it back with the typed text', async () => {
  fake();
  let el = draw([src()]);
  (el.querySelector('.dc-edit') as HTMLButtonElement).click();
  await tick();
  (el.querySelector('textarea') as HTMLTextAreaElement).dispatchEvent(new Event('input', { bubbles: true }));
  const field = el.querySelector('textarea') as HTMLTextAreaElement;
  field.value = 'half typed';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  el = draw([src()]);
  await tick();
  assert.equal((el.querySelector('textarea') as HTMLTextAreaElement | null)?.value, 'half typed');
});

test('the api sends a source and a revision, never a path, and turns a refusal into a message', async () => {
  const seen: { url: string; init?: RequestInit }[] = [];
  const res = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const api = createDoneApi(async (url, init) => {
    seen.push({ url, init });
    if (url === '/api/edit-token') return res(200, { token: 't' });
    if (init?.method === 'POST') return res(409, { error: 'changed', message: 'Changed since you opened it.' });
    return res(200, { text: 'x', rev: 'abcdef012345' });
  });
  assert.deepEqual(await api.load({ stream: 'Acme Widgets', kind: 'epic', name: 'FAKE-1' }), { ok: true, text: 'x', rev: 'abcdef012345' });
  assert.equal(seen[0]?.url, '/api/streams/Acme%20Widgets/done-text?kind=epic&name=FAKE-1');
  const out = await api.save({ stream: 'Acme Widgets', kind: 'new', name: '' }, 'abcdef012345', 'text');
  assert.deepEqual(out, { ok: false, message: 'Changed since you opened it.', changed: true });
  assert.deepEqual(JSON.parse(String(seen.at(-1)?.init?.body)), { stream: 'Acme Widgets', kind: 'new', rev: 'abcdef012345', text: 'text' });
});
