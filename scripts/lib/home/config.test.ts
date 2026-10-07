// Run: node --test scripts/lib/home/config.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOMES_FILE, isHttpUrl, isVaultNote, readHomes, validateHomes } from './config.ts';

const KNOWN = ['Avonlea', 'Green Gables'];
const good = { version: 1, streams: { avonlea: {
  projects: ['avonlea-api'], epics: ['avonlea-api-042'], exclude: ['avonlea-api-031'], done: { 'avonlea-api-042': 'verified' },
  docs: ['Projects/avonlea-api/Plans/x.md'], runbooks: ['Projects/avonlea-api/Runbooks/cutover.md'],
  pins: [{ label: 'Dashboard', url: 'https://dash.example.com/d/1' }, { label: 'Checklist', note: 'Projects/avonlea-api/Plans/c.md' }],
} } };

test('a valid entry is kept whole, and the stream name is folded to the known spelling', () => {
  const h = validateHomes(good, KNOWN);
  assert.deepEqual(h.warnings, []);
  assert.deepEqual(Object.keys(h.streams), ['Avonlea']);
  assert.equal(h.streams.Avonlea?.pins.length, 2);
});

test('every bad entry is dropped with its own warning and the good ones survive', () => {
  const bad = structuredClone(good) as typeof good & { streams: Record<string, Record<string, unknown>> };
  Object.assign(bad.streams.avonlea as object, {
    projects: ['avonlea-api', '../etc', 'a/b'], epics: ['ok-1', 7], docs: ['/etc/passwd.md', 'a/../b.md', 'Projects/p/.env.md', 'Projects/p/notes.txt', 'Projects/p/ok.md'],
    runbooks: 'not a list', done: { 'x-1': 'verified', 'x-2': 'yes' },
    pins: [{ label: 'js', url: 'javascript:alert(1)' }, { label: 'data', url: 'data:text/html,x' }, { label: 'creds', url: 'https://u:p@h.example/' }, { label: 'both', url: 'https://h.example/', note: 'a.md' },
      { label: '', url: 'https://h.example/' }, { label: 'note-up', note: '../x.md' }, 'junk', { label: 'fine', url: 'https://h.example/ok' }],
  });
  bad.streams.nowhere = {};
  const h = validateHomes(bad, KNOWN);
  const s = h.streams.Avonlea;
  assert.deepEqual(s?.projects, ['avonlea-api']);
  assert.deepEqual(s?.epics, ['ok-1']);
  assert.deepEqual(s?.docs, ['Projects/p/ok.md']);
  assert.deepEqual(s?.runbooks, []);
  assert.deepEqual(s?.done, { 'x-1': 'verified' });
  assert.deepEqual(s?.pins, [{ label: 'fine', url: 'https://h.example/ok' }]);
  assert.equal(h.warnings.length, 2 + 1 + 4 + 1 + 1 + 7 + 1, h.warnings.join('\n'));
  assert.ok(h.warnings.some((w) => /pins\[0\] has a url that is not http or https/.test(w)));
  assert.ok(h.warnings.some((w) => /stream "nowhere" is not a known stream/.test(w)));
  assert.ok(h.warnings.every((w) => w.startsWith(`${HOMES_FILE}: `)));
});

test('a wrong shape or version is ignored whole, never thrown', () => {
  for (const raw of [null, [], 'x', { version: 2, streams: {} }, { version: 1 }, { version: 1, streams: [] }]) {
    const h = validateHomes(raw, KNOWN);
    assert.deepEqual(h.streams, {});
    assert.equal(h.warnings.length, 1);
  }
});

test('url and note predicates', () => {
  assert.ok(isHttpUrl('http://a.example/x') && isHttpUrl('https://a.example'));
  for (const u of ['javascript:x', 'file:///etc/hosts', 'obsidian://open?vault=v', '//a.example', 'https://u@a.example', `https://a.example/${'x'.repeat(2100)}`, 5]) assert.ok(!isHttpUrl(u), String(u));
  assert.ok(isVaultNote('Projects/p/Plans/a.md'));
  for (const n of ['a.txt', '/a.md', 'a/../b.md', 'credentials.md', 'Projects/p/.env/x.md', '']) assert.ok(!isVaultNote(n), n);
});

test('readHomes: absent is not found, and a symlink, bad JSON or oversize file is a warning', () => {
  const dir = mkdtempSync(join(tmpdir(), 'homes-'));
  assert.deepEqual(readHomes(dir, KNOWN), { found: false, streams: {}, warnings: [] });
  writeFileSync(join(dir, HOMES_FILE), JSON.stringify(good));
  assert.equal(readHomes(dir, KNOWN).streams.Avonlea?.epics[0], 'avonlea-api-042');
  writeFileSync(join(dir, HOMES_FILE), '{nope');
  assert.match(readHomes(dir, KNOWN).warnings[0] ?? '', /not valid JSON/);
  writeFileSync(join(dir, HOMES_FILE), ' '.repeat(70 * 1024));
  assert.match(readHomes(dir, KNOWN).warnings[0] ?? '', /over 64 KB/);
  const other = mkdtempSync(join(tmpdir(), 'homes-'));
  writeFileSync(join(other, 'real.json'), JSON.stringify(good));
  mkdirSync(join(other, 'sub'));
  symlinkSync(join(other, 'real.json'), join(other, 'sub', HOMES_FILE));
  assert.match(readHomes(join(other, 'sub'), KNOWN).warnings[0] ?? '', /not a regular file/);
});

test('a project or ticket id that is a secret-file name is dropped, so it is never echoed back', () => {
  const h = validateHomes({ version: 1, streams: { Avonlea: { projects: ['credentials', 'ok-project'], epics: ['.env', 'ok-1'], exclude: ['id_rsa'] } } }, KNOWN);
  assert.deepEqual([h.streams.Avonlea?.projects, h.streams.Avonlea?.epics, h.streams.Avonlea?.exclude], [['ok-project'], ['ok-1'], []]);
});
