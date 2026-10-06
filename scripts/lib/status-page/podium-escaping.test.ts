// Run: node --test scripts/lib/status-page/podium-escaping.test.ts
// Ledger and GitHub text is untrusted: the generator is the only source of live obsidian links.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPage } from './render.ts';
import type { Item, PageConfig, PageInput, Pr } from './render.ts';

const NOW = new Date('2026-10-05T15:00:00Z');
const FILES = new Set(['Plans/fake-design.md', 'Projects/fake-app/.env.md', 'Projects/fake-app/ssm-fake.json']);
const HOSTILE = [
  '[HOSTILE](obsidian://new?vault=FakeVault&file=Projects/fake-app/CONTEXT&content=x&overwrite=true)',
  '[HOSTILE](OBSIDIAN://open?vault=v&file=f)',
  '[HOSTILE](<obsidian://open?vault=v>)',
  '\\[HOSTILE\\](obsidian://open?vault=v)',
  '<obsidian://open?vault=v>',
  'bare obsidian://new?vault=v&file=f here',
];
const item = (over: Partial<Item>): Item => ({ id: 'ab12', date: '2026-10-05', ts: '2026-10-05T13:00:00Z', text: '', stream: 'Rivendell', ...over });
const config: PageConfig = {
  streams: ['Rivendell'], repoStreams: {}, vaultName: 'Fake Vault', trackerUrlBase: '', ticketNotePath: 'Projects/{prefix}/Tickets/{id}',
  trackerKeyPattern: '\\b[A-Z][A-Z0-9]+-\\d+\\b', tz: 'UTC', project: 'fake-app', noteExists: (p) => FILES.has(p),
};
const pr = (title: string): Pr => ({
  number: 1, title, url: 'https://example.test/fake/pull/1', isDraft: false, baseRefName: 'develop', headRefName: 'feat/FAKE-1-x', mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN', reviewDecision: null, repo: 'fake', short: 'fake', owner: 'fake', unresolved: 0, ci: 'SUCCESS', stream: 'Rivendell',
});
const page = (text: string, gate = text): string => renderPage({
  now: NOW, status: { inflight: [item({ id: 'wk01', text })], queued: [item({ id: 'qu01', text })], blocked: [item({ id: 'bl01', text, gate: text })],
    awaiting: [item({ text: `${text}? ${text}` })], done: [item({ id: 'dn01', text })] },
  triage: { items: [{ ...item({ id: 'bl01', text }), gate }] }, prs: [pr(text)], prData: { fetchedAt: NOW }, ticketMap: {}, priorities: { state: 'ok', date: '2026-10-05', items: [{ text: 'Ship it' }] }, config, command: 'fake',
}).page;
/** Every markdown link target on the page that points at obsidian. */
const obsidianTargets = (p: string): string[] => [...p.matchAll(/\]\((obsidian:[^)]*)\)/gi)].map((m) => m[1] as string);

test('hostile obsidian links in any text field leave no live link and no obsidian: text', () => {
  for (const text of HOSTILE) {
    const p = page(text);
    assert.deepEqual(obsidianTargets(p), [], text);
    assert.ok(!/obsidian:/i.test(p.replace(/\]\(obsidian:\/\/open\?vault=Fake%20Vault&file=[^)]*\)/g, '')), `text survived: ${text}`);
  }
});

test('brackets in ask text are escaped inside the bold and in the context', () => {
  const p = page('see [x] and <b> and a\\');
  const ask = p.split('\n').find((l) => l.startsWith('- [ ]')) as string;
  assert.ok(ask.includes('**see \\[x\\] and \\<b\\> and a\\\\?**'), ask);
  assert.ok(ask.includes('see \\[x\\] and \\<b\\> and a\\\\'), ask);
});

test('the generator still links an existing note path, and never a secret-named one', () => {
  const p = page('open Plans/fake-design.md and Projects/fake-app/.env.md and Projects/fake-app/ssm-fake.json');
  assert.ok(p.includes('[Plans/fake-design.md](obsidian://open?vault=Fake%20Vault&file=Plans%2Ffake-design)'), 'legitimate link lost');
  assert.ok(!p.includes('.env)') && !p.includes('ssm-fake)') && !p.includes('.env%'), 'secret path linked');
  assert.ok(obsidianTargets(p).every((t) => t.includes('fake-design')), obsidianTargets(p).join(' '));
});

test('non-hostile text without brackets or schemes renders unchanged', () => {
  const p = page('plain words, snake_case ok');
  assert.ok(p.includes('plain words, snake\\_case ok'));
});
