// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/lib/web/vault-watch.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChangeHub } from './events.ts';
import { vaultWatch } from './vault-watch.ts';
import { stampAll } from '../stamp.ts';

const sleep = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms));
const make = () => {
  const root = mkdtempSync(join(tmpdir(), 'vault-watch-'));
  const put = (rel: string, text = 'x'): void => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text); };
  put('Projects/p/Tickets/t-1.md');
  put('Projects/p/Briefs/e-1.md');
  put('Projects/p/Plans/plan.md');
  put('Projects/p/Plans/.env.md', 'canary');
  put('outside.md', 'canary');
  symlinkSync(join(root, 'outside.md'), join(root, 'Projects/p/Plans/linked.md'));
  return { root, put, rel: (files: string[]): string[] => files.map((f) => f.slice(root.length + 1)) };
};

test('it watches the folders and the briefs and tickets, and never a symlink or a secret-named file', () => {
  const { root, rel } = make();
  const names = rel(vaultWatch(root).files());
  assert.deepEqual(names, ['Projects', 'Projects/p/Tickets', 'Projects/p/Briefs', 'Projects/p/Plans', 'Projects/p/Tickets/t-1.md', 'Projects/p/Briefs/e-1.md', 'Projects/p/Plans/plan.md']);
});

test('a brief edit, a new document and a closed ticket each change the stamp', async () => {
  const { root, put } = make();
  const w = vaultWatch(root, { refreshMs: 0 });
  const stamp = (): string => stampAll(w.files());
  let last = stamp();
  const changes = async (what: string, act: () => void): Promise<void> => { await sleep(15); act(); const now = stamp(); assert.notEqual(now, last, what); last = now; };
  await changes('a brief edit', () => put('Projects/p/Briefs/e-1.md', 'longer text'));
  await changes('a new document', () => put('Projects/p/Research/new.md'));
  await changes('a ticket rewrite', () => put('Projects/p/Tickets/t-1.md', 'status: closed'));
  await changes('a new project', () => put('Projects/q/Tickets/t-2.md'));
});

test('past the cap only directories and briefs stay watched, and the list is rebuilt no more often than the refresh interval', () => {
  const { root, put, rel } = make();
  for (let i = 0; i < 10; i++) put(`Projects/p/Research/r${i}.md`);
  const capped = rel(vaultWatch(root, { cap: 8 }).files());
  assert.equal(capped.length, 8);
  assert.ok(capped.includes('Projects/p/Briefs/e-1.md') && !capped.some((n) => n.includes('Research/r')));
  let t = 0;
  const w = vaultWatch(root, { now: () => t, refreshMs: 1000 });
  const first = w.files();
  put('Projects/p/Briefs/e-2.md');
  assert.equal(w.files(), first, 'inside the interval the cached list is returned');
  t = 1000;
  assert.ok(rel(w.files()).includes('Projects/p/Briefs/e-2.md'));
});

test('the hub tells a subscriber when a watched vault file changes', async () => {
  const { root, put } = make();
  const w = vaultWatch(root, { refreshMs: 0 });
  const hub = createChangeHub({ files: () => w.files(), intervalMs: 10, keepAliveMs: 60_000 });
  const seen: string[] = [];
  const off = hub.subscribe({ changed: (s) => seen.push(s), keepAlive: () => {} });
  await sleep(40);
  assert.deepEqual(seen, []);
  put('Projects/p/Briefs/e-1.md', 'edited brief');
  utimesSync(join(root, 'Projects/p/Briefs/e-1.md'), new Date(), new Date(Date.now() + 5000));
  await sleep(80);
  off();
  assert.equal(seen.length, 1);
});
