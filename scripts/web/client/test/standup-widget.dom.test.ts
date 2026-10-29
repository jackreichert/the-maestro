// Run: node --test scripts/web/client/test/standup-widget.dom.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, place } from './dom-harness.ts';
import { sanitizeStandup } from '../src/contract.ts';
import type { StandupData } from '../src/types.ts';

installDom();
const { standupWidget, resetStandup } = await import('../src/standup-widget.ts');

const data = (o: Partial<StandupData> = {}): StandupData => ({ days: 3, from: '2026-10-23', to: '2026-10-25', defaultDays: 3, text: '*Yesterday (Fri to Sun)*\n- Alpha\n  - shipped #9', ...o });
const tick = (): Promise<void> => new Promise((ok) => setTimeout(ok, 0));
const q = <T extends Element>(el: Element, sel: string): T => el.querySelector(sel) as T;
const fire = (el: Element, type: string): void => { el.dispatchEvent(new window.Event(type, { bubbles: true })); };

function mountWith(load: (d?: number) => Promise<StandupData>, copy: (t: string) => Promise<void> = async () => {}) {
  resetStandup();
  const calls: (number | undefined)[] = [];
  const el = place(standupWidget({ load: async (d) => { calls.push(d); return load(d); }, copy })).el;
  return { el, calls };
}

test('the widget reads the standup once on draw and shows it as text with the window it covers', async () => {
  const { el, calls } = mountWith(async () => data({ text: '*Today*\n- <b>not html</b>' }));
  await tick();
  assert.deepEqual(calls, [undefined], 'first draw asks for the server default');
  assert.equal(q(el, 'pre').textContent, '*Today*\n- <b>not html</b>');
  assert.equal(el.querySelectorAll('pre b').length, 0, 'text is never parsed as HTML');
  assert.equal(q<HTMLInputElement>(el, 'input').value, '3');
  assert.match(el.textContent ?? '', /2026-10-23 to 2026-10-25/);
});

test('Refresh reads again with the days shown, in place, and Copy puts the shown text on the clipboard', async () => {
  let n = 0;
  const copied: string[] = [];
  const { el, calls } = mountWith(async (d) => data({ days: d ?? 3, text: `read ${++n}` }), async (t) => { copied.push(t); });
  await tick();
  q<HTMLButtonElement>(el, 'button.btn').click();
  await tick();
  assert.deepEqual(calls, [undefined, 3]);
  assert.equal(q(el, 'pre').textContent, 'read 2');
  [...el.querySelectorAll('button')].find((b) => b.textContent === 'Copy')!.click();
  await tick();
  assert.deepEqual(copied, ['read 2']);
  assert.match(q(el, '[role=status]').textContent ?? '', /Copied/);
});

test('changing days asks the server for that window; an out-of-range value is refused here and asks nothing', async () => {
  const { el, calls } = mountWith(async (d) => data({ days: d ?? 3 }));
  await tick();
  const input = q<HTMLInputElement>(el, 'input');
  input.value = '7'; fire(input, 'change');
  await tick();
  assert.deepEqual(calls, [undefined, 7]);
  for (const bad of ['0', '15', '', '2.5', '-1']) {
    input.value = bad; fire(input, 'change');
    await tick();
    assert.equal(input.getAttribute('aria-invalid'), 'true', bad);
  }
  assert.equal(calls.length, 2);
  assert.match(q(el, '[role=status]').textContent ?? '', /whole number from 1 to 14/);
});

test('a failed read says so and leaves the previous text; a slow stale answer does not overwrite a newer one', async () => {
  let fail = false;
  const { el } = mountWith(async () => { if (fail) throw new Error('down'); return data({ text: 'good' }); });
  await tick();
  fail = true;
  [...el.querySelectorAll('button')].find((b) => b.textContent === 'Refresh')!.click();
  await tick();
  assert.equal(q(el, 'pre').textContent, 'good');
  assert.match(q(el, '[role=status]').textContent ?? '', /Could not read/);

  resetStandup();
  const waits: ((d: StandupData) => void)[] = [];
  const slow = place(standupWidget({ load: () => new Promise((ok) => { waits.push(ok); }), copy: async () => {} })).el;
  const refresh = [...slow.querySelectorAll('button')].find((b) => b.textContent === 'Refresh')!;
  assert.ok(refresh.disabled, 'Refresh is off while a read is in flight');
  const input = slow.querySelector('input') as HTMLInputElement;
  input.value = '5'; fire(input, 'change');   // a newer request while the first is pending
  assert.equal(waits.length, 2);
  waits[1]!(data({ days: 5, text: 'newer' }));
  await tick();
  waits[0]!(data({ days: 3, text: 'older, arrives last' }));
  await tick();
  assert.equal(q(slow, 'pre').textContent, 'newer');
});

test('a redraw of Home keeps the days and the text without asking again', async () => {
  const { calls } = mountWith(async () => data({ text: 'kept' }));
  await tick();
  let again = 0;
  const el2 = place(standupWidget({ load: async () => { again++; return data(); }, copy: async () => {} })).el;
  assert.equal(again, 0);
  assert.equal(q(el2, 'pre').textContent, 'kept');
  assert.equal(calls.length, 1);
});

test('sanitizeStandup accepts the server shape and rejects out-of-range or malformed bodies', () => {
  assert.deepEqual(sanitizeStandup(data()), data());
  for (const bad of [null, [], {}, { ...data(), days: 0 }, { ...data(), days: 15 }, { ...data(), days: 2.5 }, { ...data(), defaultDays: 'x' }, { ...data(), from: 'yesterday' }, { ...data(), text: 5 }, { ...data(), text: 'x'.repeat(20_001) }]) {
    assert.equal(sanitizeStandup(bad), null, JSON.stringify(bad)?.slice(0, 40));
  }
});
