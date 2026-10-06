// Run: node --test scripts/web/client/test/generator-markdown.test.ts
// The cross-component check: the generator's real escaping (cell() and boldSafe() in render.ts, reached through
// renderPage) feeding the client's renderer. Neither side's tests can see a mismatch between the two.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPage } from '../../../lib/status-page/render.ts';
import type { PageInput, Pr } from '../../../lib/status-page/render.ts';
import { renderMarkdown } from '../src/markdown.ts';

const NOW = new Date('2026-10-05T15:00:00Z');
const TODAY = '2026-10-05';
/** A link the allowlist would accept, so only escaping can stop it, and one it would refuse. */
const HOSTILE_TITLES = [
  '[HOSTILE](obsidian://open?vault=v&file=f)',
  '[HOSTILE](obsidian://new?vault=ExampleVault&file=Projects/dev-env/CONTEXT&content=x&overwrite=true)',
  '[HOSTILE](https://evil.test/x)',
  '[HOSTILE](javascript:alert(1))',
  '**[HOSTILE](obsidian://open?vault=v)**',
  '`x` [HOSTILE](obsidian://open?vault=v) _y_',
  'a\\[HOSTILE\\](obsidian://open?vault=v)',
  '\\\\[HOSTILE](obsidian://open?vault=v)',
  '<span style="white-space:nowrap">[HOSTILE](obsidian://open?vault=v)</span>',
];

const pr = (title: string): Pr => ({
  number: 1, title, url: 'https://example.test/acme-widgets/pull/1', isDraft: false, baseRefName: 'develop', headRefName: 'feat/FAKE-1-x',
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null, repo: 'acme-widgets', short: 'acme-widgets', owner: 'acme', unresolved: 0, ci: 'SUCCESS', stream: 'Alpha',
});

function pageFor(title: string): string {
  const item = { id: 'ab12', date: TODAY, ts: `${TODAY}T13:00:00Z`, stream: 'Alpha' };
  const input: PageInput = {
    now: NOW,
    status: { inflight: [{ ...item, id: 'wk01', text: title }], queued: [], blocked: [{ ...item, id: 'bl01', text: title, gate: title }], awaiting: [{ ...item, text: `${title}? plain context` }], done: [] },
    triage: { items: [] }, prs: [pr(title)], prData: { fetchedAt: NOW }, ticketMap: {}, priorities: { state: 'ok', date: TODAY, items: [{ text: 'Ship it' }] },
    config: { streams: ['Alpha'], repoStreams: {}, vaultName: 'Vault', trackerUrlBase: 'https://tracker.test/browse/', ticketNotePath: 'Projects/{prefix}/Tickets/{id}', trackerKeyPattern: '\\b[A-Z][A-Z0-9]+-\\d+\\b', tz: 'America/New_York' },
    command: 'journal.ts status-page',
  };
  return renderPage(input).page;
}

/** Only the table rows: those are the cells the generator escapes with cell(). */
const tableRows = (page: string): string => page.split('\n').filter((l) => l.startsWith('|')).join('\n');

test('a hostile title in a table cell never becomes a link once the real cell() output is rendered', () => {
  for (const title of HOSTILE_TITLES) {
    const html = renderMarkdown(tableRows(pageFor(title)));
    assert.ok(html.includes('HOSTILE'), `the hostile text should still be shown as text: ${title}`);
    assert.ok(!html.includes('>HOSTILE</a>'), `${title}\n${html}`);
    assert.ok(!/href="[^"]*(?:evil\.test|javascript|obsidian:)/.test(html), title);
  }
});

test('boldSafe output: emphasis, code and a trailing backslash in an ask cannot break out of the bold or open code', () => {
  const html = renderMarkdown(pageFor('*em* _it_ `code` ends with a backslash \\').split('\n').filter((l) => l.startsWith('- [ ]')).join('\n'));
  assert.equal((html.match(/<strong>/g) ?? []).length, 1, html);
  assert.equal((html.match(/<code>/g) ?? []).length, 1, 'only the ask id is code');
  assert.match(html, /<strong>\*em\* _it_ `code` ends with a backslash \\\?<\/strong>/);
});

test('the page still renders its own links, so the checks above are not passing for want of any link', () => {
  const html = renderMarkdown(pageFor('plain title'));
  assert.match(html, /<a href="https:\/\/example\.test\/acme-widgets\/pull\/1"/);
});
