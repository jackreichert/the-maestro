// Run: node --test scripts/lib/home/mapping.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildForest, loadTickets, TICKET_DIR_SCOPES, TICKET_FILE_SCOPES } from '../vault/tickets.ts';
import { createReader } from '../vault/reader.ts';
import { buildFixture } from '../vault/fixture.ts';
import { validateHomes } from './config.ts';
import { mapUnits, slugOf, subtree } from './mapping.ts';

const STREAMS = ['Avonlea', 'Green Gables'];
const forest = (() => { const fx = buildFixture(); return buildForest(loadTickets(createReader({ root: fx.root, dirScopes: TICKET_DIR_SCOPES, fileScopes: TICKET_FILE_SCOPES }), fx.root).tickets); })();
const homes = (streams: Record<string, object>) => validateHomes({ version: 1, streams }, STREAMS);
const none = homes({});

test('units are root tickets; config can add a nested epic', () => {
  const m = mapUnits(forest, none, STREAMS, []);
  assert.ok(m.units.includes('avonlea-api-042') && m.units.includes('green-gables-001') && m.units.includes('avonlea-api-060'));
  assert.ok(!m.units.includes('avonlea-api-043') && !m.units.includes('avonlea-api-070'), 'children belong to their root');
  assert.ok(mapUnits(forest, homes({ Avonlea: { epics: ['avonlea-api-048'] } }), STREAMS, []).units.includes('avonlea-api-048'));
});

test('rule 1, config: a listed epic is claimed, and exclude removes it from that stream under every rule', () => {
  const claimed = mapUnits(forest, homes({ Avonlea: { epics: ['avonlea-api-042'] } }), STREAMS, []);
  assert.deepEqual(claimed.claims.get('avonlea-api-042'), { stream: 'Avonlea', rule: 'config' });
  const excluded = mapUnits(forest, homes({ Avonlea: { epics: ['avonlea-api-042'], exclude: ['avonlea-api-042'], projects: ['avonlea-api'] } }), STREAMS, [{ stream: 'Avonlea', ticket: 'avonlea-api-045' }]);
  assert.equal(excluded.claims.has('avonlea-api-042'), false);
  const twice = mapUnits(forest, homes({ Avonlea: { epics: ['avonlea-api-042'] }, 'Green Gables': { epics: ['avonlea-api-042'] } }), STREAMS, []);
  assert.deepEqual(twice.ambiguous.get('avonlea-api-042'), { rule: 'config', streams: ['Avonlea', 'Green Gables'] });
});

test('rule 2, ledger: the stream with most linked items in the tree wins, a descendant link counts, and a tie is ambiguous', () => {
  const links = [{ stream: 'Avonlea', ticket: 'avonlea-api-045' }, { stream: 'Avonlea', ticket: 'avonlea-api-049' }, { stream: 'Green Gables', ticket: 'avonlea-api-043' }];
  assert.deepEqual(mapUnits(forest, none, STREAMS, links).claims.get('avonlea-api-042'), { stream: 'Avonlea', rule: 'ledger' });
  const tie = mapUnits(forest, none, STREAMS, [links[0] as never, links[2] as never]);
  assert.equal(tie.claims.has('avonlea-api-042'), false);
  assert.deepEqual(tie.ambiguous.get('avonlea-api-042'), { rule: 'ledger', streams: ['Avonlea', 'Green Gables'] });
});

test('config beats ledger, ledger beats label, label beats project: the first rule that decides wins', () => {
  const links = [{ stream: 'Avonlea', ticket: 'green-gables-003' }];   // the label says Green Gables, the ledger says Avonlea
  assert.equal(mapUnits(forest, none, STREAMS, links).claims.get('green-gables-001')?.stream, 'Avonlea');
  assert.deepEqual(mapUnits(forest, none, STREAMS, []).claims.get('green-gables-001'), { stream: 'Green Gables', rule: 'label' });
  const cfg = homes({ 'Green Gables': { projects: ['green-gables'] }, Avonlea: { epics: ['green-gables-001'] } });
  assert.deepEqual(mapUnits(forest, cfg, STREAMS, []).claims.get('green-gables-001'), { stream: 'Avonlea', rule: 'config' });
});

test('rule 4, project: one owner claims, a project two streams list claims nothing', () => {
  assert.deepEqual(mapUnits(forest, homes({ Avonlea: { projects: ['avonlea-api'] } }), STREAMS, []).claims.get('avonlea-api-060'), { stream: 'Avonlea', rule: 'project' });
  const shared = mapUnits(forest, homes({ Avonlea: { projects: ['avonlea-api'] }, 'Green Gables': { projects: ['avonlea-api'] } }), STREAMS, []);
  assert.equal(shared.claims.has('avonlea-api-060'), false);
  assert.equal(shared.ambiguous.has('avonlea-api-060'), false);
});

test('an epic belongs to at most one stream, and subtree walks every descendant including other projects', () => {
  const m = mapUnits(forest, homes({ Avonlea: { projects: ['avonlea-api'], epics: ['green-gables-001'] } }), STREAMS, []);
  assert.equal(m.claims.get('green-gables-001')?.stream, 'Avonlea');
  assert.deepEqual(subtree(forest, 'green-gables-001').sort(), ['avonlea-api-070', 'green-gables-001', 'green-gables-002', 'green-gables-003']);
  assert.equal(slugOf('Green  Gables!'), 'green-gables');
});
