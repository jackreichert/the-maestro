// Run: node --test scripts/lib/home/epic-docs.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReader } from '../vault/reader.ts';
import { loadTickets, TICKET_DIR_SCOPES, TICKET_FILE_SCOPES } from '../vault/tickets.ts';
import { buildFixture } from '../vault/fixture.ts';
import type { PageConfig } from '../status-page/render.ts';
import { validateHomes } from './config.ts';
import { buildStreamHome } from './build.ts';
import { DOC_DIR_SCOPES, DOC_FILE_SCOPES, docHeader, loadDocs } from './docs.ts';
import type { Doc } from './docs.ts';
import { externalLinks } from './epic-docs.ts';

const NOW = new Date('2026-10-07T12:00:00Z');
const PAGE: PageConfig = { streams: [], repoStreams: {}, vaultName: 'Vault', trackerUrlBase: 'https://tracker.test/browse/', ticketNotePath: '', trackerKeyPattern: '\\b[A-Z][A-Z0-9]+-\\d+\\b', tz: 'UTC' };
const STREAMS = ['Avonlea', 'Green Gables'];
const fx = buildFixture();
const READER = createReader({ root: fx.root, dirScopes: [...TICKET_DIR_SCOPES, ...DOC_DIR_SCOPES], fileScopes: [...TICKET_FILE_SCOPES, ...DOC_FILE_SCOPES] });
const vault = loadTickets(READER, fx.root);

const fm = (lines: string[], title = 'A note'): string => `---\n${lines.join('\n')}\n---\n# ${title}\n`;
const doc = (project: string, folder: Doc['folder'], name: string, head: string): Doc => ({ path: `Projects/${project}/${folder}/${name}.md`, folder, project, ...docHeader(head, `${name}.md`, folder) });

test('the header reads ticket, tickets and epic, the first date alias, and the kind from kind, type, then folder', () => {
  const a = docHeader(fm(['ticket: t-1', 'last-updated: 2026-10-01', 'type: runbook']), 'a.md', 'Plans');
  assert.deepEqual([a.tickets, a.updated, a.kind], [['t-1'], '2026-10-01', 'runbook']);
  const b = docHeader(fm(['tickets: [t-2, "t-3"]', 'epic: t-2', 'kind: uat', 'type: plan', 'updated: 2026-10-05', 'date: 2020-01-01']), 'b.md', 'Research');
  assert.deepEqual([b.tickets, b.updated, b.kind], [['t-2', 't-3'], '2026-10-05', 'uat']);
  assert.equal(docHeader(fm(['title: x']), 'c.md', 'Reviews').kind, 'review');
  assert.equal(docHeader(fm(['type: nonsense']), 'd.md', 'Research').kind, 'research', 'an unknown kind falls back to the folder');
  assert.deepEqual(docHeader(fm(['ticket: none']), 'e.md', 'Plans'), { ...docHeader(fm(['ticket: none']), 'e.md', 'Plans'), tickets: [], projectLevel: true });
  assert.deepEqual(docHeader(fm(['ticket: ../../x y']), 'f.md', 'Plans').tickets, [], 'text that is not an id names no ticket');
});

test('a document for a child ticket lands on its epic, across projects, and leaves the rail', () => {
  const docs: Record<string, Doc[]> = {
    'avonlea-api': [
      doc('avonlea-api', 'Plans', 'child-plan', fm(['ticket: avonlea-api-046', 'updated: 2026-10-06', 'status: active'], 'Child plan')),
      doc('avonlea-api', 'Plans', 'unrelated', fm(['ticket: green-gables-001'], 'Other epic plan')),
      doc('avonlea-api', 'Research', 'loose', fm(['updated: 2026-10-05'], 'Loose note')),
      doc('avonlea-api', 'Research', 'old-loose', fm(['updated: 2026-01-05'], 'Old loose note')),
      doc('avonlea-api', 'Research', 'project-level', fm(['ticket: none', 'updated: 2026-10-05'], 'Project level')),
    ],
  };
  const h = buildStreamHome({
    stream: 'Avonlea', streams: STREAMS, now: NOW, vault, homes: validateHomes({ version: 1, streams: { Avonlea: { epics: ['avonlea-api-042'] } } }, STREAMS), ledger: [], prs: [],
    prData: { fetchedAt: NOW }, page: PAGE, readDocs: (p) => ({ docs: docs[p] ?? [], notes: [] }),
  });
  const e = h.epics.find((x) => x.id === 'avonlea-api-042');
  assert.ok(e);
  assert.deepEqual(e.docs.groups.map((g) => [g.kind, g.items.map((i) => i.title)]), [['plan', ['Child plan']]]);
  assert.equal(e.docs.groups[0]?.items[0]?.ticket, 'avonlea-api-046');
  assert.equal(e.docs.groups[0]?.items[0]?.url, 'obsidian://open?vault=Vault&file=Projects%2Favonlea-api%2FPlans%2Fchild-plan');
  assert.equal(e.docs.unattributedRecent, 1, 'only the loose note updated within 30 days counts; ticket: none and the old one do not');
  const railLabels = h.links.filter((g) => g.group === 'docs').flatMap((g) => g.items.map((i) => i.label));
  assert.ok(!railLabels.includes('Child plan'), 'a document shown on the epic is not listed on the rail again');
  assert.ok(railLabels.includes('Other epic plan') && railLabels.includes('Loose note'));
});

test('outside links come only from the epic ticket Links section and only as http or https', () => {
  const body = ['## Goal', '- [not here](https://a.test/x)', '## Links', '- [UAT sheet](https://docs.test/uat) · uat', '- [bad](javascript:alert(1))', '- [creds](https://u:p@h.test/x)', '- [plain](http://ok.test/y)', '_None_', '## Estimate'].join('\n');
  assert.deepEqual(externalLinks(body), [{ label: 'UAT sheet', url: 'https://docs.test/uat', kind: 'uat' }, { label: 'plain', url: 'http://ok.test/y', kind: 'other' }]);
  assert.deepEqual(externalLinks('no links section'), []);
});

test('a real vault reads every folder and a document naming a missing ticket is shown nowhere', () => {
  const real = loadDocs(READER, 'avonlea-api');
  assert.ok(real.docs.every((d) => d.project === 'avonlea-api' && Array.isArray(d.tickets)));
  const h = buildStreamHome({ stream: 'Avonlea', streams: STREAMS, now: NOW, vault, homes: validateHomes({ version: 1, streams: { Avonlea: { epics: ['avonlea-api-042'] } } }, STREAMS), ledger: [], prs: [], prData: { fetchedAt: NOW }, page: PAGE, readDocs: (p) => loadDocs(READER, p) });
  assert.ok(h.epics.every((e) => e.docs.groups.every((g) => g.items.every((i) => i.ticket !== 'ghost-999'))));
});
