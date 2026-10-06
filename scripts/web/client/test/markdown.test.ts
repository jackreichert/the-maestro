// Run: node --test scripts/web/client/test/markdown.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, isSafeUrl, renderInline, renderMarkdown, splitRow } from '../src/markdown.ts';

test('escapeHtml escapes the five HTML-significant characters', () => {
  assert.equal(escapeHtml(`<a href="x">&'`), '&#60;a href=&#34;x&#34;&#62;&#38;&#39;');
});

test('a script tag in text never survives as a tag', () => {
  const html = renderMarkdown('hello <script>alert(1)</script> world');
  assert.ok(!html.includes('<script'));
  assert.match(html, /&#60;script&#62;alert\(1\)&#60;\/script&#62;/);
});

test('an attribute-breaking label or url cannot inject markup', () => {
  const html = renderInline('[x" onmouseover="alert(1)](https://example.test/a"b)');
  assert.ok(!/<[^>]*\sonmouseover=/.test(html), html);
  const img = renderInline('<img src=x onerror=alert(1)>');
  assert.ok(!img.includes('<img'));
});

test('javascript:, data: and vbscript: links render as plain label text', () => {
  for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'data:text/html,x', 'vbscript:x']) {
    const html = renderInline(`[click](${url})`);
    assert.ok(!html.includes('<a'), `${url} -> ${html}`);
    assert.ok(html.includes('click'));
  }
});

test('http, https and obsidian links render with a safe rel', () => {
  assert.equal(renderInline('[FAKE-1](https://tracker.test/browse/FAKE-1)'), '<a href="https://tracker.test/browse/FAKE-1" rel="noreferrer noopener">FAKE-1</a>');
  assert.match(renderInline('[note](obsidian://open?vault=v&file=a)'), /href="obsidian:\/\/open\?vault=v&#38;file=a"/);
  assert.ok(isSafeUrl('http://localhost:1/'));
  assert.ok(!isSafeUrl('ftp://x'));
});

test('the nowrap span the generator writes becomes a class, and other span attributes are escaped', () => {
  assert.equal(renderInline('<span style="white-space:nowrap">[FAKE-1](https://t.test/FAKE-1)</span>'), '<span class="nw"><a href="https://t.test/FAKE-1" rel="noreferrer noopener">FAKE-1</a></span>');
  const evil = renderInline('<span style="background:url(x)">hi</span>');
  assert.ok(!evil.includes('<span'));
});

test('inline code and bold', () => {
  assert.equal(renderInline('use `a<b` and **bold <i>**'), 'use <code>a&#60;b</code> and <strong>bold &#60;i&#62;</strong>');
});

test('headings and paragraphs', () => {
  assert.equal(renderMarkdown('## Today\n\nline one\nline two'), '<h2>Today</h2>\n<p>line one line two</p>');
});

test('bullet, numbered and checkbox lists, with an answer quote under an item', () => {
  assert.equal(renderMarkdown('- one\n- two'), '<ul><li>one</li><li>two</li></ul>');
  assert.equal(renderMarkdown('1. a\n2. b'), '<ol><li>a</li><li>b</li></ol>');
  const html = renderMarkdown('- [ ] `ab12` **Merge acme-widgets #12?**\n  > answer: ');
  assert.match(html, /<li><span class="box" role="img" aria-label="open">☐<\/span> <code>ab12<\/code> <strong>Merge acme-widgets #12\?<\/strong><blockquote>answer:<\/blockquote><\/li>/);
  assert.match(renderMarkdown('- [x] done thing'), /aria-label="done">☑/);
});

test('tables render a header, a body and escape cell content', () => {
  const html = renderMarkdown('| id | text |\n| --- | --- |\n| `a1` | <b>x</b> \\| y |\n| `a2` | z |');
  assert.match(html, /<th scope="col">id<\/th><th scope="col">text<\/th>/);
  assert.match(html, /<td><code>a1<\/code><\/td><td>&#60;b&#62;x&#60;\/b&#62; \| y<\/td>/);
  assert.equal((html.match(/<tr>/g) ?? []).length, 3);
});

test('splitRow keeps a pipe inside a code span', () => {
  assert.deepEqual(splitRow('| a | `b|c` | d |'), ['a', '`b|c`', 'd']);
});

test('fenced code is escaped and not parsed', () => {
  assert.equal(renderMarkdown('```\n**<x>**\n```'), '<pre><code>**&#60;x&#62;**</code></pre>');
});

test('block quote lines join; an unterminated fence does not hang', () => {
  assert.equal(renderMarkdown('> a\n> b'), '<blockquote>a<br>b</blockquote>');
  assert.equal(renderMarkdown('```\nopen'), '<pre><code>open</code></pre>');
});

test('a lone pipe line that is not a table terminates as a paragraph', () => {
  assert.equal(renderMarkdown('| not a table'), '<p>| not a table</p>');
});

test('empty input renders nothing', () => {
  assert.equal(renderMarkdown(''), '');
});

test('a backslash before ASCII punctuation makes it literal and stops it starting a match', () => {
  assert.equal(renderInline('\\[a\\](https://ok.test)'), '[a](https://ok.test)');
  assert.equal(renderInline('\\*\\*x\\*\\*'), '**x**');
  assert.equal(renderInline('\\`x\\`'), '`x`');
  assert.equal(renderInline('a\\<b\\>'), 'a&#60;b&#62;');
  assert.equal(renderInline('\\\\[a](https://ok.test)'), '\\<a href="https://ok.test" rel="noreferrer noopener">a</a>');
  assert.equal(renderInline('a\\b'), 'a\\b', 'a backslash before a letter stays');
});

test('an escaped bracket inside a label does not end it, and an escaped star does not close bold', () => {
  assert.equal(renderInline('[a\\]b](https://ok.test)'), '<a href="https://ok.test" rel="noreferrer noopener">a]b</a>');
  assert.equal(renderInline('**x\\***'), '<strong>x*</strong>');
});

test('the generator escape for a link in a table cell renders as text, not a link', () => {
  const cell = '\\[Fix typo\\](obsidian://open?vault=v&file=f)';
  assert.ok(!renderMarkdown(`| a |\n| --- |\n| ${cell} |`).includes('<a'));
});

test('an escaped pipe stays in its cell, and an escaped backslash before a pipe still separates cells', () => {
  assert.deepEqual(splitRow('| a\\|b | c |'), ['a|b', 'c']);
  assert.deepEqual(splitRow('| a\\\\| c |'), ['a\\\\', 'c']);
});
