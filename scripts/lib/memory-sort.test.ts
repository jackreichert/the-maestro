// Run: node --test scripts/lib/memory-sort.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readHeader, sortAll, sortMemory } from './memory-sort.ts';
import type { RepoHint } from './memory-sort.ts';

const HINTS: RepoHint[] = [[/widget|gadget/i, 'widget-api']];

const file = (name: string, type: string, description: string) => ({ name, text: `---\nname: ${name}\ndescription: "${description}"\nmetadata:\n  node_type: memory\n  type: ${type}\n---\nBody.\n` });

test('readHeader reads type and description from the frontmatter', () => {
    const h = readHeader(file('a', 'project', 'About x').text);
    assert.deepEqual([h.type, h.description, h.body.trim()], ['project', 'About x', 'Body.']);
});

test('a feedback file is a behaviour rule even when it names a project', () => {
    const s = sortMemory(file('review-tone', 'feedback', 'Be kind in the widget reviews'), HINTS);
    assert.deepEqual([s.kind, s.repo, s.page], ['behaviour-rule', null, null]);
});

test('a project file naming a repo is a fact with a Knowledge page', () => {
    const s = sortMemory(file('branch-layout', 'project', 'The widget has no staging branch'), HINTS);
    assert.deepEqual([s.kind, s.repo, s.page], ['project-fact', 'widget-api', 'Projects/widget-api/Knowledge/branch-layout.md']);
});

test('a project file worded as a rule is left to the user', () => {
    assert.equal(sortMemory(file('x', 'project', 'Jack decided not to install it for the-maestro')).kind, 'unsure');
});

test('a project file with no project is unsure, or a rule when worded as one', () => {
    assert.equal(sortMemory(file('y', 'reference', 'A thing about widgets')).kind, 'unsure');
    assert.equal(sortMemory(file('z', 'project', 'Never do widgets')).kind, 'behaviour-rule');
});

test('a file with no type is unsure and the index is skipped', () => {
    assert.equal(sortMemory({ name: 'q', text: 'no frontmatter' }).kind, 'unsure');
    assert.deepEqual(sortAll([{ name: 'MEMORY', text: '' }, file('b', 'feedback', 'x'), file('a', 'feedback', 'x')]).map((s) => s.name), ['a', 'b']);
});
