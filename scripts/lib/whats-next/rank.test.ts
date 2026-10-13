// Run: node --test scripts/lib/whats-next/rank.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { externalKey, hasDoneSection, names, nextLines, parseRankFile, rankNext, trackerPriority } from './rank.ts';
import type { RankInput, TrackerItem } from './rank.ts';
import type { Ticket } from '../vault/tickets.ts';

const NOW = new Date('2026-10-13T12:00:00Z');
const DONE = '\n## What done looks like\n\n- the lamp is lit in the shire\n';

const ticket = (id: string, over: Partial<Ticket> = {}): Ticket => ({
  id, title: `title of ${id}`, status: 'open', type: 'task', priority: 3, labels: [], blockedBy: [], points: 0,
  path: `Projects/${over.project ?? 'orchard'}/Tickets/${id}.md`, project: 'orchard', archived: false, body: DONE, created: '2026-10-13', ...over,
});
const issue = (key: string, over: Partial<TrackerItem> = {}): TrackerItem => ({ key, title: `issue ${key}`, status: 'To Do', priority: 'Medium', labels: [], ...over });
const input = (over: Partial<RankInput> = {}): RankInput => ({ tickets: [], tracker: null, rankFiles: {}, goals: [], prs: [], inFlight: [], asks: [], frozenLabels: [], blockedLabels: ['needs-you'], now: NOW, ...over });
const ids = (r: ReturnType<typeof rankNext>): string[] => r.ranked.map((c) => c.id);
const reason = (r: ReturnType<typeof rankNext>, id: string): string | undefined => r.excluded.find((e) => e.id === id)?.reason;

test('priority orders the queue, and every term is named with its points', () => {
  const r = rankNext(input({ tickets: [ticket('orchard-1', { priority: 3 }), ticket('orchard-2', { priority: 0 }), ticket('orchard-3', { priority: 1 })] }));
  assert.deepEqual(ids(r), ['orchard-2', 'orchard-3', 'orchard-1']);
  assert.deepEqual(r.ranked[0]!.terms, [{ name: 'priority', points: 40, why: 'P0' }, { name: 'readiness', points: 10, why: 'done defined' }]);
  assert.equal(r.ranked[0]!.score, 50);
});

test('age adds a point a week up to the cap; a missing done section costs 10', () => {
  const r = rankNext(input({ tickets: [ticket('orchard-old', { created: '2026-01-01' }), ticket('orchard-new', { body: 'no section' })] }));
  const old = r.ranked.find((c) => c.id === 'orchard-old')!;
  assert.deepEqual(old.terms.find((t) => t.name === 'age'), { name: 'age', points: 10, why: '40w old' });
  assert.deepEqual(r.ranked.find((c) => c.id === 'orchard-new')!.terms.at(-1), { name: 'readiness', points: -10, why: 'no done section' });
});

test('a pin from the rank file beats priority, and its bonus falls with the place but not under the floor', () => {
  const rankFiles = { orchard: { ranked: ['orchard-9', ...Array.from({ length: 30 }, (_, i) => `filler-${i}`), 'orchard-8'], blocked: [] } };
  const r = rankNext(input({ tickets: [ticket('orchard-1', { priority: 1 }), ticket('orchard-9', { priority: 3 }), ticket('orchard-8', { priority: 3 })], rankFiles }));
  assert.equal(ids(r)[0], 'orchard-9');
  assert.equal(r.ranked.find((c) => c.id === 'orchard-9')!.terms.find((t) => t.name === 'pin')!.points, 30);
  assert.equal(r.ranked.find((c) => c.id === 'orchard-8')!.terms.find((t) => t.name === 'pin')!.points, 10);
});

test('a goal naming the ticket or its key scores 20; one naming only its project as a stream scores 10', () => {
  const tickets = [ticket('orchard-1', { external: 'jira-ZZ-7' }), ticket('orchard-2'), ticket('meadow-1', { project: 'meadow' })];
  const r = rankNext(input({ tickets, goals: [{ text: 'ship ZZ-7 before the feast' }, { text: 'tidy the orchard', stream: 'Orchard' }] }));
  const goal = (id: string) => r.ranked.find((c) => c.id === id)!.terms.find((t) => t.name === 'goal');
  assert.deepEqual(goal('orchard-1'), { name: 'goal', points: 20, why: 'named in a goal' });
  assert.equal(goal('orchard-2')!.points, 10);
  assert.equal(goal('meadow-1'), undefined);
});

test('an open PR naming the key in its branch costs 15 and says which PR', () => {
  const r = rankNext(input({ tickets: [ticket('orchard-1', { external: 'jira-ZZ-7' })], prs: [{ number: 41, repo: 'o/r', title: 'feat: lamps', branch: 'feat/ZZ-7-lamps', url: 'https://example.test/41' }] }));
  assert.deepEqual(r.ranked[0]!.terms.at(-1), { name: 'pr', points: -15, why: 'PR #41 open' });
});

test('names matches whole tokens only', () => {
  assert.equal(names('see orchard-12 today', 'orchard-1'), false);
  assert.equal(names('see orchard-1, today', 'orchard-1'), true);
  assert.equal(names('feat/zz-7-x', 'ZZ-7'), true);
  assert.equal(names('ZZ-70', 'ZZ-7'), false);
});

