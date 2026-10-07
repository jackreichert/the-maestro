// Run: node --test scripts/lib/vault/tickets.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildForest, loadTickets, parseTicket, pointsOf, TICKET_DIR_SCOPES, TICKET_FILE_SCOPES } from './tickets.ts';
import { createReader } from './reader.ts';
import { assertNoCanary, buildFixture, snapshot } from './fixture.ts';

const load = (root: string) => loadTickets(createReader({ root, dirScopes: TICKET_DIR_SCOPES, fileScopes: TICKET_FILE_SCOPES }), root);

test('loading the fixture vault reads real tickets and turns every refusal into an issue, never an error', () => {
  const fx = buildFixture();
  const before = snapshot(fx.root);
  const { tickets, issues, projects } = load(fx.root);
  assert.deepEqual(projects, ['avonlea-api', 'green-gables', 'loop-lab']);
  const ids = tickets.map((t) => t.id);
  assert.ok(ids.includes('avonlea-api-042') && ids.includes('avonlea-api-051'), 'archive is read');
  assert.ok(!ids.includes('avonlea-api-999') && !ids.includes('avonlea-api-998') && !ids.includes('outside-001'), 'huge, unreadable and symlinked notes are not tickets');
  assert.equal(tickets.find((t) => t.id === 'avonlea-api-051')?.archived, true);
  const byReason = Object.fromEntries(issues.map((i) => [i.path, i.text]));
  assert.match(byReason['Projects/avonlea-api/Tickets/huge.md'] ?? '', /too-large/);
  assert.match(byReason['Projects/avonlea-api/Tickets/locked.md'] ?? '', /unreadable/);
  assert.match(byReason['Projects/avonlea-api/Tickets/no-frontmatter.md'] ?? '', /no frontmatter id/);
  assert.ok(!issues.some((i) => /link\.md/.test(i.text)), 'a symlink is skipped, not reported');
  const out = JSON.stringify({ tickets, issues });
  assertNoCanary(out);
  assert.ok(!out.includes(fx.root) && !out.includes(fx.outside), 'no absolute path in the output');
  assert.equal(snapshot(fx.root), before, 'the vault is byte-identical');
});

test('the parsed ticket carries the fields the home base reads', () => {
  const fx = buildFixture();
  const t = load(fx.root).tickets.find((x) => x.id === 'avonlea-api-045');
  assert.deepEqual([t?.status, t?.points, t?.parent, t?.external, t?.project, t?.updated], ['in-progress', 3, 'avonlea-api-042', 'AV-1202', 'avonlea-api', '2026-09-01']);
  assert.equal(pointsOf('## Estimate\n\n1 story point\n'), 1);
  assert.equal(pointsOf('## Estimate\n\nthree\n'), 0);
  assert.equal(parseTicket('no frontmatter', 'Projects/x/Tickets/a.md'), null);
  assert.equal(parseTicket('---\ntitle: "x"\n---\n', 'Projects/x/Tickets/a.md'), null);
});

test('the forest rolls up recursively, follows parents across projects, and ignores the closing edge of a loop', () => {
  const fx = buildFixture();
  const f = buildForest(load(fx.root).tickets);
  assert.deepEqual(f.roll('avonlea-api-042'), { total: 10, direct: 8, closed: 4, blocked: 1, ptsTotal: 26, ptsDone: 8 });
  assert.deepEqual(f.roll('avonlea-api-048'), { total: 2, direct: 2, closed: 1, blocked: 0, ptsTotal: 10, ptsDone: 2 });
  assert.equal(f.roll('green-gables-001').total, 3, 'a child in another project counts');
  assert.equal(f.roll('avonlea-api-060').total, 0);
  assert.equal(f.roll('nope').total, 0);
  assert.equal(f.cycles.length, 1);
  assert.equal(f.parentOf.has('loop-lab-001') && f.parentOf.has('loop-lab-002'), false, 'one edge of the loop is dropped');
});

test('a second load of an unchanged vault serves parsed notes from the cache, and an edit shows on the next load', () => {
  const fx = buildFixture();
  assert.equal(load(fx.root).tickets.find((t) => t.id === 'avonlea-api-060')?.status, 'open');
  fx.write('Projects/avonlea-api/Tickets/avonlea-api-060.md', '---\nid: "avonlea-api-060"\ntitle: "A loose fix"\nstatus: "closed"\n---\nlonger body now\n');
  assert.equal(load(fx.root).tickets.find((t) => t.id === 'avonlea-api-060')?.status, 'closed');
});

test('a note with a long run of blank lines under the estimate heading is parsed in linear time', () => {
  const body = `## Estimate\n${'\n'.repeat(200_000)}no number here\n`;
  const t0 = Date.now();
  assert.equal(pointsOf(body), 0);
  assert.ok(Date.now() - t0 < 1000, 'the points pattern has no overlapping quantifiers');
  assert.equal(pointsOf('## Estimate\n\n \n  3 story points\n'), 3);
});
