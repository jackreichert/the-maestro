// Run: node --test scripts/lib/status-page/ask-format.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askBlocks, askMarkdown, sentences } from './ask-format.ts';

const DENSE = 'Options: (1) ask Team Select via Anand; (2) you already know it and tell me; (3) skip the check. Recommend (1). Stakes: a different hostname may also mean a host-guard change, which would need a PR. Checklist: see the note. Ticket fake-114.';

test('a dense context becomes a lead, a numbered list, and short paragraphs with their labels set apart', () => {
  assert.deepEqual(askBlocks(DENSE), [
    { kind: 'p', text: 'Options:' },
    { kind: 'list', marks: ['1', '2', '3'], items: ['ask Team Select via Anand', 'you already know it and tell me', 'skip the check.'] },
    { kind: 'p', text: 'Recommend (1).' },
    { kind: 'p', label: 'Stakes', text: 'a different hostname may also mean a host-guard change, which would need a PR.' },
    { kind: 'p', label: 'Checklist', text: 'see the note. Ticket fake-114.' },
  ]);
  assert.equal(askMarkdown(DENSE), [
    'Options:', '1. ask Team Select via Anand\n2. you already know it and tell me\n3. skip the check.', 'Recommend (1).',
    '**Stakes:** a different hostname may also mean a host-guard change, which would need a PR.', '**Checklist:** see the note. Ticket fake-114.',
  ].join('\n\n'));
});

test('lettered options become a list that keeps their letters, and a stray earlier (a) does not start it', () => {
  const md = askMarkdown('Recommend (a). Options: (a) ship it now; (b) wait a day; or (c) drop it. Nothing else is needed here, so this stays short.');
  assert.ok(md.includes('- **(a)** ship it now\n- **(b)** wait a day\n- **(c)** drop it.'), md);
  assert.ok(md.startsWith('Recommend (a). Options:'), md);
});

test('a short context with no list, and any context the writer broke into lines, come back untouched', () => {
  assert.deepEqual(askBlocks('See FAKE-12 for context.'), [{ kind: 'p', text: 'See FAKE-12 for context.' }]);
  const written = '1. cut now (a) yes? (b) no\n2. wait\n\nSource: https://example.test/p';
  assert.equal(askMarkdown(written), written);
  assert.equal(askMarkdown(''), '');
});

test('a short context that carries (1) (2) markers still becomes a list', () => {
  assert.equal(askMarkdown('(1) a? (2) b'), '1. a?\n2. b');
});

test('sentences do not split after an abbreviation, inside a host name or on a version', () => {
  assert.deepEqual(sentences('Use a tool, e.g. the fake one. Visit example.test now. See v2.1 notes.'), ['Use a tool, e.g. the fake one.', 'Visit example.test now.', 'See v2.1 notes.']);
});

test('nothing is lost: every word of the input is in the output', () => {
  const words = (s: string): string[] => s.replace(/[*]|\n|\d\.\s|- \*\*\(\w\)\*\*|\(\d\)|\(\w\)/g, ' ').split(/\s+/).filter(Boolean);
  const out = words(askMarkdown(DENSE).replace(/Label:/g, ''));
  for (const w of words(DENSE.replace(/[;]/g, ''))) assert.ok(out.includes(w.replace(/;$/, '')) || out.some((o) => o.includes(w)), w);
});
