// Run: node --test scripts/lib/home/docs.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createReader } from '../vault/reader.ts';
import { DOC_DIR_SCOPES, DOC_FILE_SCOPES, docHeader, loadDocs } from './docs.ts';

const fm = (lines: string[]): string => `---\n${lines.join('\n')}\n---\n# A note\n`;
function vaultWith(files: Record<string, string>): ReturnType<typeof createReader> {
  const root = mkdtempSync(join(tmpdir(), 'docs-'));
  for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); }
  return createReader({ root, dirScopes: DOC_DIR_SCOPES, fileScopes: DOC_FILE_SCOPES });
}

test('the header carries a stream field, and none when the note names no stream', () => {
  assert.equal(docHeader(fm(['stream: Avonlea']), 'a.md', 'Plans').stream, 'Avonlea');
  assert.equal(docHeader(fm(['stream: none']), 'a.md', 'Plans').stream, 'none');
  assert.equal('stream' in docHeader(fm(['ticket: t-1']), 'a.md', 'Plans'), false);
});

test('loadDocs reads one level of subfolder under a doc folder and no deeper', () => {
  const reader = vaultWith({
    'Projects/avonlea-api/Plans/top.md': fm(['stream: Avonlea']),
    'Projects/avonlea-api/Research/orchard/a.md': fm(['ticket: t-1']),
    'Projects/avonlea-api/Research/orchard/deep/b.md': fm(['ticket: t-2']),
    'Projects/avonlea-api/Notes/elsewhere.md': fm(['ticket: t-3']),
  });
  const { docs, notes } = loadDocs(reader, 'avonlea-api');
  assert.deepEqual(docs.map((d) => d.path).sort(), ['Projects/avonlea-api/Plans/top.md', 'Projects/avonlea-api/Research/orchard/a.md']);
  assert.equal(docs.find((d) => d.path.endsWith('top.md'))?.stream, 'Avonlea');
  assert.equal(docs.find((d) => d.path.endsWith('a.md'))?.folder, 'Research');
  assert.deepEqual(notes, []);
});

test('loadDocs reads library pages from Knowledge, and one subfolder under it, as folder Knowledge', () => {
  const reader = vaultWith({
    'Projects/avonlea-api/Knowledge/orchard-sync.md': fm(['type: library', 'stream: Avonlea']),
    'Projects/avonlea-api/Knowledge/flows/harvest.md': fm(['type: library', 'stream: Avonlea']),
    'Projects/avonlea-api/Knowledge/flows/deep/x.md': fm(['type: library']),
  });
  const { docs, notes } = loadDocs(reader, 'avonlea-api');
  assert.deepEqual(docs.map((d) => d.path).sort(), ['Projects/avonlea-api/Knowledge/flows/harvest.md', 'Projects/avonlea-api/Knowledge/orchard-sync.md']);
  assert.ok(docs.every((d) => d.folder === 'Knowledge' && d.stream === 'Avonlea'));
  assert.deepEqual(notes, []);
});
