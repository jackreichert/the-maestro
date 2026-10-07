// Run: node --test scripts/web/client/test/link-policy.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkAttrs } from '../src/link-policy.ts';

const PR = 'https://github.com/example-org/example-repo/pull/42';
const TICKET = 'https://example.atlassian.net/browse/EX-123';

test('a pull request gets a per-item tab name and no rel, so repeat clicks reuse its tab', () => {
  assert.deepEqual(linkAttrs(PR), { href: PR, target: 'podium-pr-example-org-example-repo-42' });
  assert.deepEqual(linkAttrs(`${PR}/`), { href: `${PR}/`, target: 'podium-pr-example-org-example-repo-42' });
  assert.equal(linkAttrs(PR)?.target, linkAttrs(` ${PR} `)?.target);
});

test('a ticket gets a per-item tab name', () => {
  assert.deepEqual(linkAttrs(TICKET), { href: TICKET, target: 'podium-ticket-EX-123' });
});

test('different items get different names, and the same number in two repos does not collide', () => {
  const names = [PR, 'https://github.com/example-org/example-repo/pull/43', 'https://github.com/example-org/other-repo/pull/42', TICKET, 'https://example.atlassian.net/browse/EX-124']
    .map((u) => linkAttrs(u)?.target);
  assert.equal(new Set(names).size, names.length);
});

test('tab names never start with an underscore and only use safe characters', () => {
  for (const u of [PR, TICKET]) assert.match(linkAttrs(u)?.target ?? '', /^podium-[A-Za-z0-9_.-]+$/);
});

test('a non-allowlisted host opens a new tab with noopener noreferrer, never a reusable name', () => {
  for (const u of ['https://ok.test/a', 'http://localhost:8787/', 'https://evil.test/example-org/example-repo/pull/42', 'https://evil.test/browse/EX-123']) {
    assert.deepEqual(linkAttrs(u), { href: u, target: '_blank', rel: 'noopener noreferrer' });
  }
});

test('lookalike hosts are not trusted', () => {
  for (const u of [
    'https://github.com.evil.test/example-org/example-repo/pull/42', 'https://evilgithub.com/example-org/example-repo/pull/42',
    'https://evil.test/?u=github.com', 'https://atlassian.net/browse/EX-123', 'https://example.atlassian.net.evil.test/browse/EX-123',
    'https://notatlassian.net/browse/EX-123',
  ]) {
    const a = linkAttrs(u);
    assert.equal(a?.target, '_blank', u);
    assert.equal(a?.rel, 'noopener noreferrer', u);
  }
});

test('a trusted host over http, or on a path no rule names, falls back to a safe new tab', () => {
  for (const u of ['http://github.com/example-org/example-repo/pull/42', 'https://github.com/example-org/example-repo/issues/42', 'https://github.com/example-org/example-repo/pull/42/files', TICKET.replace('/browse/EX-123', '/jira/software')]) {
    assert.deepEqual(linkAttrs(u), { href: u, target: '_blank', rel: 'noopener noreferrer' }, u);
  }
});

test('obsidian links carry no target', () => {
  const u = 'obsidian://open?vault=ExampleVault&file=Projects%2Fdev-env%2FCONTEXT';
  const a = linkAttrs(u);
  assert.equal(a?.href, u);
  assert.equal(a && 'target' in a, false);
});

test('unsafe or missing urls never become links', () => {
  for (const u of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,x', 'vbscript:x', 'ftp://x.test', '//evil.test/x', '', 'obsidian://new?vault=v&content=x', undefined]) {
    assert.equal(linkAttrs(u), undefined, String(u));
  }
});

test('every attribute set with a name omits rel, and every one without a name has noopener', () => {
  for (const u of [PR, TICKET, 'https://ok.test/', 'https://github.com/x/y/issues/1']) {
    const a = linkAttrs(u);
    assert.ok(a);
    if (a.target?.startsWith('podium-')) assert.equal('rel' in a, false);
    else assert.match(a.rel ?? '', /noopener/);
  }
});
