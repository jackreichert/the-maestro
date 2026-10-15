// Run: node --test scripts/web/client/test/scripts-view.dom.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, mount } from './dom-harness.ts';
import type { CatalogView, Preview, RunApi } from '../src/run-api.ts';

installDom();
const { argsOf, clearScriptDrafts } = await import('../src/scripts-view.ts');
const { clearSavedRuns } = await import('../src/run-panel.ts');
type View = HTMLElement & { api: RunApi };
const wait = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

const CATALOG: CatalogView = {
  scripts: [
    { id: 'ticket-list', name: 'Ticket list', description: 'Tickets of one project.', group: 'tickets', readOnly: true, tier: 'haiku', timeoutSeconds: 60,
      args: [{ name: 'project', type: 'string', flag: '--project', default: 'the-maestro' }, { name: 'status', type: 'enum', flag: '--status', values: ['open', 'closed'], default: 'open' }, { name: 'limit', type: 'integer', flag: '--limit', min: 1, max: 50 }, { name: 'all', type: 'boolean', flag: '--all' }] },
    { id: 'status', name: 'Journal status', description: 'The board.', group: 'ledger', readOnly: false, tier: 'none', timeoutSeconds: 30, args: [] },
  ],
  problems: ['entry broken: the program must be {node} or an absolute path'],
};
const PREVIEW: Preview = { source: 'script', target: 'ticket-list', title: 'Ticket list', command: '/node ticket.mjs list', sha256: 'c'.repeat(64), readOnly: true, tier: 'haiku', runnable: true, refusals: [] };

function fake(catalog: unknown = { ok: true, value: CATALOG }): { api: RunApi; previews: unknown[] } {
  const previews: unknown[] = [];
  const api = { catalog: async () => catalog, preview: async (src: unknown) => { previews.push(src); return { ok: true, value: PREVIEW }; } } as unknown as RunApi;
  return { api, previews };
}
const view = async (api: RunApi) => { clearScriptDrafts(); clearSavedRuns(); const m = await mount<View>('../src/scripts-view.ts', 'scripts-view', { api }); await wait(); return m; };

test('lists the catalog by group with badges, and says which entries did not load', async () => {
  const { api } = fake();
  const { root, cleanup } = await view(api);
  assert.deepEqual([...root.querySelectorAll('h3.group-name')].map((n) => n.textContent), ['tickets', 'ledger']);
  assert.deepEqual([...root.querySelectorAll('h4')].map((n) => n.textContent), ['Ticket list', 'Journal status']);
  const badges = (i: number): string[] => [...root.querySelectorAll('article')[i]!.querySelectorAll('.badge')].map((n) => n.textContent ?? '');
  assert.deepEqual(badges(0), ['read-only', 'model: haiku', '60s limit']);
  assert.deepEqual(badges(1), ['can write', '30s limit']);
  assert.match(root.querySelector('.problems')!.textContent ?? '', /Not loaded: entry broken/);
  assert.equal(root.querySelector('run-panel'), null, 'nothing is previewed until Review');
  cleanup();
});

test('Review previews the script with its args, and an argument change asks for a fresh review', async () => {
  const { api, previews } = fake();
  const { root, cleanup } = await view(api);
  (root.querySelector('article button') as HTMLButtonElement).click();
  await wait(30);
  assert.deepEqual(previews[0], { source: 'script', name: 'ticket-list', args: {} });
  assert.match(root.querySelector('run-panel')!.shadowRoot!.textContent ?? '', /ticket\.mjs list/);
  const status = root.querySelector('select') as HTMLSelectElement;
  status.value = 'closed';
  status.dispatchEvent(new Event('change'));
  const limit = root.querySelector('input[type=number]') as HTMLInputElement;
  limit.value = '7';
  limit.dispatchEvent(new Event('change'));
  const all = root.querySelector('input[type=checkbox]') as HTMLInputElement;
  all.checked = true;
  all.dispatchEvent(new Event('change'));
  await wait(30);
  assert.deepEqual(previews.at(-1), { source: 'script', name: 'ticket-list', args: { status: 'closed', limit: 7, all: true } });
  cleanup();
});

test('what was typed and which script was open survive a rebuild of the tab', async () => {
  const { api } = fake();
  const one = await view(api);
  (one.root.querySelector('article button') as HTMLButtonElement).click();
  const input = one.root.querySelector('input[type=text]') as HTMLInputElement;
  input.value = 'other';
  input.dispatchEvent(new Event('change'));
  await wait(30);
  one.cleanup();
  const two = await mount<View>('../src/scripts-view.ts', 'scripts-view', { api });
  await wait(30);
  assert.equal((two.root.querySelector('input[type=text]') as HTMLInputElement).value, 'other');
  assert.ok(two.root.querySelector('run-panel'), 'still open');
  two.cleanup();
});

test('argsOf leaves blanks out so the schema default applies, and sends numbers as numbers', () => {
  const spec = CATALOG.scripts[0]!.args;
  assert.deepEqual(argsOf(spec, { project: '', status: '', limit: '', all: false }), {});
  assert.deepEqual(argsOf(spec, { project: 'p', limit: '12', all: true }), { project: 'p', limit: 12, all: true });
});

test('a catalog that cannot be loaded says so', async () => {
  const { api } = fake({ ok: false, error: 'token', message: 'Could not get permission from the server. Reload the page.' });
  const { root, cleanup } = await view(api);
  assert.match(root.textContent ?? '', /Could not get permission/);
  cleanup();
});
