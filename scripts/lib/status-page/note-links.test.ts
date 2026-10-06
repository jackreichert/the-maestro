// Run: node --test scripts/lib/status-page/note-links.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linkNotePaths, noteExistsIn, vaultRootFor } from './links.ts';
import type { NoteLinkEnv } from './links.ts';
import { renderPage } from './render.ts';
import type { Item, PageConfig, PageInput } from './render.ts';

const FILES = new Set([
  'Plans/2026-01-02-fake-questions.md',
  'Projects/fake-app/Plans/fake-design.md',
  'Projects/other-app/Research/fake_notes.md',
  'Projects/fake-app/.env.md',
]);
const env: NoteLinkEnv = { vaultName: 'Fake Vault', projects: ['fake-app'], exists: (p) => FILES.has(p) };
const id = (s: string): string => s;
const uri = (file: string): string => `obsidian://open?vault=Fake%20Vault&file=${encodeURIComponent(file)}`;

test('a vault-relative path that exists becomes an obsidian link built by obsidianUri, without .md', () => {
  const out = linkNotePaths('see Plans/2026-01-02-fake-questions.md now', env, id);
  assert.equal(out, `see [Plans/2026-01-02-fake-questions.md](${uri('Plans/2026-01-02-fake-questions')}) now`);
});

test('a Projects/ path links as written; a bare path falls back to the ask project', () => {
  assert.match(linkNotePaths('Projects/other-app/Research/fake_notes.md', env, id), /file=Projects%2Fother-app%2FResearch%2Ffake_notes\)/);
  assert.match(linkNotePaths('Plans/fake-design.md', env, id), new RegExp(`\\(${uri('Projects/fake-app/Plans/fake-design').replace(/[?.]/g, '\\$&')}\\)`));
});

test('paths that do not exist, traverse out, or name secret files stay plain', () => {
  for (const t of ['Plans/missing.md', '../Plans/2026-01-02-fake-questions.md', '/etc/x.md', 'Projects/fake-app/.env.md', '.env.md']) {
    assert.equal(linkNotePaths(t, env, id), t);
  }
});

test('URLs, other extensions and a missing vault name are left alone; others are escaped by esc', () => {
  assert.equal(linkNotePaths('https://x.test/Plans/2026-01-02-fake-questions.md', env, id), 'https://x.test/Plans/2026-01-02-fake-questions.md');
  assert.equal(linkNotePaths('Plans/a.txt', env, id), 'Plans/a.txt');
  assert.equal(linkNotePaths('Plans/2026-01-02-fake-questions.md', { ...env, vaultName: '' }, id), 'Plans/2026-01-02-fake-questions.md');
  assert.equal(linkNotePaths('a_b Plans/zz.md', env, (s) => s.replace(/_/g, '\\_')), 'a\\_b Plans/zz.md');
});

const item = (over: Partial<Item>): Item => ({ id: 'ab12', date: '2026-10-05', text: '', stream: 'Rivendell', ...over });
const config = (noteExists?: (p: string) => boolean): PageConfig => ({
  streams: ['Rivendell'], repoStreams: {}, vaultName: 'Fake Vault', trackerUrlBase: '', ticketNotePath: 'Projects/{prefix}/Tickets/{id}',
  trackerKeyPattern: '\\b[A-Z][A-Z0-9]+-\\d+\\b', tz: 'UTC', project: 'fake-app', noteExists,
});
const render = (cfg: PageConfig, over: Partial<PageInput['status']>): string =>
  renderPage({
    now: new Date('2026-10-05T15:00:00Z'), status: { inflight: [], queued: [], blocked: [], awaiting: [], done: [], ...over }, triage: { items: [] }, prs: [],
    prData: { fetchedAt: new Date('2026-10-05T15:00:00Z') }, ticketMap: {}, priorities: { state: 'ok', date: '2026-10-05', items: [{ text: 'Ship it' }] }, config: cfg, command: 'fake',
  }).page;

test('ask text links existing note paths, in the decision and in the context', () => {
  const p = render(config((x) => FILES.has(x)), { awaiting: [item({ text: 'Which one, see Plans/fake-design.md? Notes: Projects/other-app/Research/fake_notes.md and Plans/missing.md.' })] });
  assert.ok(p.includes(`[Plans/fake-design.md](${uri('Projects/fake-app/Plans/fake-design')})`), p);
  assert.ok(p.includes(`[Projects/other-app/Research/fake_notes.md](${uri('Projects/other-app/Research/fake_notes')})`));
  assert.ok(p.includes('Plans/missing.md.') && !p.includes('Plans/missing)'));
});

test('in-flight and queued cells link note paths and still escape pipes', () => {
  const text = 'draft Plans/2026-01-02-fake-questions.md | more';
  const p = render(config((x) => FILES.has(x)), { inflight: [item({ text, model: 'M' })], queued: [item({ id: 'cd34', text, queued: true } as Partial<Item>)] });
  const rows = p.split('\n').filter((l) => l.startsWith('|') && l.includes('fake-questions'));
  assert.equal(rows.length, 2, rows.map((r) => r.slice(0, 70)).join(' // '));
  for (const r of rows) assert.ok(r.includes(`[Plans/2026-01-02-fake-questions.md](${uri('Plans/2026-01-02-fake-questions')}) \\| more`), r);
});

test('without a noteExists lookup the page links nothing', () => {
  const p = render(config(undefined), { awaiting: [item({ text: 'Which? Plans/2026-01-02-fake-questions.md' })] });
  assert.ok(!p.includes('2026-01-02-fake-questions)'));
});

test('noteExistsIn follows symlinks and refuses a target outside the vault, a directory, or a missing file', () => {
  const base = mkdtempSync(join(tmpdir(), 'fake-vault-'));
  try {
    const root = join(base, 'vault');
    mkdirSync(join(root, 'Plans', 'dir.md'), { recursive: true });
    writeFileSync(join(root, 'Plans', 'ok.md'), 'x');
    writeFileSync(join(base, 'outside.md'), 'x');
    symlinkSync(join(base, 'outside.md'), join(root, 'Plans', 'link.md'));
    const has = noteExistsIn(root);
    assert.equal(has('Plans/ok.md'), true);
    assert.equal(has('Plans/link.md'), false);
    assert.equal(has('Plans/dir.md'), false);
    assert.equal(has('Plans/none.md'), false);
    assert.equal(noteExistsIn('')('Plans/ok.md'), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('vaultRootFor prefers the configured root, else cuts the status dir at /Projects/<p>/Status', () => {
  assert.equal(vaultRootFor('/v', '/x/Projects/p/Status'), '/v');
  assert.equal(vaultRootFor('', '/x/Fake Vault/Projects/p/Status'), '/x/Fake Vault');
  assert.equal(vaultRootFor('', '/elsewhere'), '');
});
