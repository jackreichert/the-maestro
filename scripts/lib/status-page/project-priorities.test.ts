// Run: node --test scripts/lib/status-page/project-priorities.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { carryPriorities, fanOut, nextItems, parseProjectFile, previousFile, prioritiesDir, projectsFor, projectsWithTodayOn, readProjectFile, renderProjectFile, streamStatus, writeProjectPriorities } from './project-priorities.ts';
import type { ProjectFile } from './project-priorities.ts';
import type { Homes } from '../home/config.ts';
import type { LedgerRow } from '../ledger-core.ts';

const homes: Homes = { found: true, warnings: [], streams: { TeamSelect: { projects: ['arya-scraper', 'arya-avonlea'], epics: [], exclude: [], done: {}, docs: [], runbooks: [], pins: [] } } };
const map = (s: string | undefined): string[] => projectsFor(s, homes, { 'the-maestro': 'Maestro' }, 'dev-env');

const vaultWith = (...projects: string[]): string => {
  const v = mkdtempSync(join(tmpdir(), 'pp-'));
  for (const p of projects) mkdirSync(join(v, 'Projects', p), { recursive: true });
  return v;
};
const file = (over: Partial<ProjectFile> = {}): ProjectFile => ({ project: 'arya-scraper', date: '2026-10-12', carriedFrom: '', writtenBy: 'priorities set', today: [{ text: 'ship it', stream: 'TeamSelect' }], carried: [], next: [], ...over });

test('a stream fans out to its home projects, a repo-mapped stream to its repo, a stream-less item to the container project', () => {
  const out = fanOut([{ text: 'a', stream: 'TeamSelect' }, { text: 'b', stream: 'Maestro' }, { text: 'c' }], map);
  assert.deepEqual([...out.keys()], ['arya-scraper', 'arya-avonlea', 'the-maestro', 'dev-env']);
  assert.deepEqual(out.get('arya-avonlea'), [{ text: 'a', stream: 'TeamSelect' }]);
  assert.deepEqual(out.get('dev-env'), [{ text: 'c' }]);
  assert.deepEqual(map('teamselect'), ['arya-scraper', 'arya-avonlea'], 'stream names match case-insensitively');
  assert.deepEqual(projectsFor('Unknown', { ...homes, streams: {} }, {}, 'dev-env'), ['dev-env']);
});

test('a project name that is not a plain name is refused and dropped', () => {
  assert.throws(() => prioritiesDir('/v', '../x'), /not a project folder name/);
  assert.deepEqual(projectsFor('Bad', { ...homes, streams: { Bad: { ...homes.streams.TeamSelect, projects: [] } } }, { '../x': 'Bad' }, 'dev-env'), ['dev-env'], 'a bad repo name is dropped, leaving the container project');
  assert.throws(() => writeProjectPriorities(vaultWith(), '../x', '2026-10-12', file()), /not a project folder name/);
});

test('streamStatus counts done on the day, in flight, queued and blocked for one stream', () => {
  const rows: LedgerRow[] = [
    { id: 'a1', kind: 'wip', stream: 'Maestro', text: 'x', ts: '2026-10-12T09:00:00Z' },
    { id: 'a2', kind: 'wip', stream: 'Maestro', text: 'y', queued: true, ts: '2026-10-12T09:00:00Z' },
    { id: 'a3', kind: 'wip', stream: 'Maestro', text: 'z', queued: true, ts: '2026-10-12T09:00:00Z' },
    { id: 'a4', kind: 'blocked', stream: 'Maestro', text: 'b', ts: '2026-10-12T09:00:00Z' },
    { id: 'a5', kind: 'wip', stream: 'Maestro', text: 'd', ts: '2026-10-12T09:00:00Z' },
    { id: 'a6', kind: 'done', closes: 'a5', text: 'done', ts: '2026-10-12T10:00:00Z', date: '2026-10-12' },
    { id: 'b1', kind: 'wip', stream: 'Other', text: 'o', ts: '2026-10-12T09:00:00Z' },
  ];
  assert.equal(streamStatus(rows, null, 'Maestro', '2026-10-12'), '1 done, 1 in flight, 2 queued, 1 blocked');
  assert.equal(streamStatus(rows, null, 'Maestro', '2026-10-11'), '0 done, 1 in flight, 2 queued, 1 blocked');
  assert.deepEqual(nextItems(rows, null, ['maestro']).map((n) => n.id), ['a2', 'a3']);
});

