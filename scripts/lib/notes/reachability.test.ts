// Run: node --test scripts/lib/notes/reachability.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildForest, loadTickets, TICKET_DIR_SCOPES, TICKET_FILE_SCOPES } from '../vault/tickets.ts';
import { createReader } from '../vault/reader.ts';
import { buildFixture } from '../vault/fixture.ts';
import { validateHomes } from '../home/config.ts';
import { docHeader } from '../home/docs.ts';
import type { Doc, DocFolder } from '../home/docs.ts';
import { reachability, reachabilityLines } from './reachability.ts';

const STREAMS = ['Avonlea', 'Green Gables'];
const fx = buildFixture();
const loaded = loadTickets(createReader({ root: fx.root, dirScopes: TICKET_DIR_SCOPES, fileScopes: TICKET_FILE_SCOPES }), fx.root);
const forest = buildForest(loaded.tickets);
const project = (id: string): string => forest.byId.get(id)?.project ?? '';
const homes = (streams: Record<string, object>) => validateHomes({ version: 1, streams }, STREAMS);
const CLAIM = homes({ Avonlea: { epics: ['avonlea-api-042'] }, 'Green Gables': { epics: ['green-gables-001'] } });

const fm = (lines: string[]): string => `---\n${lines.join('\n')}\n---\n# A note\n`;
const doc = (name: string, lines: string[], folder: DocFolder = 'Plans', proj = project('avonlea-api-042')): Doc =>
  ({ path: `Projects/${proj}/${folder}/${name}.md`, folder, project: proj, ...docHeader(fm(lines), `${name}.md`, folder) });
const run = (docs: Doc[], over: Partial<Parameters<typeof reachability>[0]> = {}) =>
  reachability({ streams: STREAMS, active: ['Avonlea'], homes: CLAIM, forest, links: [], docsOf: (p) => ({ docs: docs.filter((d) => d.project === p), notes: [] }), ...over });
const why = (r: ReturnType<typeof run>, name: string): string | undefined => r.unreachable.find((u) => u.path.endsWith(`/${name}.md`))?.reason;

test('a note is reachable by CONTEXT, a ticket in a claimed tree, a stream field, a pin, or ticket none with stream none', () => {
  const p = project('avonlea-api-042');
  const pinned = homes({ Avonlea: { epics: ['avonlea-api-042'], docs: [`Projects/${p}/Plans/pinned.md`] } });
  const r = run([
    doc('CONTEXT', [], 'CONTEXT'), doc('attributed', ['ticket: avonlea-api-045']), doc('tagged', ['stream: Avonlea']),
    doc('pinned', []), doc('offtab', ['ticket: none', 'stream: none']),
  ], { homes: pinned });
  assert.deepEqual(r.unreachable, []);
  assert.equal(r.checked, 5);
});

test('each way a note can be unreachable has its own reason and a fix naming the note', () => {
  const r = run([
    doc('bare', []), doc('ghost', ['ticket: no-such-ticket']), doc('wrongstream', ['stream: Nowhere']),
    doc('half', ['stream: none']), doc('elsewhere', ['ticket: green-gables-003']),
  ]);
  assert.match(why(r, 'bare') ?? '', /names no ticket and no stream/);
  assert.match(why(r, 'ghost') ?? '', /not in the vault/);
  assert.match(why(r, 'wrongstream') ?? '', /"Nowhere" is not a known stream/);
  assert.match(why(r, 'half') ?? '', /stream: none.*not `ticket: none`/);
  assert.equal(why(r, 'elsewhere'), undefined, 'a ticket in another stream is still on a tab');
  const bare = r.unreachable.find((u) => u.path.endsWith('/bare.md'));
  assert.match(bare?.fix ?? '', /stream: Avonlea.*ticket\.mjs attach <ticket> Projects\/.*bare\.md --kind plan/);
});

test('a ticket in an unclaimed or an ambiguous tree is named as such', () => {
  const tied = homes({ Avonlea: { epics: ['avonlea-api-042'] }, 'Green Gables': { epics: ['avonlea-api-042'] } });
  const a = run([doc('x', ['ticket: avonlea-api-045'])], { homes: tied });
  assert.match(why(a, 'x') ?? '', /ambiguous between Avonlea and Green Gables/);
  const none = run([doc('y', ['ticket: avonlea-api-045'])], { homes: homes({ Avonlea: { projects: [project('avonlea-api-042')] } }), streams: [] });
  assert.match(why(none, 'y') ?? '', /in no stream/);
});

test('only active streams are checked, notes are counted per stream, and since skips older dated notes', () => {
  const g = project('green-gables-001');
  const docs = [doc('bare', [], 'Plans'), doc('old', ['updated: 2026-01-01']), doc('theirs', [], 'Plans', g)];
  const onlyA = run(docs);
  assert.deepEqual(onlyA.unreachable.map((u) => u.path.split('/').pop()).sort(), ['bare.md', 'old.md'], 'Green Gables is not active, so its project is not checked');
  assert.equal(run(docs, { since: '2026-09-01' }).unreachable.some((u) => u.path.endsWith('old.md')), false);
  const both = run(docs, { active: ['Avonlea', 'Green Gables'] });
  assert.equal((both.byStream['Avonlea'] ?? 0) > 0, true);
  assert.equal(both.byStream['Green Gables'] !== undefined, true);
});

test('the lines name the count, each note and its fix, and cap a long list with a pointer', () => {
  const many = Array.from({ length: 25 }, (_, n) => doc(`n${n}`, []));
  const lines = reachabilityLines(run(many), 3);
  assert.match(lines[0] ?? '', /^Notes reachability: 25 of 25 notes \(in the projects of 1 active stream\) are listed on no stream tab \(Avonlea 25\)\.$/);
  assert.equal(lines.filter((l) => l.startsWith('  - ')).length, 3);
  assert.match(lines.at(-1) ?? '', /\+22 more/);
  assert.equal(reachabilityLines(run([doc('CONTEXT', [], 'CONTEXT')])).length, 1);
});
