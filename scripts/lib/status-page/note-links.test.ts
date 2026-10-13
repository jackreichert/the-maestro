// Run: node --test scripts/lib/status-page/note-links.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linkAskRefs, linkNotePaths, noteExistsIn, noteOfUri, shortUrlLabel, uriToNotePaths, vaultRootFor } from './links.ts';
import type { NoteLinkEnv } from './links.ts';
import { renderPage, ticketNoteRef } from './render.ts';
import { carryInline, fillStub } from './inline.ts';
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

test('a ticket link points at Archive/ once the ticket is archived, and stays put otherwise', () => {
  const cfg = config((x) => x === 'Projects/fake-app/Tickets/fake-app-3.md' || x === 'Projects/fake-app/Tickets/Archive/fake-app-2.md');
  assert.equal(ticketNoteRef(cfg, 'fake-app-1').url, uri('Projects/fake-app/Tickets/fake-app-1'), 'a missing note keeps its live path');
    assert.equal(ticketNoteRef(cfg, 'fake-app-3').url, uri('Projects/fake-app/Tickets/fake-app-3'));
  assert.equal(ticketNoteRef(cfg, 'fake-app-2').url, uri('Projects/fake-app/Tickets/Archive/fake-app-2'));
  assert.equal(ticketNoteRef(config(undefined), 'fake-app-2').url, uri('Projects/fake-app/Tickets/fake-app-2'), 'no lookup, no rewrite');
});

const SIB = new Set(['Projects/fake-app/Plans/2026-10-06-fake-checklist.md', 'Projects/fake-app/Research/a b.md']);
const envSib: NoteLinkEnv = { vaultName: 'Fake Vault', projects: ['fake-app'], exists: (p) => SIB.has(p) || FILES.has(p) };
const checklistUri = 'obsidian://open?vault=Fake%20Vault&file=Projects%2Ffake-app%2FResearch%2F2026-10-06-fake-checklist';

test('an obsidian URI with encoded slashes resolves to its note; a wrong sibling folder is repaired; other vaults, traversal and secrets are not', () => {
  assert.equal(noteOfUri(uri('Projects/fake-app/Plans/fake-design'), env), 'Projects/fake-app/Plans/fake-design.md');
  assert.equal(noteOfUri(`${uri('Projects/fake-app/Plans/fake-design')}`, env), 'Projects/fake-app/Plans/fake-design.md');
  assert.equal(noteOfUri(checklistUri, envSib), 'Projects/fake-app/Plans/2026-10-06-fake-checklist.md');
  assert.equal(noteOfUri(uri('Projects/fake-app/Research/a b'), envSib), 'Projects/fake-app/Research/a b.md');
  assert.equal(noteOfUri(checklistUri.replace('Fake%20Vault', 'Other'), envSib), null);
  assert.equal(noteOfUri(uri('../Plans/2026-01-02-fake-questions'), env), null);
  assert.equal(noteOfUri(uri('Projects/fake-app/.env'), env), null);
  assert.equal(noteOfUri('javascript:alert(1)', env), null);
  assert.equal(noteOfUri('obsidian://new?vault=Fake%20Vault&file=Plans%2Ffake-design', env), null);
});

test('uriToNotePaths swaps a resolving URI for its path and leaves the rest (punctuation included) alone', () => {
  assert.equal(uriToNotePaths(`See ${checklistUri}.`, envSib), 'See Projects/fake-app/Plans/2026-10-06-fake-checklist.md.');
  const gone = `See ${uri('Plans/missing')} now`;
  assert.equal(uriToNotePaths(gone, envSib), gone);
  assert.equal(uriToNotePaths(`See ${checklistUri}`, undefined), `See ${checklistUri}`);
});

test('the Markdown page links an ask note given as an obsidian URI, in the wrong folder, instead of dropping it', () => {
  const p = render(config((x) => SIB.has(x)), { awaiting: [item({ text: `Ship it? Checklist: ${checklistUri} . Ticket x.` })] });
  assert.ok(p.includes(`[Projects/fake-app/Plans/2026-10-06-fake-checklist.md](${uri('Projects/fake-app/Plans/2026-10-06-fake-checklist')})`), p);
});