test('the file round-trips, and previousFile finds Friday for a Monday', () => {
  const v = vaultWith('arya-scraper');
  const f = file({ carriedFrom: '2026-10-09', carried: [{ item: { text: 'old', stream: 'TeamSelect' }, status: '1 done, 0 in flight, 2 queued, 0 blocked' }], next: [{ id: 'q1', text: 'queued thing' }] });
  assert.equal(writeProjectPriorities(v, 'arya-scraper', '2026-10-12', f), 'written');
  const path = join(prioritiesDir(v, 'arya-scraper'), '2026-10-12.md');
  const text = readFileSync(path, 'utf8');
  assert.match(text, /^---\ntype: priorities\nproject: arya-scraper\ndate: 2026-10-12\ncarried-from: 2026-10-09\nwritten-by: priorities set\n---\n\n## Today\n- ship it \| TeamSelect\n\n## Carried from 2026-10-09\n- old \| TeamSelect · 1 done, 0 in flight, 2 queued, 0 blocked\n\n## Next\n- `q1` queued thing\n$/);
  assert.deepEqual(readProjectFile(path), { date: '2026-10-12', carriedFrom: '2026-10-09', writtenBy: 'priorities set', today: [{ text: 'ship it', stream: 'TeamSelect' }], notSet: false, carriedCount: 1, carried: f.carried });
  writeFileSync(join(prioritiesDir(v, 'arya-scraper'), '2026-10-09.md'), renderProjectFile(file({ date: '2026-10-09' })));
  writeFileSync(join(prioritiesDir(v, 'arya-scraper'), '2026-10-10.md'.replace('10-10', '10-11')), renderProjectFile(file({ date: '2026-10-11' })));
  assert.equal(previousFile(prioritiesDir(v, 'arya-scraper'), '2026-10-12')?.date, '2026-10-11');
  assert.equal(previousFile(prioritiesDir(v, 'arya-scraper'), '2026-10-11')?.date, '2026-10-09', 'strictly before today');
  assert.equal(previousFile(join(v, 'nothing'), '2026-10-12'), null);
});

test('roll never replaces a file priorities set wrote; a set write replaces it; a past day is refused', () => {
  const v = vaultWith('arya-scraper');
  assert.equal(writeProjectPriorities(v, 'arya-scraper', '2026-10-12', file()), 'written');
  assert.equal(writeProjectPriorities(v, 'arya-scraper', '2026-10-12', file({ writtenBy: 'roll-maintenance', today: [] })), 'exists');
  const path = join(prioritiesDir(v, 'arya-scraper'), '2026-10-12.md');
  assert.match(readFileSync(path, 'utf8'), /- ship it \| TeamSelect/);
  assert.equal(writeProjectPriorities(v, 'arya-scraper', '2026-10-12', file({ today: [{ text: 'new list' }] })), 'written');
  assert.match(readFileSync(path, 'utf8'), /- new list/);
  assert.throws(() => writeProjectPriorities(v, 'arya-scraper', '2026-10-13', file()), /before today/);
});

test('a roll file with no confirmed list says not set yet; a project with no vault folder is not created', () => {
  const v = vaultWith('arya-scraper');
  assert.equal(writeProjectPriorities(v, 'arya-scraper', '2026-10-12', file({ writtenBy: 'roll-maintenance', today: [] })), 'written');
  const parsed = readProjectFile(join(prioritiesDir(v, 'arya-scraper'), '2026-10-12.md'));
  assert.deepEqual([parsed?.notSet, parsed?.today], [true, []]);
  assert.equal(writeProjectPriorities(v, 'ghost-project', '2026-10-12', file()), 'no-project');
  assert.throws(() => readFileSync(join(prioritiesDir(v, 'ghost-project'), '2026-10-12.md')));
});

test('a secret-shaped item, status or queued text is withheld, never written', () => {
  const key = `AKIA${'IOSFODNN7EXAMPLE'}`;
  const text = renderProjectFile(file({ today: [{ text: `use ${key} here` }], carriedFrom: '2026-10-09', carried: [{ item: { text: 'ok' }, status: key }], next: [{ id: 'q1', text: key }] }));
  assert.ok(!text.includes(key), 'the value never reaches the file');
  assert.match(text, /\[withheld: secret shape\]/);
  assert.deepEqual(parseProjectFile(text).today, [{ text: '[withheld: secret shape]' }]);
});

test('carryPriorities starts each project from the container list and its own previous file, and never replaces a file already there', () => {
  const v = vaultWith('arya-scraper', 'arya-avonlea', 'dev-env');
  const rows: LedgerRow[] = [{ id: 'q1', kind: 'wip', stream: 'TeamSelect', text: 'queued one', queued: true, ts: '2026-10-09T09:00:00Z' }];
  const base = { vault: v, rows, registry: null, homes, repoStreams: {}, containerProject: 'dev-env' };
  // Friday: the container list, and one project's own file with an extra item.
  assert.equal(writeProjectPriorities(v, 'arya-avonlea', '2026-10-09', file({ project: 'arya-avonlea', date: '2026-10-09', today: [{ text: 'avonlea only', stream: 'TeamSelect' }] })), 'written');
  const container = { date: '2026-10-09', items: [{ text: 'ship it', stream: 'TeamSelect' }, { text: 'plain item' }] };
  // Monday's first check.
  const first = carryPriorities({ ...base, today: '2026-10-12', container });
  assert.deepEqual(first, { written: ['dev-env', 'arya-scraper', 'arya-avonlea'], problems: [] });
  const scraper = readFileSync(join(prioritiesDir(v, 'arya-scraper'), '2026-10-12.md'), 'utf8');
  assert.match(scraper, /written-by: roll-maintenance\n/);
  assert.match(scraper, /carried-from: 2026-10-09\n/);
  assert.match(scraper, /## Today\n- not set yet\n/);
  assert.match(scraper, /## Carried from 2026-10-09\n- ship it \| TeamSelect · 0 done, 0 in flight, 1 queued, 0 blocked\n/);
  assert.match(scraper, /## Next\n- `q1` queued one\n/);
  const avonlea = readFileSync(join(prioritiesDir(v, 'arya-avonlea'), '2026-10-12.md'), 'utf8');
  assert.match(avonlea, /- avonlea only \| TeamSelect/);
  assert.match(avonlea, /- ship it \| TeamSelect/);
  assert.ok(!readFileSync(join(prioritiesDir(v, 'dev-env'), '2026-10-12.md'), 'utf8').includes('ship it'), 'the container project gets only its own (stream-less) item');
  // A second run, and a list a person confirmed first, are left alone.
  writeProjectPriorities(v, 'arya-scraper', '2026-10-12', file({ today: [{ text: 'confirmed' }] }));
  assert.deepEqual(carryPriorities({ ...base, today: '2026-10-12', container }).written, []);
  assert.match(readFileSync(join(prioritiesDir(v, 'arya-scraper'), '2026-10-12.md'), 'utf8'), /- confirmed/);
});

test('carryPriorities: a container list already dated today is today\'s list; a project with nothing to carry gets no file; a missing project folder is a problem', () => {
  const v = vaultWith('arya-scraper', 'dev-env');
  const out = carryPriorities({ vault: v, today: '2026-10-12', rows: [], registry: null, homes, repoStreams: {}, containerProject: 'dev-env', container: { date: '2026-10-12', items: [{ text: 'now', stream: 'TeamSelect' }] } });
  assert.deepEqual(out.written, ['arya-scraper']);
  assert.deepEqual(out.problems, ['arya-avonlea: no vault folder Projects/arya-avonlea']);
  assert.match(readFileSync(join(prioritiesDir(v, 'arya-scraper'), '2026-10-12.md'), 'utf8'), /## Today\n- now \| TeamSelect\n\n?$/);
  assert.deepEqual(carryPriorities({ vault: v, today: '2026-10-12', rows: [], registry: null, homes, repoStreams: {}, containerProject: 'dev-env', container: null }), { written: [], problems: [] });
});

test('parseProjectFile returns who wrote the file and the carried items with their statuses', () => {
  const text = renderProjectFile(file({ writtenBy: 'roll-maintenance', carriedFrom: '2026-10-11', today: [], carried: [{ item: { text: 'old', stream: 'TeamSelect' }, status: '1 done, 0 in flight, 0 queued, 0 blocked' }, { item: { text: 'a · b' }, status: '0 done, 1 in flight, 0 queued, 0 blocked' }] }));
  const parsed = parseProjectFile(text);
  assert.equal(parsed.writtenBy, 'roll-maintenance');
  assert.deepEqual(parsed.carried, [{ item: { text: 'old', stream: 'TeamSelect' }, status: '1 done, 0 in flight, 0 queued, 0 blocked' }, { item: { text: 'a · b' }, status: '0 done, 1 in flight, 0 queued, 0 blocked' }]);
  assert.equal(parseProjectFile(renderProjectFile(file())).writtenBy, 'priorities set');
});

test('projectsWithTodayOn lists the projects with Today items on the day, whoever wrote them, not empty ones or other days', () => {
  const v = vaultWith('a-proj', 'b-proj', 'c-proj', 'd-proj');
  writeProjectPriorities(v, 'a-proj', '2026-10-12', file({ project: 'a-proj' }));
  writeProjectPriorities(v, 'b-proj', '2026-10-12', file({ project: 'b-proj', writtenBy: 'roll-maintenance' }));
  writeProjectPriorities(v, 'd-proj', '2026-10-12', file({ project: 'd-proj', today: [] }));
  writeProjectPriorities(v, 'c-proj', '2026-10-13', file({ project: 'c-proj', date: '2026-10-13' }));
  assert.deepEqual(projectsWithTodayOn(v, '2026-10-12'), ['a-proj', 'b-proj']);
  assert.deepEqual(projectsWithTodayOn(join(v, 'nothing'), '2026-10-12'), []);
});
