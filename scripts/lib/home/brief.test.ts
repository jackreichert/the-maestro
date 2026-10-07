// Run: node --test scripts/lib/home/brief.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReader } from '../vault/reader.ts';
import { buildForest, loadTickets, TICKET_DIR_SCOPES, TICKET_FILE_SCOPES } from '../vault/tickets.ts';
import { buildFixture } from '../vault/fixture.ts';
import type { PageConfig } from '../status-page/render.ts';
import { validateHomes } from './config.ts';
import { buildStreamHome } from './build.ts';
import { BRIEF_DIR_SCOPES, BRIEF_FILE_SCOPES, forestBasis, judgeBrief, noteIndex, parseBlocks, readBriefNote } from './brief.ts';
import type { BriefInput } from './brief.ts';
import type { Inline } from './types.ts';

const NOW = new Date('2026-10-07T12:00:00Z');
const PAGE: PageConfig = { streams: [], repoStreams: {}, vaultName: 'Vault', trackerUrlBase: 'https://tracker.test/browse/', ticketNotePath: '', trackerKeyPattern: '\\b[A-Z][A-Z0-9]+-\\d+\\b', tz: 'UTC' };
const STREAMS = ['Avonlea', 'Green Gables'];
const env = { vaultName: 'Vault', index: noteIndex([{ id: 'avonlea-api-042', path: 'Projects/avonlea-api/Tickets/avonlea-api-042.md' }, { path: 'Projects/avonlea-api/Plans/runbook-a.md' }, { path: 'Projects/avonlea-api/Plans/twin.md' }, { path: 'Projects/other/Plans/twin.md' }]) };
const text = (runs: Inline[]): string => runs.map((r) => r.text).join('');
const links = (runs: Inline[]): string[] => runs.flatMap((r) => (r.link ? [r.link.url] : []));

test('hostile input becomes text: no raw HTML, no javascript link, no unknown wikilink, no path wikilink to a secret', () => {
  const body = ['# T', '## Goal', '<script>alert(1)</script> and [x](javascript:alert(1)) and ![img](https://e.test/a.png)', '', '[[../../.env]] [[nope]] [[twin]] [[runbook-a|the runbook]] [[avonlea-api-042]]', '', '```', '| a | b |', '```'].join('\n');
  const blocks = parseBlocks(body, env, null);
  assert.ok(!links(blocks.flatMap((b) => ('runs' in b ? b.runs : []))).some((u) => u.startsWith('javascript:')));
  const paras = blocks.filter((b) => b.type === 'paragraph').map((b) => ('runs' in b ? b.runs : []));
  assert.equal(links(paras[0] ?? []).length, 0, 'a javascript link and an image give no link');
  assert.match(text(paras[0] ?? []), /<script>alert\(1\)<\/script>/, 'HTML stays as text');
  const wiki = paras[1] ?? [];
  assert.deepEqual(links(wiki), ['obsidian://open?vault=Vault&file=Projects%2Favonlea-api%2FPlans%2Frunbook-a', 'obsidian://open?vault=Vault&file=Projects%2Favonlea-api%2FTickets%2Favonlea-api-042']);
  assert.match(text(wiki), /\.\.\/\.\.\/\.env nope twin the runbook/, 'unknown, escaping and ambiguous names stay plain text');
  assert.ok(blocks.every((b) => b.type !== 'heading' || b.level === 3 || b.level === 4));
});

test('the What done looks like section is the ticket text, never a second copy', () => {
  const blocks = parseBlocks(['# T', '## Goal', 'One.', '## What done looks like', 'my own copy', '- of the text', '## Risks', '- a risk'].join('\n'), env, 'From the ticket.');
  const flat = JSON.stringify(blocks);
  assert.ok(!flat.includes('my own copy') && flat.includes('From the ticket.') && flat.includes('a risk'));
  assert.ok(!JSON.stringify(parseBlocks('## What done looks like\nx', env, null)).includes('What done'), 'no ticket text, no slot');
});

test('lists keep one level of nesting and quotes are their own block', () => {
  const [list, quote] = parseBlocks(['- a', '  - b', '- c', '', '> said'].join('\n'), env, null);
  assert.equal(list?.type, 'list');
  assert.deepEqual(list?.type === 'list' ? list.items.map((i) => [text(i.runs), i.children.length]) : [], [['a', 1], ['c', 0]]);
  assert.equal(quote?.type, 'quote');
});

const FP = 'closed 3 of 10 · blocked 1 · points 5 of 20 · open';
const base = (over: Partial<BriefInput> = {}): BriefInput => ({
  epic: 'e-1', read: { ok: true, text: '' }, basis: FP, ticketDates: [], docDates: [], doneMeans: null, link: env, ref: { label: 'e-1 brief' }, ...over,
});
const note = (basis: string, updated = '2026-10-07'): { ok: true; text: string } => ({ ok: true, text: `---\nkind: brief\nupdated: ${updated}\nbasis: "${basis}"\n---\n# e-1 brief\n## Goal\nShip it.\n` });

