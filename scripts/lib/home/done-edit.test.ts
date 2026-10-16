// Run: node --test scripts/lib/home/done-edit.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bumpUpdated, doneRev, doneTextProblem, readDoneSection, replaceDoneSection } from './done-edit.ts';

const WITH_NEXT = '---\nid: "fake-1"\nupdated: 2026-10-01\n---\n\n# fake-1\n\n## What done looks like\n\n1. Old one\n2. Old two\n\n## Estimate\n\n3 story points\n';
const AT_END = '---\nid: "fake-1"\nupdated: "2026-10-01"\n---\n\n# fake-1\n\n## Estimate\n\n3 story points\n\n## What done looks like\nOld prose\n';

test('replaces only the section, up to the next ## heading, and keeps what follows byte for byte', () => {
  const out = replaceDoneSection(WITH_NEXT, '- [ ] New one\n- [x] New two');
  assert.equal(out, '---\nid: "fake-1"\nupdated: 2026-10-01\n---\n\n# fake-1\n\n## What done looks like\n\n- [ ] New one\n- [x] New two\n\n## Estimate\n\n3 story points\n');
});

test('replaces a section that is the last in the note (no following heading) and ends the file with one newline', () => {
  const out = replaceDoneSection(AT_END, 'New prose');
  assert.equal(out, '---\nid: "fake-1"\nupdated: "2026-10-01"\n---\n\n# fake-1\n\n## Estimate\n\n3 story points\n\n## What done looks like\n\nNew prose\n');
  assert.equal(readDoneSection(out), 'New prose');
});

test('adds the heading at the end when the note has none, and keeps the earlier content', () => {
  const note = '---\nid: "fake-2"\n---\n\n# fake-2\n\nBody.\n\n';
  const out = replaceDoneSection(note, '1. First');
  assert.equal(out, '---\nid: "fake-2"\n---\n\n# fake-2\n\nBody.\n\n## What done looks like\n\n1. First\n');
  assert.equal(readDoneSection(note), '');
});

test('an empty heading is filled in place; subheadings (###) stay inside the section', () => {
  const out = replaceDoneSection('# t\n\n## What done looks like\n\n## After\nx\n', 'Done is done.\n\n### Detail\nmore');
  assert.equal(out, '# t\n\n## What done looks like\n\nDone is done.\n\n### Detail\nmore\n\n## After\nx\n');
  assert.equal(readDoneSection(out), 'Done is done.\n\n### Detail\nmore');
});

test('CRLF notes stay CRLF', () => {
  const out = replaceDoneSection('# t\r\n\r\n## What done looks like\r\nOld\r\n\r\n## After\r\nx\r\n', 'New');
  assert.ok(!/[^\r]\n/.test(out), 'every newline is CRLF');
  assert.equal(readDoneSection(out), 'New');
});

test('bumpUpdated sets updated: (quoted or not) and last-updated:, and leaves a note with neither alone', () => {
  assert.match(bumpUpdated(WITH_NEXT, '2026-10-16'), /^updated: 2026-10-16$/m);
  assert.match(bumpUpdated(AT_END, '2026-10-16'), /^updated: "2026-10-16"$/m);
  assert.match(bumpUpdated('---\nlast-updated: 2026-09-01\n---\n# c\n', '2026-10-16'), /^last-updated: 2026-10-16$/m);
  const none = '---\ntitle: x\n---\nupdated: 2026-01-01 in the body is not frontmatter\n';
  assert.equal(bumpUpdated(none, '2026-10-16'), none);
  assert.equal(bumpUpdated('# no frontmatter\n', '2026-10-16'), '# no frontmatter\n');
});

test('the revision follows the section text only', () => {
  assert.equal(doneRev(WITH_NEXT), doneRev(WITH_NEXT.replace('3 story points', '5 story points')));
  assert.notEqual(doneRev(WITH_NEXT), doneRev(replaceDoneSection(WITH_NEXT, 'Different')));
});

test('text that is empty, too long, has control characters or would add a heading is refused', () => {
  assert.equal(doneTextProblem('- fine\n### sub\n# Appendix'), null);
  for (const bad of ['', '   \n', 'x'.repeat(8001), 'a\u0000b', 'ok\n## Sneaky heading']) assert.notEqual(doneTextProblem(bad), null, JSON.stringify(bad.slice(0, 20)));
});
