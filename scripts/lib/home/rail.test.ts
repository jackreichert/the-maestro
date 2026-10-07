// Run: node --test scripts/lib/home/rail.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReader } from '../vault/reader.ts';
import { loadTickets, TICKET_DIR_SCOPES, TICKET_FILE_SCOPES } from '../vault/tickets.ts';
import { assertNoCanary, buildFixture } from '../vault/fixture.ts';
import type { PageConfig, Pr } from '../status-page/render.ts';
import { validateHomes } from './config.ts';
import { buildStreamHome } from './build.ts';
import type { HomeInput } from './build.ts';
import { DOC_DIR_SCOPES, DOC_FILE_SCOPES, docHeader, loadDocs } from './docs.ts';
import { prsNaming } from './prs.ts';

const NOW = new Date('2026-10-07T12:00:00Z');
const PAGE: PageConfig = { streams: [], repoStreams: {}, vaultName: 'Vault', trackerUrlBase: 'https://tracker.test/browse/', ticketNotePath: '', trackerKeyPattern: '\\b[A-Z][A-Z0-9]+-\\d+\\b', tz: 'UTC' };
const STREAMS = ['Avonlea', 'Green Gables'];
const fx = buildFixture();
const READER = createReader({ root: fx.root, dirScopes: [...TICKET_DIR_SCOPES, ...DOC_DIR_SCOPES], fileScopes: [...TICKET_FILE_SCOPES, ...DOC_FILE_SCOPES] });
const vault = loadTickets(READER, fx.root);
const pr = (number: number, head: string, title: string, over: Partial<Pr> = {}): Pr => ({
  number, title, url: `https://github.test/acme/avonlea-api/pull/${number}`, isDraft: false, baseRefName: 'develop', headRefName: head, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null,
  repo: 'acme/avonlea-api', short: 'avonlea-api', owner: 'acme', unresolved: 0, ci: 'SUCCESS', stream: 'Avonlea', ...over,
});
const home = (over: Partial<HomeInput> & { config?: object } = {}) => {
  const { config, ...rest } = over;
  return buildStreamHome({ stream: 'Avonlea', streams: STREAMS, now: NOW, vault, homes: validateHomes({ version: 1, streams: config ?? { Avonlea: { epics: ['avonlea-api-042'], projects: ['avonlea-api'] } } }, STREAMS),
    ledger: [], prs: [], prData: { fetchedAt: NOW }, page: PAGE, readDocs: (p) => loadDocs(READER, p), ...rest });
};

test('prsNaming matches an id or key at a token boundary and caps at three', () => {
  const prs = [pr(1, 'feat/avonlea-api-051-x', 'x'), pr(2, 'feat/other', 'Fix AV-1202 retry'), pr(3, 'feat/avonlea-api-0510', 'y'), pr(4, 'a', 'avonlea-api-05'), pr(5, 'avonlea-api-051', 'z'), pr(6, 'avonlea-api-051', 'z'), pr(7, 'avonlea-api-051', 'z')];
  assert.deepEqual(prsNaming(prs, ['avonlea-api-051']).shown.map((r) => r.label), ['avonlea-api#1', 'avonlea-api#5', 'avonlea-api#6']);
  assert.equal(prsNaming(prs, ['avonlea-api-051']).more, 1);
  assert.deepEqual(prsNaming(prs, ['avonlea-api-045', 'AV-1202']).shown.map((r) => r.label), ['avonlea-api#2']);
  assert.deepEqual(prsNaming(prs, ['avonlea-api-05']).shown.map((r) => r.label), ['avonlea-api#4'], '05 does not match 051 or 0510');
  assert.deepEqual(prsNaming(prs, ['']), { shown: [], more: 0 });
});

test('a PR that names a ticket id is on that ticket row, and one that names nothing stays out', () => {
  const h = home({ prs: [pr(412, 'feat/avonlea-api-045-backfill', 'Backfill'), pr(500, 'chore/unrelated', 'Tidy the readme')] });
  const row = h.left.inProgress.find((r) => r.id === 'avonlea-api-045');
  assert.deepEqual(row?.prs, [{ label: 'avonlea-api#412', url: 'https://github.test/acme/avonlea-api/pull/412' }]);
  assert.ok(![...h.left.inProgress, ...h.left.blocked, ...h.left.notStarted].some((r) => r.prs.some((p) => p.label.endsWith('#500'))));
  assert.equal(h.epics[0]?.next?.prs[0]?.label, 'avonlea-api#412');
});

