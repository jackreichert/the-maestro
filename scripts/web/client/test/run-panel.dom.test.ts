// Run: node --test scripts/web/client/test/run-panel.dom.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, mount } from './dom-harness.ts';
import type { RunApi, Preview, Progress } from '../src/run-api.ts';
import type { AskCard } from '../src/types.ts';

installDom();
type Panel = HTMLElement & { source: unknown; api: RunApi; locked: boolean; load(): Promise<void> };
const wait = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));
const SHA = 'a'.repeat(64);
const preview = (over: Partial<Preview> = {}): Preview => ({ source: 'ask', target: 'ab12', title: 'Run it', command: 'echo "hi there"\nls -la', sha256: SHA, readOnly: null, tier: null, runnable: true, refusals: [], ...over });
const progress = (over: Partial<Progress> = {}): Progress => ({ status: 'done', exitCode: 0, durationMs: 1500, chunks: [], next: 0, truncated: false, ...over });

interface Calls { start: unknown[][]; poll: unknown[][]; kill: string[]; resolve: string[] }
function fake(p: Preview, polls: Progress[], opts: { startOutcome?: unknown } = {}): { api: RunApi; calls: Calls } {
  const calls: Calls = { start: [], poll: [], kill: [], resolve: [] };
  let n = 0;
  const api = {
    preview: async () => ({ ok: true, value: p }),
    start: async (...a: unknown[]) => { calls.start.push(a); return opts.startOutcome ?? { ok: true, value: 'r'.repeat(24) }; },
    poll: async (...a: unknown[]) => { calls.poll.push(a); return { ok: true, value: polls[Math.min(n++, polls.length - 1)] }; },
    kill: async (id: string) => { calls.kill.push(id); return { ok: true, value: true }; },
    resolve: async (id: string) => { calls.resolve.push(id); return { ok: true, value: { id: 'ab12', answer: 'Ran on the Podium (done, exit 0, 1.5s).' } }; },
  } as unknown as RunApi;
  return { api, calls };
}
const mountPanel = async (api: RunApi, source: unknown = { source: 'ask', id: 'ab12' }) => {
  const m = await mount<Panel>('../src/run-panel.ts', 'run-panel', { source, api });
  await m.el.load();
  return m;
};
const q = <T extends Element>(root: ParentNode, sel: string): T => root.querySelector(sel) as T;

test('shows the command exactly as the server read it, with a short hash and a Run button', async () => {
  const { api } = fake(preview(), [progress()]);
  const { root, cleanup } = await mountPanel(api);
  assert.equal(q(root, 'pre.cmd').textContent, 'echo "hi there"\nls -la');
  assert.match(root.textContent ?? '', /sha256 aaaaaaaaaaaa/);
  assert.equal(q<HTMLButtonElement>(root, 'button.primary').hasAttribute('disabled'), false);
  cleanup();
});

test('a command the server will not run lists why, and Run stays disabled', async () => {
  const { api, calls } = fake(preview({ runnable: false, refusals: [{ rule: 'secret-file', message: 'The block names a secret file.' }, { rule: 'inline-comment', line: 2, message: 'Inline comment.' }] }), [progress()]);
  const { root, cleanup } = await mountPanel(api);
  assert.deepEqual([...root.querySelectorAll('.refusals li')].map((n) => n.textContent), ['The block names a secret file.', 'Line 2: Inline comment.']);
  assert.equal(q<HTMLButtonElement>(root, 'button.primary').hasAttribute('disabled'), true);
  q<HTMLButtonElement>(root, 'button.primary').click();
  await wait();
  assert.equal(calls.start.length, 0);
  cleanup();
});

