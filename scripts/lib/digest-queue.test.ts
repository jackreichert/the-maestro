// Run: MAESTRO_STATUS_DIR="$(mktemp -d)" node --test scripts/lib/digest-queue.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digestQueueOwners, keyFromFixText, NO_OWNER_LOG, queueActionableDigest, queuedFixKeys } from './digest-queue.ts';

const url = (n: number) => `https://github.com/acme/widget/pull/${n}`;
const reviewUrl = (n: number, id: number) => `${url(n)}#pullrequestreview-${id}`;

const line = (summary: string, type = 'pr-watch') => `ACTION prs (${type}): ${summary}`;

const digest = [
  line(`CONFLICT acme/widget#4 main <- feature ${url(4)}`),
  line(`REVIEW acme/widget#4 by pat (CHANGES_REQUESTED): ${reviewUrl(4, 9)}`),
  line(`REVIEW acme/widget#4 by pat (COMMENTED): ${reviewUrl(4, 8)}`),
  line(`REVIEW acme/widget#5 by pat (APPROVED): ${url(5)}#pullrequestreview-1`),
  line('THREAD acme/widget#4 by copilot-pull-request-reviewer[bot]: https://github.com/acme/widget/pull/4#discussion_r1'),
  line('REPLY acme/widget#4 by pat: https://github.com/acme/widget/pull/4#discussion_r2'),
  line('COMMENT acme/widget#4 by pat: thanks'),
  line('COMMENT acme/widget#6 by pat: LGTM'),
  line(`DECISION acme/widget#4: REVIEW_REQUIRED -> CHANGES_REQUESTED ${url(4)}`),
  line(`CONFLICT other/widget#4 main <- feature https://github.com/other/widget/pull/4`),
  line(`[self-review] CONFLICT acme/tool#2 main <- feature https://github.com/acme/tool/pull/2`),
  line(`CHECKS-FAILING acme/widget#7 ci ${url(7)}`),
  line('CONFLICT acme/widget#4 main <- feature https://github.com/acme/widget/pull/4', 'notes-check'),
  `info prs (pr-watch): APPROVED-UNMERGED acme/widget#4 ${url(4)}`,
].join('\n');

function run(text: string, extra: Partial<Parameters<typeof queueActionableDigest>[1]> = {}) {
  const calls: string[] = [];
  const queued = queueActionableDigest(text, {
    owners: ['acme'],
    queue: (item) => { calls.push(item.key); },
    ...extra,
  });
  return { calls, queued };
}

test('queues conflict, changes-requested, and an existing checks-failing line; skips noise', () => {
  const { calls, queued } = run(digest);
  assert.deepEqual(calls, [
    `acme/widget#4|CONFLICT|${url(4)}`,
    `acme/widget#4|CHANGES_REQUESTED|${reviewUrl(4, 9)}`,
    `acme/widget#7|CHECKS-FAILING|${url(7)}`,
  ]);
  assert.equal(queued[0].text, `fix acme/widget#4 CONFLICT ${url(4)}`);
  assert.equal(keyFromFixText(queued[1].text), calls[1]);
});

test('a second pass does not queue a key already queued', () => {
  const seen = new Set<string>();
  const calls: string[] = [];
  const opts = {
    owners: ['acme'],
    alreadyQueued: seen,
    queue: (item: { key: string }) => { calls.push(item.key); seen.add(item.key); },
  };
  queueActionableDigest(digest, opts);
  queueActionableDigest(digest, opts);
  assert.equal(calls.length, 3);
  assert.equal(queueActionableDigest(digest, { ...opts, alreadyQueued: seen }).length, 0);
});

test('duplicate lines in one digest queue once', () => {
  const text = [line(`CONFLICT acme/widget#4 main <- feature ${url(4)}`), line(`CONFLICT acme/widget#4 develop <- feature ${url(4)}`)].join('\n');
  assert.equal(run(text).calls.length, 1);
});

test('owner match is case-insensitive; a repo outside the allowlist is skipped', () => {
  const text = line(`CONFLICT Acme/widget#4 main <- feature ${url(4)}`);
  assert.equal(run(text, { owners: ['ACME'] }).calls.length, 1);
  assert.equal(run(text, { owners: ['other'] }).calls.length, 0);
});

test('an empty allowlist queues nothing and logs, without reading config', () => {
  const logs: string[] = [];
  const queued = queueActionableDigest(digest, { owners: [], queue: () => { throw new Error('should not queue'); }, log: (l) => logs.push(l) });
  assert.deepEqual(queued, []);
  assert.deepEqual(logs, [NO_OWNER_LOG]);
});

test('self-review lines and exclude globs are not queued', () => {
  const bare = line(`CONFLICT acme/tool#3 main <- feature https://github.com/acme/tool/pull/3`);
  assert.equal(run(bare, { excludeRepos: ['acme/tool'] }).calls.length, 0);
  assert.equal(run(bare, { excludeRepos: ['acme/*'] }).calls.length, 0);
  assert.equal(run(line('[self-review] CONFLICT acme/widget#2 main <- feature https://github.com/acme/widget/pull/2')).calls.length, 0);
});

test('a report suffix is not the event url', () => {
  const text = line(`CONFLICT acme/widget#4 main <- feature ${url(4)} | report: see https://example.test/other`);
  assert.equal(run(text).queued[0].url, url(4));
});

test('digestQueueOwners prefers copilot orgs, else gh_org, else nothing', () => {
  assert.deepEqual(digestQueueOwners(['acme', ' '], 'other'), ['acme']);
  assert.deepEqual(digestQueueOwners([], 'gh-org'), ['gh-org']);
  assert.deepEqual(digestQueueOwners([], ''), []);
  assert.deepEqual(digestQueueOwners([''], '  '), []);
});

test('queuedFixKeys keeps open items and drops a closed one', () => {
  const open = JSON.stringify({ id: 'ab12', kind: 'wip', queued: true, text: `fix acme/widget#4 CONFLICT ${url(4)}` });
  const closer = JSON.stringify({ id: 'cd34', kind: 'done', closes: 'ab12', text: 'done' });
  const inflight = JSON.stringify({ id: 'ef56', kind: 'wip', text: `fix acme/widget#7 CHECKS-FAILING ${url(7)}` });
  assert.equal(queuedFixKeys(`${open}\n`).has(`acme/widget#4|CONFLICT|${url(4)}`), true);
  assert.equal(queuedFixKeys(`${open}\n${closer}\n`).has(`acme/widget#4|CONFLICT|${url(4)}`), false);
  assert.equal(queuedFixKeys(`${inflight}\n`).has(`acme/widget#7|CHECKS-FAILING|${url(7)}`), true);
  assert.equal(queuedFixKeys('not json\n').size, 0);
});
