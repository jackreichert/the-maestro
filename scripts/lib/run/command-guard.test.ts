import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBlock, secretFileRefs } from './command-guard.ts';

const rules = (b: string, extra?: (c: string) => string | null): string[] => { const v = checkBlock(b, extra); return v.ok ? [] : v.refusals.map((r) => r.rule); };
const FAKE_TOKEN = `ghp_${'a1B2'.repeat(9)}`;

test('a plain read-only block passes', () => {
  assert.deepEqual(rules('/opt/homebrew/bin/node scripts/journal.ts status\nls -la'), []);
});

test('paste-lint findings refuse the block', () => {
  assert.ok(rules('ls # note').includes('inline-comment'));
  assert.ok(rules('node scripts/x.ts').includes('bare-node-ts'));
  assert.ok(rules('gh pr merge 12 --squash').includes('github-merge-approve'));
});

test('a block that names a secret file is refused, in every spelling the matcher knows', () => {
  for (const b of ['cat .env', 'source ./.env.local', 'cat ~/dev-env/.env', 'grep KEY .env*', 'cat ssm-params-production.json', 'cat "ssm-*.json"', 'cat .e"nv"', 'cat prod.env', 'cat ./app/.env.production']) {
    assert.ok(rules(b).includes('secret-file'), b);
  }
});

test('templates are not secret files', () => {
  assert.deepEqual(rules('cat .env.example\ncat .env.sample'), []);
  assert.deepEqual(secretFileRefs('ls /tmp/example.ssm-params.json'), []);
});

test('environment dumps are refused, a named variable is not', () => {
  for (const b of ['env', 'printenv', 'echo hi && env', 'export -p', 'set', 'cat /proc/self/environ', 'env | sort']) assert.ok(rules(b).includes('env-dump'), b);
  assert.deepEqual(rules('echo "$HOME"\nenv FOO=1 true'), []);
});

test('a secret-shaped line is refused, so what is shown is what runs', () => {
  assert.ok(rules(`curl -H "Authorization: ${FAKE_TOKEN}" https://example.com`).includes('secret-shaped'));
});

test('empty, oversized and NUL blocks are refused', () => {
  assert.deepEqual(rules('   '), ['empty']);
  assert.deepEqual(rules('a'.repeat(70 * 1024)), ['too-big']);
  assert.deepEqual(rules('ls\0'), ['nul-byte']);
});

test('the extra guard can only add refusals', () => {
  assert.deepEqual(rules('ls', () => null), []);
  assert.deepEqual(rules('ls', () => 'no'), ['secret-file-hook']);
  assert.ok(rules('cat .env', () => null).includes('secret-file'));
});