test('Run sends the source and the reviewed hash, streams output, and offers to resolve the ask', async () => {
  const { api, calls } = fake(preview(), [progress({ status: 'running', exitCode: null, durationMs: null, chunks: [{ seq: 0, stream: 'out', text: 'first\n' }], next: 1 }), progress({ chunks: [{ seq: 1, stream: 'err', text: 'warn\n' }], next: 2 })]);
  const { el, root, cleanup } = await mountPanel(api);
  const run = q<HTMLButtonElement>(root, 'button.primary');
  run.click();
  await wait(50);
  assert.deepEqual(calls.start[0], [{ source: 'ask', id: 'ab12' }, SHA, false]);
  assert.equal(q(root, 'pre.out').textContent, 'first\n');
  assert.equal(q<HTMLButtonElement>(root, 'button.secondary').hidden, false, 'Stop shows while it runs');
  await wait(600);
  assert.equal(q(root, 'pre.out').textContent, 'first\nwarn\n');
  assert.deepEqual(calls.poll.map((c) => c[1]), [0, 1], 'each poll asks only for what it has not seen');
  assert.match(q(root, '.status').textContent ?? '', /Finished: exit 0 in 1\.5s/);
  const resolve = [...root.querySelectorAll<HTMLButtonElement>('button.secondary')].find((b) => /Resolve/.test(b.textContent ?? ''))!;
  assert.equal(resolve.hidden, false);
  let got: unknown = null;
  el.addEventListener('run-resolved', (e) => { got = (e as CustomEvent).detail; });
  resolve.click();
  await wait();
  assert.deepEqual(calls.resolve, ['r'.repeat(24)]);
  assert.deepEqual(got, { id: 'ab12', answer: 'Ran on the Podium (done, exit 0, 1.5s).' });
  cleanup();
});

test('Stop asks the server to kill the run', async () => {
  const { api, calls } = fake(preview(), [progress({ status: 'running', exitCode: null, durationMs: null })]);
  const { el, root, cleanup } = await mountPanel(api);
  q<HTMLButtonElement>(root, 'button.primary').click();
  await wait(50);
  q<HTMLButtonElement>(root, 'button.secondary').click();
  await wait();
  assert.deepEqual(calls.kill, ['r'.repeat(24)]);
  el.remove();
  cleanup();
});

test('a command that changed since review is shown again and not run', async () => {
  const changed = { ok: false, error: 'changed', message: 'The command changed after you reviewed it. Review it again.', preview: preview({ command: 'echo new', sha256: 'b'.repeat(64) }) };
  const { api } = fake(preview(), [progress()], { startOutcome: changed });
  const { root, cleanup } = await mountPanel(api);
  q<HTMLButtonElement>(root, 'button.primary').click();
  await wait(50);
  assert.equal(q(root, 'pre.cmd').textContent, 'echo new');
  assert.match(q(root, '.status').textContent ?? '', /changed after you reviewed/);
  assert.match(root.textContent ?? '', /sha256 bbbbbbbbbbbb/);
  cleanup();
});

test('a command that can write needs the box ticked before it runs', async () => {
  const { api, calls } = fake(preview({ source: 'script', readOnly: false }), [progress()]);
  const { root, cleanup } = await mountPanel(api, { source: 'script', name: 'x' });
  q<HTMLButtonElement>(root, 'button.primary').click();
  await wait();
  assert.equal(calls.start.length, 0);
  q<HTMLInputElement>(root, 'input[type=checkbox]').checked = true;
  q<HTMLButtonElement>(root, 'button.primary').click();
  await wait(50);
  assert.equal(calls.start[0]![2], true);
  cleanup();
});

test('an ask card with a paste block carries the panel, sample data does not', async () => {
  const ask: AskCard = { id: 'ab12', stream: 'Alpha', needed: 'Run the check', context: '', ageDays: 0.2, date: '2026-10-13', ts: '2026-10-13T10:00:00.000Z', links: { tracker: [], prs: [] }, paste: '/tmp/fake/block.sh' };
  const live = await mount<HTMLElement & { ask: AskCard }>('../src/ask-card.ts', 'ask-card', { ask });
  assert.ok(live.root.querySelector('run-panel'));
  live.cleanup();
  const sample = await mount<HTMLElement & { ask: AskCard; locked: boolean }>('../src/ask-card.ts', 'ask-card', { locked: true, ask });
  assert.equal(sample.root.querySelector('run-panel'), null);
  sample.cleanup();
});
