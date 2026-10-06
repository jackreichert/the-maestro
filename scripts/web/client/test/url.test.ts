// Run: node --test scripts/web/client/test/url.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSafeUrl, safeHref } from '../src/url.ts';
import { renderInline } from '../src/markdown.ts';

const OK = [
  'https://ok.test/a?b=1', 'HTTPS://ok.test', 'http://localhost:8787/', ' https://ok.test ',
  'obsidian://open?vault=AryaObsidian&file=Projects%2Fdev-env%2FCONTEXT', 'ObSiDiAn://open?vault=v', 'obsidian://open/?file=a',
];

const BAD = [
  'javascript:alert(1)', 'JAVASCRIPT:alert(1)', '\tjavascript:alert(1)', '\x01javascript:alert(1)', 'java\tscript:alert(1)', 'java\nscript:alert(1)',
  '&#106;avascript:alert(1)', 'javascript&colon;alert(1)', '//evil.test/x', '/\\evil.test', 'data:text/html,<script>alert(1)</script>', 'vbscript:x', 'ftp://x.test',
  'https:', 'https://', '',
  'obsidian://new?vault=AryaObsidian&file=Projects/dev-env/CONTEXT&content=INJECT&overwrite=true',
  'obsidian://adv-uri?vault=v&commandid=editor:delete-paragraph', 'obsidian://daily?vault=v', 'obsidian://hook-get-address?vault=v',
  'obsidian://open', 'obsidian://open?vault=v&x=1', 'obsidian://open?vault=v&vault=w', 'obsidian://open?vault=v#frag', 'obsidian://open/extra?vault=v',
  'obsidian://user@open?vault=v', 'obsidian:open?vault=v', 'obsi\tdian://open?vault=v', 'obsidian://OPEN.evil?vault=v', 'obsidian://open?vault=v\nx',
];

test('isSafeUrl accepts http, https and obsidian://open with only vault and file', () => {
  for (const u of OK) assert.ok(isSafeUrl(u), u);
});

test('isSafeUrl rejects script schemes, disguised schemes and every other obsidian action', () => {
  for (const u of BAD) assert.ok(!isSafeUrl(u), JSON.stringify(u));
});

test('safeHref returns the trimmed URL or undefined', () => {
  assert.equal(safeHref(' https://ok.test '), 'https://ok.test');
  assert.equal(safeHref('obsidian://new?vault=v'), undefined);
  assert.equal(safeHref(undefined), undefined);
});

test('a rejected obsidian link renders as plain text, never an anchor', () => {
  const html = renderInline('[Fix typo](obsidian://new?vault=AryaObsidian&file=Projects/dev-env/CONTEXT&content=x&overwrite=true)');
  assert.ok(!html.includes('<a'), html);
  assert.match(html, /^Fix typo/);
});