test('linkAskRefs links URIs and paths with the note name, shortens PR and ticket URLs, and leaves the unresolved as written', () => {
  const t = `Note ${checklistUri}, path Plans/fake-design.md, PR https://github.com/o/r/pull/590. Jira https://x.atlassian.net/browse/AB-12 gone ${uri('Plans/missing')}`;
  const out = linkAskRefs(t, envSib);
  assert.ok(out.includes(`[2026-10-06-fake-checklist](${uri('Projects/fake-app/Plans/2026-10-06-fake-checklist')}),`), out);
  assert.ok(out.includes(`[Plans/fake-design.md](${uri('Projects/fake-app/Plans/fake-design')}),`), out);
  assert.ok(out.includes('[#590](https://github.com/o/r/pull/590).'), out);
  assert.ok(out.includes('[AB-12](https://x.atlassian.net/browse/AB-12)'), out);
  assert.ok(out.endsWith(uri('Plans/missing')));
  assert.equal(linkAskRefs('PR https://github.com/o/r/pull/7', undefined), 'PR [#7](https://github.com/o/r/pull/7)');
});

test('shortUrlLabel: GitHub item, ticket, long host, and a short URL left as written', () => {
  assert.equal(shortUrlLabel('https://github.com/o/r/issues/0042'), '#42');
  assert.equal(shortUrlLabel('https://example.test/' + 'a'.repeat(60)), 'example.test/…');
  assert.equal(shortUrlLabel('https://example.test/a'), null);
});

test('the Markdown page nests a long ask context as short bullets under its line, after the answer stub, and leaves a short one on the line', () => {
  const long = 'Pick? Options: (1) go now; (2) wait. Recommend (1). Stakes: it is cheap to undo and the window is short, so waiting costs a day. Ticket fake-1.';
  const lines = render(config(), { awaiting: [item({ id: 'ab12', text: long }), item({ id: 'cd34', text: 'Short? Just this.' })] }).split('\n');
  const i = lines.findIndex((l) => l.startsWith('- [ ] `ab12`'));
  assert.deepEqual(lines.slice(i, i + 7), [
    '- [ ] `ab12` **Pick?**', '  > answer: ', '  - Options:', '  - 1. go now', '  - 2. wait.', '  - Recommend (1).',
    '  - **Stakes:** it is cheap to undo and the window is short, so waiting costs a day. Ticket fake-1.',
  ]);
  assert.ok(lines.includes('- [ ] `cd34` **Short?** Just this.'));
});

test('an answer typed under a laid-out context survives carryInline and fillStub, with no second stub', () => {
  const long = 'Pick? Options: (1) go now; (2) wait. Recommend (1). Stakes: it is cheap to undo and the window is short, so waiting costs a day. Ticket fake-1.';
  const page = render(config(), { awaiting: [item({ id: 'ab12', text: long, answer: '1' })] });
  const carried = carryInline(page, { answers: { ab12: 'actually 2' }, discuss: {}, ticks: [], priorities: null }, page);
  assert.equal(carried.split('\n').filter((l) => l.includes('> answer:')).length, 1, carried);
  assert.ok(carried.includes('> answer: actually 2'), carried);
  const empty = render(config(), { awaiting: [item({ id: 'ab12', text: long })] });
  const filled = fillStub(empty, 'ab12', 'go') as string;
  assert.equal(filled.split('\n').filter((l) => l.includes('> answer:')).length, 1, filled);
});

test('linkAskRefs leaves an existing Markdown link and a code span exactly as written', () => {
  const t = 'See [the PR](https://github.com/o/r/pull/5) first, spec at `Plans/fake-design.md`, and `https://github.com/o/r/pull/6`, then https://github.com/o/r/pull/7.';
  const out = linkAskRefs(t, envSib);
  assert.equal(out, t.replace('then https://github.com/o/r/pull/7.', 'then [#7](https://github.com/o/r/pull/7).'));
});
