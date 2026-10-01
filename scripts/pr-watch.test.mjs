// Run: node --test scripts/pr-watch.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installGhStub, paged, prNode } from './lib/gh-stub.mjs';

const SCRIPT = new URL('./pr-watch.mjs', import.meta.url).pathname;
const tempState = (content) => {
  const path = join(mkdtempSync(join(tmpdir(), 'pr-watch-test-')), 'state.json');
  if (content) writeFileSync(path, JSON.stringify(content));
  return path;
};

function runOnce(env, state, ...extra) {
  const r = spawnSync(process.execPath, [SCRIPT, '--once', '--state', state, ...extra], { encoding: 'utf8', env, timeout: 20000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// A legacy-format state file: the bare board, which is what the 53 PRs below were baselined as.
const boardOf = (nodes) =>
  Object.fromEntries(nodes.map((n) => [`org/repo#${n.number}`, {
    url: n.url, repo: 'org/repo', number: n.number, isDraft: false, head: n.headRefOid, needsCopilot: false,
    decision: n.reviewDecision || 'NONE', threads: [], replies: [], comments: [], reviews: [],
  }]));

test('PRs past the first search page are not reported as having left the open set', () => {
  const nodes = Array.from({ length: 53 }, (_, i) => prNode(i + 1));
  const env = installGhStub({ pages: paged(nodes), prState: 'MERGED' });
  const r = runOnce(env, tempState(boardOf(nodes)));
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.out, /LEFT-OPEN-SET/);
  assert.match(r.out, /no changes/);
});
