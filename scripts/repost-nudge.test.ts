// Run: node --test scripts/repost-nudge.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_TYPES } from './event-types/index.ts';
import * as nudge from './event-types/repost-nudge.ts';
import type { NudgeIo } from './event-types/repost-nudge.ts';
import { latestAsk, latestAskInDir } from './lib/repost-nudge-slack.ts';
import { advance, inWorkingHours, selectRepost, slackMessage } from './lib/repost-nudge.ts';
import type { NudgePr, NudgeSettings, NudgeState } from './lib/repost-nudge.ts';
import { addDraft, draftsPath } from './lib/drafts/queue.ts';
import type { NewDraft } from './lib/drafts/queue.ts';

// 2026-10-14 is a Wednesday; October is EDT (UTC-4), so 13:00Z is 09:00 ET.
const WED_9AM = Date.parse('2026-10-14T13:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const S: NudgeSettings = { minutes: 60, askedMinutes: 60, count: 3, start: '08:30', end: '18:00', zone: 'America/New_York', selfReview: [], owners: ['org'] };

const pr = (n: number, over: Partial<NudgePr> = {}): NudgePr => ({ repo: 'org/api', number: n, url: `https://github.com/org/api/pull/${n}`, isDraft: false, reviewDecision: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE', unresolvedThreads: 0, readySince: WED_9AM - n * HOUR, approvedAt: Number.NaN, rerequestedAt: Number.NaN, ...over });

/** The loop's view: check, diff, remember. `set` changes what GitHub and the draft queue show. */
function rig(start = WED_9AM, s: NudgeSettings = S) {
  let now = start;
  let prs: NudgePr[] = [pr(1), pr(2), pr(3), pr(4)];
  let draftAt = 0;
  let slackAt = 0;
  let state: NudgeState | null = null;
  const lines: string[] = [];
  const io: NudgeIo = { fetchPrs: () => prs, latestDraftAt: () => draftAt, latestSlackAskAt: () => slackAt };
  const tick = (): void => { const next = nudge.check('dir', { now, prev: state, run: () => ({ status: 0, stdout: '', stderr: '' }) }, io, s); lines.push(...nudge.diff(state, next).map((e) => e.summary)); state = next; };
  return {
    lines, tick,
    at: (ms: number) => { now = ms; },
    advanceBy: (ms: number) => { now += ms; },
    prs: (p: NudgePr[]) => { prs = p; },
    approve: (ms: number) => { prs = prs.map((p, i) => (i === 0 ? { ...p, approvedAt: ms } : p)); },
    draft: (ms: number) => { draftAt = ms; },
    slack: (ms: number) => { slackAt = ms; },
    rerequest: (ms: number) => { prs = prs.map((p, i) => (i === 1 ? { ...p, rerequestedAt: ms } : p)); },
  };
}

test('the type is registered, a renewing singleton that reads the network', () => {
  assert.equal(BUILTIN_TYPES['repost-nudge'], nudge);
  assert.equal(nudge.network, true);
  assert.equal(nudge.singleton, true);
  assert.equal(nudge.renews, true);
});

test('an approval nudges 60 minutes later, not before, and names the oldest-waiting PRs with a paste-ready line', () => {
  const r = rig();
  r.tick();
  r.approve(WED_9AM + 5 * MIN);
  r.advanceBy(10 * MIN); r.tick();
  r.advanceBy(54 * MIN); r.tick();
  assert.equal(r.lines.length, 0, '59 minutes after the approval is early');
  r.advanceBy(2 * MIN); r.tick();
  assert.equal(r.lines.length, 1);
  assert.match(r.lines[0] ?? '', /^repost-nudge: 60 min since the last approval; repost 3 PRs waiting longest \(org\/api#4 \d+m, org\/api#3 \d+m, org\/api#2 \d+m\)\. Slack: "Could I get a review on these PRs\? https:\/\/github\.com\/org\/api\/pull\/4 /);
  r.advanceBy(HOUR); r.tick();
  assert.equal(r.lines.length, 1, 'one approval, one nudge');
});

test('approvals already on GitHub when the type first runs are adopted, not nudged', () => {
  const r = rig();
  r.approve(WED_9AM - 3 * HOUR);
  r.tick();
  r.advanceBy(2 * HOUR); r.tick();
  assert.equal(r.lines.length, 0);
});

test('a newer approval restarts the hour', () => {
  const r = rig();
  r.tick();
  r.approve(WED_9AM + MIN); r.advanceBy(2 * MIN); r.tick();
  r.approve(WED_9AM + 40 * MIN); r.advanceBy(50 * MIN); r.tick();
  assert.equal(r.lines.length, 0, 'the second approval is only 12 minutes old');
  r.advanceBy(60 * MIN); r.tick();
  assert.equal(r.lines.length, 1);
});

test('a teammate review draft nudges at once, and one already in the queue at first run does not', () => {
  const r = rig();
  r.draft(WED_9AM - HOUR);
  r.tick();
  assert.equal(r.lines.length, 0);
  r.advanceBy(5 * MIN); r.draft(WED_9AM + 4 * MIN); r.tick();
  assert.equal(r.lines.length, 1);
  assert.match(r.lines[0] ?? '', /^repost-nudge: a teammate review is queued; repost 3 PRs/);
});

test('at most one nudge an hour: a draft right after another nudge waits for the hour to pass', () => {
  const r = rig();
  r.tick();
  r.advanceBy(MIN); r.draft(WED_9AM + MIN); r.tick();
  assert.equal(r.lines.length, 1);
  r.advanceBy(10 * MIN); r.draft(WED_9AM + 11 * MIN); r.tick();
  assert.equal(r.lines.length, 1, 'held inside the hour');
  r.advanceBy(50 * MIN); r.tick();
  assert.equal(r.lines.length, 2, 'sent once the hour has passed');
  r.advanceBy(3 * HOUR); r.tick();
  assert.equal(r.lines.length, 2);
});

test('a nudge due at night, on a weekend, or before the start is held and sent once, when the hours open', () => {
  const r = rig(Date.parse('2026-10-14T21:00:00Z')); // 17:00 ET Wednesday
  r.tick();
  r.draft(Date.parse('2026-10-14T22:30:00Z')); // 18:30 ET: after the end
  r.at(Date.parse('2026-10-14T22:31:00Z')); r.tick();
  r.at(Date.parse('2026-10-15T11:00:00Z')); r.tick(); // 07:00 ET Thursday: before the start
  assert.equal(r.lines.length, 0);
  r.at(Date.parse('2026-10-15T12:29:00Z')); r.tick(); // 08:29
  assert.equal(r.lines.length, 0);
  r.at(Date.parse('2026-10-15T12:30:00Z')); r.tick(); // 08:30
  assert.equal(r.lines.length, 1);
  r.at(Date.parse('2026-10-15T14:00:00Z')); r.tick();
  assert.equal(r.lines.length, 1, 'one held nudge is one nudge');

  const w = rig(Date.parse('2026-10-16T21:00:00Z')); // Friday 17:00 ET
  w.tick();
  w.at(Date.parse('2026-10-17T15:00:00Z')); w.draft(Date.parse('2026-10-17T15:00:00Z')); w.tick(); // Saturday
  w.at(Date.parse('2026-10-18T15:00:00Z')); w.tick(); // Sunday
  assert.equal(w.lines.length, 0);
  w.at(Date.parse('2026-10-19T12:30:00Z')); w.tick(); // Monday 08:30
  assert.equal(w.lines.length, 1);
});

test('working hours follow the zone through the daylight-saving change', () => {
  const s = { start: '08:30', end: '18:00', zone: 'America/New_York' };
  assert.equal(inWorkingHours(Date.parse('2026-10-14T12:30:00Z'), s), true, 'EDT: 08:30');
  assert.equal(inWorkingHours(Date.parse('2026-11-04T13:29:00Z'), s), false, 'EST: 08:29');
  assert.equal(inWorkingHours(Date.parse('2026-11-04T13:30:00Z'), s), true, 'EST: 08:30');
  assert.equal(inWorkingHours(Date.parse('2026-11-04T23:00:00Z'), s), false, 'EST: 18:00 is the end');
});

test('only PRs waiting on a reviewer are named, oldest first, at most the count', () => {
  const now = WED_9AM;
  const named = selectRepost([
    pr(1, { readySince: now - 1 * HOUR }),
    pr(2, { isDraft: true }),
    pr(3, { reviewDecision: 'CHANGES_REQUESTED' }),
    pr(4, { reviewDecision: 'APPROVED' }),
    pr(5, { mergeable: 'CONFLICTING' }),
    pr(11, { mergeable: 'UNKNOWN', readySince: now - 20 * HOUR }),
    pr(6, { unresolvedThreads: 1 }),
    pr(7, { repo: 'me/personal' }),
    pr(8, { repo: 'org/tool', readySince: now - 9 * HOUR }),
    pr(9, { readySince: now - 5 * HOUR }),
    pr(10, { readySince: now - 3 * HOUR }),
  ], now, { count: 3, selfReview: ['org/tool'], owners: ['org'] });
  assert.deepEqual(named.map((p) => p.key), ['org/api#11', 'org/api#9', 'org/api#10']);
  assert.equal(named[1]?.waitedMin, 300);
});

test('with nobody waiting the trigger is answered silently and nothing is held for later', () => {
  const r = rig();
  r.prs([pr(1, { reviewDecision: 'APPROVED' })]);
  r.tick();
  r.advanceBy(MIN); r.draft(WED_9AM + MIN); r.tick();
  assert.equal(r.lines.length, 0);
  r.prs([pr(2)]);
  r.advanceBy(2 * HOUR); r.tick();
  assert.equal(r.lines.length, 0, 'the answered trigger does not come back');
});

test('minutes 0 turns it off: it never reads GitHub and never speaks', () => {
  const off = { ...S, minutes: 0 };
  let reads = 0;
  const io: NudgeIo = { fetchPrs: () => { reads++; return [pr(1)]; }, latestDraftAt: () => WED_9AM, latestSlackAskAt: () => 0 };
  let state: NudgeState | null = null;
  for (let i = 0; i < 3; i++) { const next = nudge.check('d', { now: WED_9AM + i * HOUR, prev: state, run: () => ({ status: 0, stdout: '', stderr: '' }) }, io, off); assert.deepEqual(nudge.diff(state, next), []); state = next; }
  assert.equal(reads, 0);
});

test('a failed GitHub read throws, so the loop keeps the last state', () => {
  const io: NudgeIo = { fetchPrs: () => { throw new Error('gh api graphql failed'); }, latestDraftAt: () => 0, latestSlackAskAt: () => 0 };
  assert.throws(() => nudge.check('d', { now: WED_9AM, prev: null, run: () => ({ status: 1, stdout: '', stderr: '' }) }, io, S), /gh api graphql failed/);
});

test('the Slack line lists the links, and says "this PR" for one', () => {
  assert.equal(slackMessage([{ key: 'o/r#1', url: 'https://x/1', waitedMin: 5 }]), 'Could I get a review on this PR? https://x/1');
  assert.equal(advance(null, { approvedAt: 5, draftAt: 0 }, [], WED_9AM, S).approvedHandled, 5);
});

test('toPr takes the newest approval, counts unresolved threads and reads ready time from the ready event', () => {
  const p = nudge.toPr({
    number: 7, url: 'u', isDraft: false, createdAt: '2026-10-01T00:00:00Z', reviewDecision: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE', repository: { nameWithOwner: 'org/api' },
    latestReviews: { nodes: [{ state: 'APPROVED', submittedAt: '2026-10-14T10:00:00Z' }, { state: 'COMMENTED', submittedAt: '2026-10-14T12:00:00Z' }, { state: 'APPROVED', submittedAt: '2026-10-14T11:00:00Z' }] },
    reviewThreads: { nodes: [{ isResolved: true }, { isResolved: false }] },
    timelineItems: { nodes: [{ createdAt: '2026-10-10T00:00:00Z' }] },
  });
  assert.equal(p.approvedAt, Date.parse('2026-10-14T11:00:00Z'));
  assert.equal(p.unresolvedThreads, 1);
  assert.equal(p.readySince, Date.parse('2026-10-10T00:00:00Z'));
});

test('the user asking for reviews in Slack holds the nudge until 60 minutes after the ask, then it is sent once', () => {
  const r = rig();
  r.tick();
  r.slack(WED_9AM + 10 * MIN);
  r.advanceBy(11 * MIN); r.draft(WED_9AM + 11 * MIN); r.tick();
  r.advanceBy(40 * MIN); r.tick();
  assert.equal(r.lines.length, 0, 'inside the hour after the ask');
  r.advanceBy(20 * MIN); r.tick();
  assert.equal(r.lines.length, 1, 'the ask is over 60 minutes old');
  r.advanceBy(3 * HOUR); r.tick();
  assert.equal(r.lines.length, 1);
});

test('a review re-request the user made on GitHub holds it too, and the window is configurable', () => {
  const r = rig();
  r.tick();
  r.rerequest(WED_9AM + 5 * MIN);
  r.advanceBy(6 * MIN); r.draft(WED_9AM + 6 * MIN); r.tick();
  assert.equal(r.lines.length, 0);
  r.advanceBy(60 * MIN); r.tick();
  assert.equal(r.lines.length, 1);
  const short = rig(WED_9AM, { ...S, askedMinutes: 10 });
  short.tick();
  short.slack(WED_9AM + 5 * MIN);
  short.advanceBy(6 * MIN); short.draft(WED_9AM + 6 * MIN); short.tick();
  assert.equal(short.lines.length, 0);
  short.advanceBy(10 * MIN); short.tick();
  assert.equal(short.lines.length, 1, 'ten-minute window has passed');
});

const NOTE = [
  '# Slack',
  '- 2026-10-15 17:46 ET **Sam**: could someone look at https://github.com/example-org/rest-api/pull/12 please',
  '- 2026-10-15 17:50 ET **Dana**: https://github.com/example-org/rest-api/pull/13',
  '- 2026-10-15 17:55 ET **Sam**: lunch? https://example.com/pull/1',
  '- 2026-10-15 18:05 ET **Sam**: see https://github.com/other-org/repo/pull/4',
  '- 2026-10-15 14:00 PT **Sam**: https://github.com/example-org/rest-api/pull/14',
].join('\n');

test('a Slack line by the user with an owner PR link is an ask, in Eastern time; other authors, links, owners and zones are not', () => {
  assert.equal(latestAsk(NOTE, 'Sam', ['example-org']), Date.parse('2026-10-15T21:46:00Z'));
  assert.equal(latestAsk(NOTE, 'sam', []), Date.parse('2026-10-15T22:05:00Z'), 'no owner filter: any PR link counts');
  assert.equal(latestAsk(NOTE, 'Dana', ['example-org']), Date.parse('2026-10-15T21:50:00Z'));
  assert.equal(latestAsk(NOTE, 'Nobody', []), 0);
  assert.equal(latestAsk('- 2026-01-15 17:46 ET **Sam**: https://github.com/example-org/a/pull/1', 'Sam', []), Date.parse('2026-01-15T22:46:00Z'), 'EST in winter');
});

test('the Slack folder reader takes recent notes only and survives a missing folder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'repost-slack-'));
  writeFileSync(join(dir, 'a.md'), NOTE);
  writeFileSync(join(dir, 'b.txt'), NOTE.replace('17:46', '23:59'));
  const now = Date.now();
  assert.equal(latestAskInDir(dir, 'Sam', ['example-org'], now, 60_000), Date.parse('2026-10-15T21:46:00Z'));
  assert.equal(latestAskInDir(dir, 'Sam', ['example-org'], now + 3 * HOUR, HOUR), 0, 'a note untouched past the look-back is skipped');
  assert.equal(latestAskInDir(join(dir, 'missing'), 'Sam', [], now, HOUR), 0);
});

test('the draft reader sees a queued teammate review and a post of it, and ignores a reply draft', () => {
  const dir = mkdtempSync(join(tmpdir(), 'repost-nudge-'));
  const file = draftsPath(dir, 'p');
  assert.equal(nudge.latestReviewDraftAt(file), 0);
  const at = (iso: string) => ({ now: () => new Date(iso) });
  const base = { repo: 'org/api', pr: 5, text: 'x', target: { kind: 'general' } } as const;
  addDraft(file, { ...base, key: 'rep', source: 'reply', severity: 'reply', replyTo: 'someone', target: { kind: 'reply', commentId: 1 } } as NewDraft, at('2026-10-14T13:00:00Z'));
  assert.equal(nudge.latestReviewDraftAt(file), 0);
  addDraft(file, { ...base, key: 'rev', source: 'review', severity: 'suggestion' } as NewDraft, at('2026-10-14T14:00:00Z'));
  assert.equal(nudge.latestReviewDraftAt(file), Date.parse('2026-10-14T14:00:00Z'));
});

test('toPr counts a re-request of a person by the user, not Copilot, a team or someone else\'s request', () => {
  const at = (h: number) => `2026-10-14T0${h}:00:00Z`;
  const node = (requests: { createdAt: string; actor: { login: string }; requestedReviewer: { __typename: string; login?: string } }[]) =>
    nudge.toPr({ number: 1, url: 'u', isDraft: false, repository: { nameWithOwner: 'org/api' }, requests: { nodes: requests } }, 'me');
  assert.ok(Number.isNaN(node([
    { createdAt: at(5), actor: { login: 'me' }, requestedReviewer: { __typename: 'Bot', login: 'copilot-pull-request-reviewer' } },
    { createdAt: at(6), actor: { login: 'me' }, requestedReviewer: { __typename: 'Team' } },
    { createdAt: at(7), actor: { login: 'other' }, requestedReviewer: { __typename: 'User', login: 'dana' } },
  ]).rerequestedAt));
  assert.equal(node([{ createdAt: at(4), actor: { login: 'ME' }, requestedReviewer: { __typename: 'User', login: 'dana' } }]).rerequestedAt, Date.parse(at(4)));
});
