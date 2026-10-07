// Run: node --test scripts/lib/journal/epic-briefs.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createReader } from '../vault/reader.ts';
import { buildForest, loadTickets, TICKET_DIR_SCOPES, TICKET_FILE_SCOPES } from '../vault/tickets.ts';
import { buildFixture } from '../vault/fixture.ts';
import { DOC_DIR_SCOPES, DOC_FILE_SCOPES } from '../home/docs.ts';
import { BRIEF_DIR_SCOPES, BRIEF_FILE_SCOPES, forestBasis } from '../home/brief.ts';
import { epicBriefsLines, epicBriefsReport } from './epic-briefs.ts';

const DAY = '2026-10-07';
const EPIC = 'avonlea-api-042';
const setup = () => {
  const fx = buildFixture();
  const root = fx.root;
  const reader = createReader({ root: fx.root, dirScopes: [...TICKET_DIR_SCOPES, ...DOC_DIR_SCOPES, ...BRIEF_DIR_SCOPES], fileScopes: [...TICKET_FILE_SCOPES, ...DOC_FILE_SCOPES, ...BRIEF_FILE_SCOPES] });
  const write = (rel: string, text: string): void => { mkdirSync(join(fx.root, rel, '..'), { recursive: true }); writeFileSync(join(fx.root, rel), text); };
  const basis = forestBasis(buildForest(loadTickets(reader, fx.root).tickets), EPIC);
  const run = (rows: { id?: string; ticket?: string; date?: string }[], over: { ticketMap?: Record<string, string[]>; dateOf?: (ms: number) => string } = {}) =>
    epicBriefsReport({ reader, date: DAY, rows, ticketMap: over.ticketMap ?? {}, dateOf: over.dateOf ?? (() => '2000-01-01'), cacheKey: `t-${Math.random()}` });
  return { write, basis, run, root };
};
const brief = (basis: string, updated = DAY): string => `---\nkind: brief\nepic: ${EPIC}\nupdated: ${updated}\nbasis: "${basis}"\n---\n# brief\n`;

test('an epic a ledger item touched today owes a brief; with a fresh one the report is empty', () => {
  const { write, basis, run } = setup();
  const rows = [{ id: 'a1', ticket: 'avonlea-api-045', date: DAY }];
  const missing = run(rows);
  assert.deepEqual(missing.epics, [EPIC], 'the epic is found by walking up from the child ticket');
  assert.match(missing.failures[0] ?? '', new RegExp(`${EPIC} has no brief`));
  write(`Projects/avonlea-api/Briefs/${EPIC}.md`, brief(basis));
  assert.deepEqual(run(rows).failures, []);
});

test('a brief written against other numbers is stale and the line says why', () => {
  const { write, run } = setup();
  write(`Projects/avonlea-api/Briefs/${EPIC}.md`, brief('closed 1 of 10 · blocked 0 · points 0 of 9 · open'));
  const r = run([{ id: 'a1', ticket: EPIC, date: DAY }]);
  assert.match(r.failures[0] ?? '', /brief is stale: the epic changed since it was written/);
});

test('only today counts, a ticket-map entry counts, and an unknown or closed ticket does not', () => {
  const { run } = setup();
  assert.deepEqual(run([{ id: 'a1', ticket: EPIC, date: '2026-10-06' }]).epics, [], 'yesterday is not today');
  assert.deepEqual(run([{ id: 'ask1', date: DAY }], { ticketMap: { 'avonlea-api-046': ['ask1'] } }).epics, [EPIC]);
  assert.deepEqual(run([{ id: 'x', ticket: 'no-such-ticket', date: DAY }]).epics, []);
  assert.deepEqual(run([{ id: 'c', ticket: 'avonlea-api-043', date: DAY }]).epics, [EPIC], 'a closed child still touches its open epic');
});

test('a note written today that names no ticket is listed, ticket: none and an attributed note are not', () => {
  const { write, basis, run, root } = setup();
  write(`Projects/avonlea-api/Briefs/${EPIC}.md`, brief(basis));
  write('Projects/avonlea-api/Research/loose.md', '# Loose note\n');
  write('Projects/avonlea-api/Research/project-level.md', '---\nticket: none\n---\n# Project level\n');
  write('Projects/avonlea-api/Research/named.md', `---\nticket: ${EPIC}\n---\n# Named\n`);
  const when = new Date(`${DAY}T12:00:00Z`);
  for (const n of ['loose', 'project-level', 'named']) utimesSync(join(root, `Projects/avonlea-api/Research/${n}.md`), when, when);
  const dateOf = (ms: number): string => (Math.abs(ms - when.getTime()) < 3600_000 ? DAY : 'another day');   // the fixture's other notes were written when the test ran
  const rows = [{ id: 'a1', ticket: EPIC, date: DAY }];
  const r = run(rows, { dateOf });
  assert.equal(r.failures.length, 1);
  assert.match(r.failures[0] ?? '', /Research\/loose\.md was written today.*ticket\.mjs attach/);
  assert.deepEqual(run(rows, { dateOf: () => '2000-01-01' }).failures, [], 'a note not written on the day is not owed');
  assert.match(epicBriefsLines(r).join('\n'), /Epic briefs and documents \(1 to fix, 1 epic touched today\)/);
  assert.deepEqual(epicBriefsLines({ epics: [], failures: [] }), []);
});