test('a brief is stale on a same-day state change, a later ticket or document, or a missing date or basis', () => {
  const fp = FP;
  assert.equal(judgeBrief(base({ read: note(fp) })).state, 'fresh');
  const moved = judgeBrief(base({ read: note('closed 2 of 10 · blocked 1 · points 5 of 20 · open') }));
  assert.equal(moved.state, 'stale');
  assert.match(moved.staleBecause?.[0] ?? '', /changed since it was written/);
  const later = judgeBrief(base({ read: note(fp, '2026-10-05'), ticketDates: ['2026-10-06', '2026-10-05', undefined], docDates: ['2026-10-07'] }));
  assert.deepEqual(later.staleBecause, ['1 ticket updated after 2026-10-05', '1 document updated after 2026-10-05']);
  assert.equal(judgeBrief(base({ read: { ok: true, text: '# no frontmatter' } })).state, 'stale');
  assert.equal(judgeBrief(base({ read: { ok: false, reason: 'missing' } })).state, 'missing');
  assert.equal(judgeBrief(base({ read: { ok: false, reason: 'too-large' } })).state, 'too-long');
});

test('the reader serves only Briefs/<id>.md, refuses a symlinked or oversized brief, and a bad id reads nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'brief-'));
  mkdirSync(join(root, 'Projects/p/Briefs'), { recursive: true });
  writeFileSync(join(root, 'Projects/p/Briefs/ok.md'), note('x').text);
  writeFileSync(join(root, 'Projects/p/Briefs/big.md'), 'x'.repeat(9000));
  writeFileSync(join(root, 'secret-target.md'), 'canary-text');
  symlinkSync(join(root, 'secret-target.md'), join(root, 'Projects/p/Briefs/link.md'));
  const reader = createReader({ root, dirScopes: BRIEF_DIR_SCOPES, fileScopes: BRIEF_FILE_SCOPES });
  assert.equal(readBriefNote(reader, 'p', 'ok').ok, true);
  assert.deepEqual(readBriefNote(reader, 'p', 'big'), { ok: false, reason: 'too-large' });
  assert.equal(readBriefNote(reader, 'p', 'link').ok, false);
  assert.deepEqual(readBriefNote(reader, 'p', '../ok'), { ok: false, reason: 'missing' });
  assert.deepEqual(readBriefNote(reader, 'p', 'absent'), { ok: false, reason: 'missing' });
});

test('an open epic without a fresh brief produces one unknown with the fix, and the count lands on its card', () => {
  const fx = buildFixture();
  const reader = createReader({ root: fx.root, dirScopes: TICKET_DIR_SCOPES, fileScopes: TICKET_FILE_SCOPES });
  const vault = loadTickets(reader, fx.root);
  const h = buildStreamHome({
    stream: 'Avonlea', streams: STREAMS, now: NOW, vault, homes: validateHomes({ version: 1, streams: { Avonlea: { epics: ['avonlea-api-042'] } } }, STREAMS), ledger: [], prs: [], prData: { fetchedAt: NOW }, page: PAGE,
    readDocs: () => ({ docs: [], notes: [] }), readBrief: () => ({ ok: false, reason: 'missing' }),
  });
  const e = h.epics.find((x) => x.id === 'avonlea-api-042');
  assert.equal(e?.brief.state, 'missing');
  const u = h.unknowns.filter((x) => x.kind === 'brief-missing' && x.epic === 'avonlea-api-042');
  assert.equal(u.length, 1);
  assert.match(u[0]?.text ?? '', /ticket\.mjs brief avonlea-api-042/);
  assert.ok((e?.unknowns ?? 0) >= 1);
});

test('the fingerprint is the exact line ticket.mjs brief writes, read from the forest rollup', () => {
  const fx = buildFixture();
  const reader = createReader({ root: fx.root, dirScopes: TICKET_DIR_SCOPES, fileScopes: TICKET_FILE_SCOPES });
  const forest = buildForest(loadTickets(reader, fx.root).tickets);
  const r = forest.roll('avonlea-api-042');
  assert.equal(forestBasis(forest, 'avonlea-api-042'), `closed ${r.closed} of ${r.total} · blocked ${r.blocked} · points ${r.ptsDone} of ${r.ptsTotal} · in-progress`);
  assert.match(forestBasis(forest, 'avonlea-api-042'), /^closed \d+ of \d+ · blocked \d+ · points \d+ of \d+ · [a-z-]+$/);
});

test('an id shared by two notes links to nothing, even when a base name would match', () => {
  const idx = noteIndex([{ id: 'dup-1', path: 'Projects/a/Tickets/dup-1.md' }, { id: 'dup-1', path: 'Projects/b/Tickets/dup-1.md' }, { path: 'Projects/a/Plans/dup-1.md' }]);
  assert.equal(idx.resolve('dup-1'), null);
});
