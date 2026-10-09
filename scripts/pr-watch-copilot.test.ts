// Run: node --test scripts/pr-watch-copilot.test.ts
// pr-watch's per-head-sha Copilot follow-up, end to end against the stubbed gh (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as prWatch from './event-types/pr-watch.ts';
import { ESCALATE_MS, GRACE_MS } from './lib/copilot-follow.ts';
import { installGhStub, prNode } from './lib/gh-stub.ts';
import type { GhStubConfig } from './lib/gh-stub.ts';
import type { Run } from './lib/types.ts';

const T0 = Date.parse('2026-10-09T12:00:00Z');
const BOT = 'copilot-pull-request-reviewer';
const ORGS = ['org'];

/** A stubbed gh plus a tick helper: `at` is ms after T0, `nodes` what the search returns, `config` the copilot_orgs. */
function rig(orgs: string[] = ORGS) {
  const editLog = join(mkdtempSync(join(tmpdir(), 'pr-watch-copilot-')), 'edits.log');
  writeFileSync(editLog, '');
  const config: GhStubConfig = { pages: [[]], editLog };
  const env = installGhStub(config);
  const run: Run = (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8', env });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  let prev: prWatch.PrWatchState | undefined;
  return {
    state: (): prWatch.PrWatchState | undefined => prev,
    edits: (): string[] => readFileSync(editLog, 'utf8').trim().split('\n').filter(Boolean),
    tick(at: number, nodes: unknown[]): string[] {
      writeFileSync(env.GH_STUB_CONFIG ?? '', JSON.stringify({ ...config, pages: [nodes] }));
      const next = prWatch.check('open-prs', { run, now: T0 + at, prev, config: { ghLogin: 'me', copilotOrgs: orgs } });
      const lines = prWatch.diff(prev ?? null, next).map((e) => e.summary).filter((s) => s.startsWith('COPILOT-'));
      prev = next;
      return lines;
    },
  };
}

const onHead = (head: string, extra: Record<string, unknown> = {}) => prNode(5, { headRefOid: head, ...extra });
const reviewedAt = (head: string) => ({ latestReviews: { nodes: [{ author: { login: BOT }, commit: { oid: head } }] } });
const botThread = (id: string) => ({ id, isResolved: false, comments: { nodes: [{ author: { login: BOT }, url: `https://x/${id}` }] }, last: { nodes: [{ id: `c-${id}`, author: { login: BOT }, url: `https://x/${id}` }] } });
const ASK = 'pr edit 5 --repo org/repo --add-reviewer @copilot';

test('the first check adopts the heads already there: nothing is requested for old PRs', () => {
  const r = rig();
  assert.deepEqual(r.tick(0, [onHead('sha-a')]), []);
  assert.deepEqual(r.tick(GRACE_MS * 5, [onHead('sha-a')]), []);
  assert.deepEqual(r.edits(), []);
});

test('a push with no Copilot re-trigger is requested once, after the grace, and never again for that sha', () => {
  const r = rig();
  r.tick(0, [onHead('sha-a')]);
  r.tick(600_000, [onHead('sha-b')]);
  assert.deepEqual(r.edits(), [], 'the tick that first sees the head waits out the grace');
  r.tick(600_000 + GRACE_MS, [onHead('sha-b')]);
  assert.deepEqual(r.edits(), [ASK]);
  r.tick(600_000 + GRACE_MS + 300_000, [onHead('sha-b', { reviewRequests: { nodes: [{ requestedReviewer: { login: BOT } }] } })]);
  r.tick(600_000 + GRACE_MS + 600_000, [onHead('sha-b')]);
  assert.deepEqual(r.edits(), [ASK], 'once per head sha');
});

test('when Copilot re-triggers itself there is no request, and the review is reported with its bot threads', () => {
  const r = rig();
  r.tick(0, [onHead('sha-a')]);
  r.tick(600_000, [onHead('sha-b', { reviewRequests: { nodes: [{ requestedReviewer: { login: BOT } }] } })]);
  const lines = r.tick(900_000, [onHead('sha-b', { ...reviewedAt('sha-b'), reviewThreads: { nodes: [botThread('t1'), botThread('t2')] } })]);
  assert.deepEqual(r.edits(), []);
  assert.deepEqual(lines, ['COPILOT-REVIEW org/repo#5 sha-b: reviewed, 2 unresolved bot threads']);
  assert.deepEqual(r.tick(1_200_000, [onHead('sha-b', reviewedAt('sha-b'))]), [], 'told once');
});

test('a Copilot review of an older sha does not count for the new head', () => {
  const r = rig();
  r.tick(0, [onHead('sha-a', reviewedAt('sha-a'))]);
  r.tick(600_000, [onHead('sha-b', reviewedAt('sha-a'))]);
  r.tick(600_000 + GRACE_MS, [onHead('sha-b', reviewedAt('sha-a'))]);
  assert.deepEqual(r.edits(), [ASK]);
});

test('escalation: no review 15 minutes after the request raises one COPILOT-LATE', () => {
  const r = rig();
  r.tick(0, [onHead('sha-a')]);
  r.tick(600_000, [onHead('sha-b')]);
  const asked = 600_000 + GRACE_MS;
  r.tick(asked, [onHead('sha-b')]);
  assert.deepEqual(r.tick(asked + ESCALATE_MS - 1, [onHead('sha-b')]), []);
  assert.deepEqual(r.tick(asked + ESCALATE_MS, [onHead('sha-b')]), ['COPILOT-LATE org/repo#5 sha-b: no Copilot review 15 min after it was triggered']);
  assert.deepEqual(r.tick(asked + ESCALATE_MS * 2, [onHead('sha-b')]), []);
});

test('a head that moves again starts fresh: the new sha is requested, the old one is not reported', () => {
  const r = rig();
  r.tick(0, [onHead('sha-a')]);
  r.tick(600_000, [onHead('sha-b')]);
  r.tick(600_000 + GRACE_MS, [onHead('sha-b')]);
  r.tick(1_000_000, [onHead('sha-c')]);
  const lines = r.tick(1_000_000 + ESCALATE_MS, [onHead('sha-c')]);
  assert.deepEqual(r.edits(), [ASK, ASK], 'sha-b once, then sha-c once');
  assert.deepEqual(lines, [], 'sha-b was dropped on the move; sha-c is only just asked for');
});

test('a draft is asked once for a new sha by the once-per-PR rule, and the follow-up does not add a second', () => {
  const r = rig();
  const pending = { reviewRequests: { nodes: [{ requestedReviewer: { login: BOT } }] } };
  r.tick(0, [onHead('sha-a', { isDraft: true, ...reviewedAt('sha-a') })]);
  r.tick(600_000, [onHead('sha-b', { isDraft: true })]);
  assert.deepEqual(r.edits(), [ASK], 'the once-per-PR rule asked; the follow-up waits out its grace');
  r.tick(600_000 + GRACE_MS, [onHead('sha-b', { isDraft: true, ...pending })]);
  r.tick(600_000 + GRACE_MS * 2, [onHead('sha-b', { isDraft: true, ...pending })]);
  assert.deepEqual(r.edits(), [ASK]);
});

test('an owner outside copilot_orgs is never followed or requested, and an unset list follows nowhere', () => {
  for (const orgs of [['someone-else'], []]) {
    const r = rig(orgs);
    r.tick(0, [onHead('sha-a')]);
    r.tick(600_000, [onHead('sha-b')]);
    r.tick(600_000 + GRACE_MS * 3, [onHead('sha-b')]);
    assert.deepEqual(r.edits(), []);
  }
});

test('a snapshot saved before the follow-up existed adopts its heads instead of requesting for all of them', () => {
  const run: Run = () => ({ status: 0, stdout: '', stderr: '' });
  const legacy = { board: { 'org/repo#5': { url: 'u', repo: 'org/repo', number: 5, isDraft: false, head: 'sha-a', headRef: '', base: '', needsCopilot: false, decision: 'NONE', threads: [], replies: [], comments: [], reviews: [] } }, reported: {} };
  assert.equal('copilot' in legacy, false);
  const next = prWatch.check('open-prs', { run: ((cmd, args) => (args[0] === 'api' ? { status: 0, stdout: JSON.stringify({ data: { search: { pageInfo: { hasNextPage: false }, nodes: [onHead('sha-b')] } } }), stderr: '' } : run(cmd, args))) as Run, now: T0 + 5 * GRACE_MS, prev: legacy, config: { ghLogin: 'me', copilotOrgs: ORGS } });
  assert.equal(Object.values(next.copilot ?? {})[0]?.phase, 'done', 'adopted, not watching');
  assert.deepEqual(prWatch.diff(legacy, next).filter((e) => e.summary.startsWith('COPILOT-')), []);
});

test('a PR missing from one search result but still open is not re-told for the same sha when it returns', () => {
  const r = rig();
  const other = prNode(1, { headRefOid: 'x1' });
  r.tick(0, [other, onHead('sha-a')]);
  r.tick(600_000, [other, onHead('sha-b')]);
  r.tick(600_000 + GRACE_MS, [other, onHead('sha-b')]);
  assert.equal(r.tick(1_200_000, [other, onHead('sha-b', reviewedAt('sha-b'))]).length, 1);
  r.tick(1_500_000, [other]); // a lagging search index: #5 is absent but gh says it is still open
  assert.deepEqual(r.tick(1_800_000, [other, onHead('sha-b', reviewedAt('sha-b'))]), []);
});

test('a PR missing from one search result after COPILOT-LATE is not asked again for the same sha when it returns', () => {
  const r = rig();
  const other = prNode(1, { headRefOid: 'x1' });
  r.tick(0, [other, onHead('sha-a')]);
  r.tick(600_000, [other, onHead('sha-b')]);
  r.tick(600_000 + GRACE_MS, [other, onHead('sha-b')]);
  r.tick(600_000 + GRACE_MS + ESCALATE_MS, [other, onHead('sha-b')]);
  r.tick(2_400_000, [other]);
  r.tick(2_700_000, [other, onHead('sha-b')]);
  assert.deepEqual(r.tick(3_000_000, [other, onHead('sha-b')]), []);
  assert.deepEqual(r.edits(), [ASK]);
});

// pr-watch treats a PR missing from the search as open until gh confirms otherwise (asked on the first miss only), so Copilot
// tracking must outlive any number of misses, not just one.
const other = prNode(1, { headRefOid: 'x1' });
const away = (r: ReturnType<typeof rig>, from: number, misses: number): number => {
  for (let i = 0; i < misses; i++) r.tick(from + i * 300_000, [other]);
  return from + misses * 300_000;
};

for (const misses of [2, 3]) {
  test(`a PR missing ${misses} searches after COPILOT-REVIEW is not re-told for the same sha when it returns`, () => {
    const r = rig();
    r.tick(0, [other, onHead('sha-a')]);
    r.tick(600_000, [other, onHead('sha-b')]);
    r.tick(600_000 + GRACE_MS, [other, onHead('sha-b')]);
    assert.equal(r.tick(1_200_000, [other, onHead('sha-b', reviewedAt('sha-b'))]).length, 1);
    const back = away(r, 1_500_000, misses);
    assert.deepEqual(r.tick(back, [other, onHead('sha-b', reviewedAt('sha-b'))]), []);
    assert.deepEqual(r.edits(), [ASK]);
  });

  test(`a PR missing ${misses} searches after COPILOT-LATE is not asked or told again for the same sha when it returns`, () => {
    const r = rig();
    r.tick(0, [other, onHead('sha-a')]);
    r.tick(600_000, [other, onHead('sha-b')]);
    r.tick(600_000 + GRACE_MS, [other, onHead('sha-b')]);
    r.tick(600_000 + GRACE_MS + ESCALATE_MS, [other, onHead('sha-b')]);
    const back = away(r, 2_400_000, misses);
    assert.deepEqual(r.tick(back, [other, onHead('sha-b')]), []);
    assert.deepEqual(r.tick(back + 600_000, [other, onHead('sha-b')]), []);
    assert.deepEqual(r.edits(), [ASK]);
  });
}

test('a PR that returns with a new head after several misses starts that head fresh and does not repeat the old one', () => {
  const r = rig();
  r.tick(0, [other, onHead('sha-a')]);
  r.tick(600_000, [other, onHead('sha-b')]);
  r.tick(600_000 + GRACE_MS, [other, onHead('sha-b')]);
  r.tick(1_200_000, [other, onHead('sha-b', reviewedAt('sha-b'))]);
  const back = away(r, 1_500_000, 3);
  assert.deepEqual(r.tick(back, [other, onHead('sha-c')]), [], 'the tick that first sees the head waits out the grace');
  assert.deepEqual(r.edits(), [ASK]);
  r.tick(back + GRACE_MS, [other, onHead('sha-c')]);
  assert.deepEqual(r.edits(), [ASK, ASK], 'the new head is followed and requested once');
});

test('a PR unseen for more than 24 hours stops being held: the state does not grow forever', () => {
  const r = rig();
  r.tick(0, [other, onHead('sha-a')]);
  r.tick(600_000, [other, onHead('sha-b')]);
  r.tick(600_000 + GRACE_MS, [other, onHead('sha-b')]);
  r.tick(1_200_000, [other, onHead('sha-b', reviewedAt('sha-b'))]);
  r.tick(1_500_000, [other]);
  const held = r.tick(1_800_000, [other]);
  assert.deepEqual(held, []);
  const late = 1_500_000 + prWatch.ABSENT_TTL_MS + 1;
  r.tick(late, [other]);
  assert.deepEqual(r.state()?.absent, {}, 'dropped after the backstop');
  assert.deepEqual(Object.keys(r.state()?.copilot ?? {}).filter((id) => id.startsWith('org/repo#5@')), [], 'and so are its tracks');
});