test('every hold-back reason, and closed items are left out entirely', () => {
  const tickets = [
    ticket('t-closed', { status: 'closed' }), ticket('t-archived', { archived: true }),
    ticket('t-frozen', { labels: ['Pilot-Freeze'] }), ticket('t-active', { status: 'in-progress' }), ticket('t-blocked', { status: 'blocked' }),
    ticket('t-dep', { blockedBy: ['t-ok'] }), ticket('t-dep-done', { blockedBy: ['t-closed'] }), ticket('t-user'), ticket('t-label', { labels: ['needs-you'] }),
    ticket('t-ask'), ticket('t-flight'), ticket('t-ok'),
  ];
  const r = rankNext(input({
    tickets, frozenLabels: ['pilot-freeze'], rankFiles: { orchard: { ranked: [], blocked: ['t-user'] } },
    asks: [{ id: 'q1', text: 'should t-ask wait for the harvest?' }], inFlight: [{ id: 'w1', text: 'building', ticket: 't-flight' }],
  }));
  assert.deepEqual(ids(r).sort(), ['t-dep-done', 't-ok']);
  assert.equal(reason(r, 't-closed'), undefined);
  assert.equal(reason(r, 't-archived'), undefined);
  assert.match(reason(r, 't-frozen')!, /^frozen \(label Pilot-Freeze\): read-only/);
  assert.equal(reason(r, 't-active'), 'in progress');
  assert.equal(reason(r, 't-blocked'), 'blocked (status)');
  assert.equal(reason(r, 't-dep'), 'blocked by t-ok');
  assert.equal(reason(r, 't-user'), 'waiting on the user (rank file)');
  assert.equal(reason(r, 't-label'), 'waiting on the user (label needs-you)');
  assert.equal(reason(r, 't-ask'), 'open question q1 names it');
  assert.equal(reason(r, 't-flight'), 'in flight (w1)');
});

test('a frozen label wins over every other reason, so a frozen item is never shown as merely blocked', () => {
  const r = rankNext(input({ tickets: [ticket('t-1', { status: 'blocked', labels: ['pilot-freeze'] })], frozenLabels: ['pilot-freeze'] }));
  assert.match(reason(r, 't-1')!, /^frozen/);
});

test('a ticket mirroring a tracker issue is one item with the higher priority and the earlier date; other issues stand alone', () => {
  const tracker = { fetchedAt: '2026-10-13T10:00:00Z', source: 'jira', items: [issue('ZZ-7', { priority: 'Highest', created: '2026-09-01' }), issue('ZZ-8', { doneLooksLike: true, url: 'https://example.test/ZZ-8' })] };
  const r = rankNext(input({ tickets: [ticket('orchard-1', { external: 'jira-ZZ-7', priority: 2, created: '2026-10-10' })], tracker }));
  assert.deepEqual(ids(r), ['orchard-1', 'ZZ-8']);
  const merged = r.ranked[0]!;
  assert.equal(merged.source, 'both');
  assert.equal(merged.key, 'ZZ-7');
  assert.equal(merged.priority, 0);
  assert.equal(merged.terms.find((t) => t.name === 'age')!.why, '6w old');
  assert.deepEqual({ project: r.ranked[1]!.project, url: r.ranked[1]!.url, ready: r.ranked[1]!.terms.at(-1)!.points }, { project: 'ZZ', url: 'https://example.test/ZZ-8', ready: 10 });
  assert.equal(r.trackerFetchedAt, '2026-10-13T10:00:00Z');
});

test('the tracker side of a merged item can hold it back: in progress there means in progress here', () => {
  const tracker = { fetchedAt: '2026-10-13T10:00:00Z', source: 'jira', items: [issue('ZZ-7', { status: 'In Review' }), issue('ZZ-9', { status: 'Done' })] };
  const r = rankNext(input({ tickets: [ticket('orchard-1', { external: 'jira-ZZ-7' })], tracker }));
  assert.deepEqual(ids(r), []);
  assert.equal(reason(r, 'orchard-1'), 'in progress');
  assert.equal(reason(r, 'ZZ-9'), undefined);
});

test('trackerPriority, externalKey and hasDoneSection', () => {
  assert.deepEqual(['Highest', 'High', 'Medium', 'Low', 'Lowest', 'P1', '4', 'whatever'].map(trackerPriority), [0, 1, 2, 3, 4, 1, 4, 3]);
  assert.equal(externalKey('jira-ZZ-12'), 'ZZ-12');
  assert.equal(externalKey('ZZ-12'), 'ZZ-12');
  assert.equal(externalKey('a note'), undefined);
  assert.equal(hasDoneSection('## What done looks like\n\n_TBD_\n\n## Next\n- x'), false);
  assert.equal(hasDoneSection('## What done looks like\n\n- the gate opens\n## Next\n'), true);
  assert.equal(hasDoneSection('## What done looks like\n'), false);
});

test('parseRankFile reads Ranked in order and every Blocked-on heading, ignoring other sections', () => {
  const text = '# rank\n## Ranked\n### group\n1. [[orchard-3]] — x\n2. [[orchard-1|alias]] and [[orchard-3]]\n## Blocked on Frodo\n- [[orchard-2]]\n## Flags\n- [[orchard-9]]\n';
  assert.deepEqual(parseRankFile(text), { ranked: ['orchard-3', 'orchard-1'], blocked: ['orchard-2'] });
});

test('nextLines prints the top N with the why, and --all adds what was held back', () => {
  const r = rankNext(input({ tickets: [ticket('t-a', { priority: 0 }), ticket('t-b'), ticket('t-c', { status: 'blocked' })] }));
  const top = nextLines(r, { top: 1 });
  assert.equal(top[0], "What's next (1 of 2 ready, 1 held back)");
  assert.equal(top[1], '1. t-a · 50 · title of t-a [orchard] · P0 +40, done defined +10');
  assert.equal(top.length, 2);
  const all = nextLines(r, { top: 5, all: true });
  assert.deepEqual(all.slice(-2), ['Held back:', '- t-c [orchard] title of t-c · blocked (status)']);
  assert.match(nextLines(rankNext(input()), { top: 5 })[1]!, /^Nothing ready/);
});