test('the rail has its groups in the stated order, built by the server, with pins validated', () => {
  const h = home({
    config: { Avonlea: { epics: ['avonlea-api-042'], projects: ['avonlea-api'], pins: [{ label: 'Dashboard', url: 'https://dash.example.com/d/1' }, { label: 'Checklist', note: 'Projects/avonlea-api/Plans/c.md' }, { label: 'bad', url: 'javascript:alert(1)' }], runbooks: ['Projects/avonlea-api/Runbooks/extra.md'] } },
    prs: [pr(412, 'feat/avonlea-api-045', 'x'), pr(9, 'z', 'Other stream PR', { stream: 'Green Gables' })],
  });
  assert.deepEqual(h.links.map((g) => g.group), ['pinned', 'epics', 'docs', 'prs', 'runbooks']);
  const by = Object.fromEntries(h.links.map((g) => [g.group, g.items]));
  assert.deepEqual(by.pinned?.map((l) => [l.kind, l.url]), [['web', 'https://dash.example.com/d/1'], ['note', 'obsidian://open?vault=Vault&file=Projects%2Favonlea-api%2FPlans%2Fc']]);
  assert.deepEqual(by.epics?.map((l) => [l.label, l.kind]), [['avonlea-api-042', 'note'], ['AV-1201', 'tracker']]);
  assert.deepEqual(by.prs?.map((l) => l.label), ['avonlea-api#412'], 'only this stream\'s PRs');
  assert.deepEqual(by.docs?.map((l) => l.label), ['Avonlea API context', 'Decisions', 'Cutover plan', 'Old plan', 'Research notes']);
  assert.deepEqual(by.runbooks?.map((l) => l.label), ['extra', 'Cutover runbook']);
  for (const l of h.links.flatMap((g) => g.items)) assert.match(l.url, /^(https?:\/\/|obsidian:\/\/open\?vault=Vault&file=[^&]+$)/, l.url);
});

test('an unsafe pin that slipped past config is still dropped by the rail', () => {
  const h = home({ homes: { found: true, warnings: [], streams: { Avonlea: { projects: [], epics: ['avonlea-api-042'], exclude: [], done: {}, docs: [], runbooks: [], pins: [{ label: 'x', url: 'javascript:alert(1)' }, { label: 'y', url: 'data:text/html,1' }] } } } });
  assert.ok(!h.links.some((g) => g.group === 'pinned'));
});

test('groups are capped at 50 with a count of the rest', () => {
  const prs = Array.from({ length: 53 }, (_, i) => pr(1000 + i, 'x', 'x'));
  const g = home({ prs }).links.find((x) => x.group === 'prs');
  assert.equal(g?.items.length, 50);
  assert.equal(g?.more, 3);
});

test('a mapped project with no CONTEXT or DECISIONS is an unknown, and docs read only a header', () => {
  const h = home({ config: { Avonlea: { epics: ['avonlea-api-042'], projects: ['avonlea-api', 'green-gables'] } } });
  assert.ok(h.unknowns.some((u) => u.kind === 'missing-context' && /green-gables/.test(u.text)));
  assert.deepEqual(docHeader('---\ntitle: "T"\nstatus: active\nupdated: 2026-10-01\n---\n# H1\n', 'f.md'), { title: 'T', status: 'active', updated: '2026-10-01' });
  assert.equal(docHeader('# Heading\ntext', 'f.md').title, 'Heading');
  assert.equal(docHeader('no heading', 'file-name.md').title, 'file-name');
  const big = fx.write;
  big('Projects/avonlea-api/Research/big.md', `# Big\n${'x'.repeat(2 * 1024 * 1024)}`);
  const d = loadDocs(READER, 'avonlea-api');
  assert.ok(d.notes.some((n) => /Research\/big\.md: too-large/.test(n)));
  assert.ok(!d.docs.some((x) => x.path.endsWith('big.md')));
});

test('no canary and no absolute path appears anywhere in the home base, decoys beside the docs included', () => {
  const out = JSON.stringify(home({ prs: [pr(412, 'feat/avonlea-api-045', 'x')] }));
  assertNoCanary(out);
  assert.ok(!out.includes(fx.root) && !out.includes(fx.outside));
  assert.ok(!/\.env|ssm-test|tfvars|tfstate|id_ed25519|\.npmrc|credentials/.test(out), 'no denied name is echoed');
});
