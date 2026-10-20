// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/lib/teammate/prune.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addDraft, listDrafts } from '../drafts/queue.ts';
import type { NewDraft } from '../drafts/queue.ts';
import type { GhRead } from '../drafts/reconcile.ts';
import { readOthersCache, refreshOthers, writeOthersCache } from './others.ts';
import type { OtherPr } from './others.ts';
import { dropGate } from './others-drop.ts';
import { addToList, listPath, readList } from './others-list.ts';
import type { Run } from '../types.ts';
import { pruneOthers } from './prune.ts';

const COMPLIMENT = 'The ID validation before anything goes into a URL is exactly right.';
const draft = (pr: number): NewDraft => ({ key: `acme/widgets#${pr}@abcdef1:review`, source: 'review', repo: 'acme/widgets', pr, severity: 'review', target: { kind: 'review', commitId: `abcdef1${'0'.repeat(33)}` }, text: `${COMPLIMENT}\n\nOne nit.`, review: { compliment: COMPLIMENT, comments: [] } });
const card = (number: number): OtherPr => ({ repo: 'acme/widgets', number, title: 't', url: `https://github.com/acme/widgets/pull/${number}`, author: 'pat-fake', base: 'develop', head: 'h', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', requested: [], decision: null, unresolved: 0, copilotThreads: 0 });

interface Pr { state?: string; requested?: string[]; reviews?: unknown[]; comments?: unknown[] }
const rv = (login: string, state: string, at: string, body = '', type = 'User'): unknown => ({ user: { login, type }, state, submitted_at: at, body });
const cm = (login: string, at: string, body = 'why this?', type = 'User'): unknown => ({ user: { login, type }, created_at: at, body });
/** A fake gh: `byPr` is the PR's facts; a PR absent from it is unreadable. */
const gh = (byPr: Record<number, Pr>): GhRead => (args) => {
  if (args[0] === 'api') {
    const m = /pulls\/(\d+)\/(reviews|comments)/.exec(args[2] ?? '');
    const v = m ? byPr[Number(m[1])] : undefined;
    if (!v || !m) return { status: 1, stdout: '', stderr: 'nope' };
    return { status: 0, stdout: ((m[2] === 'reviews' ? v.reviews : v.comments) ?? []).map((x) => JSON.stringify(x)).join('\n'), stderr: '' };
  }
  const v = byPr[Number(args[args.indexOf('view') + 1])];
  if (!v) return { status: 1, stdout: '', stderr: 'nope' };
  return { status: 0, stderr: '', stdout: JSON.stringify({ state: v.state ?? 'OPEN', reviewDecision: '', author: { login: 'pat-fake' }, createdAt: '2026-10-01T00:00:00Z', reviewRequests: (v.requested ?? []).map((login) => ({ login })), commits: [{ committedDate: '2026-10-01T00:00:00Z' }] }) };
};

function setup(prs: number[]): { statusDir: string; draftsFile: string } {
  const root = mkdtempSync(join(tmpdir(), 'prune-'));
  const statusDir = join(root, 'Status');
  mkdirSync(join(root, 'J'), { recursive: true });
  const draftsFile = join(root, 'J', 'drafts.jsonl');
  writeOthersCache(statusDir, { fetchedAt: new Date('2026-10-19T00:00:00Z'), prs: prs.map(card) });
  for (const n of prs) { addDraft(draftsFile, draft(n)); addToList(listPath(statusDir), { key: `acme/widgets#${n}`, source: 'manual' }, Date.parse('2026-10-18T00:00:00Z')); }
  return { statusDir, draftsFile };
}

test('a merged or closed PR, or one a person reviewed or only commented inline on, leaves the tab and its draft is rejected', () => {
  const { statusDir, draftsFile } = setup([1, 2, 3, 4, 5]);
  const run = gh({
    1: { state: 'MERGED' }, 2: { state: 'CLOSED' },
    3: { reviews: [rv('kim-fake', 'COMMENTED', '2026-10-02T00:00:00Z', 'Looks fine to me.')] },
    4: { comments: [cm('lee-fake', '2026-10-02T00:00:00Z')] },
    5: {},
  });
  const lines: string[] = [];
  const out = pruneOthers({ statusDir, draftsFile, self: 'me-fake', run }, (l) => lines.push(l));
  assert.deepEqual(out.cards.map((c) => c.number), [1, 2, 3, 4]);
  assert.deepEqual(readOthersCache(statusDir)?.prs.map((p) => p.number), [5]);
  assert.deepEqual(listDrafts(draftsFile).map((d) => [d.pr, d.state]), [[1, 'rejected'], [2, 'rejected'], [3, 'rejected'], [4, 'rejected'], [5, 'pending']]);
  assert.equal(lines.filter((l) => l.startsWith('pruned card')).length, 4);
  assert.equal(lines.filter((l) => l.startsWith('rejected draft')).length, 4);
});

test('the author, you, a bot and a bot-typed comment do not prune a card', () => {
  const { statusDir, draftsFile } = setup([1, 2, 3, 4]);
  const run = gh({
    1: { comments: [cm('pat-fake', '2026-10-02T00:00:00Z')] },
    2: { reviews: [rv('me-fake', 'COMMENTED', '2026-10-02T00:00:00Z', 'mine')] },
    3: { reviews: [rv('some-linter', 'COMMENTED', '2026-10-02T00:00:00Z', 'warn', 'Bot')] },
    4: { comments: [cm('some-scanner', '2026-10-02T00:00:00Z', 'finding', 'Bot')] },
  });
  const out = pruneOthers({ statusDir, draftsFile, self: 'me-fake', run });
  assert.equal(out.cards.length, 0);
  assert.equal(readOthersCache(statusDir)?.prs.length, 4);
});

test('a PR GitHub cannot be read stays, and a second run prunes nothing more', () => {
  const { statusDir, draftsFile } = setup([1, 2]);
  const run = gh({ 1: { state: 'MERGED' } });
  const first = pruneOthers({ statusDir, draftsFile, self: 'me-fake', run });
  assert.deepEqual([first.cards.length, first.unread], [1, 1]);
  const second = pruneOthers({ statusDir, draftsFile, self: 'me-fake', run });
  assert.deepEqual([second.cards.length, second.drafts.length], [0, 0]);
  assert.deepEqual(readOthersCache(statusDir)?.prs.map((p) => p.number), [2]);
});

test('with no cache and no drafts there is nothing to prune and nothing throws', () => {
  const root = mkdtempSync(join(tmpdir(), 'prune-'));
  const out = pruneOthers({ statusDir: join(root, 'none'), draftsFile: join(root, 'drafts.jsonl'), self: 'me-fake', run: gh({}) });
  assert.deepEqual([out.cards.length, out.drafts.length, out.unread], [0, 0, 0]);
});

const SCOPE = { owners: ['acme'], selfRepos: [], self: 'me-fake', gate: dropGate('America/New_York', { openHours: 72, activeHours: 48, dropDays: 2 }) };
const NOW = new Date('2026-10-19T01:00:00Z');

/** A fake gh that serves each listed PR as the GraphQL node the rebuild reads (open, nobody has looked: the rebuild cannot see inline comments), and nothing for the discovery searches. */
const graphql = (open: number[]): Run => (_cmd, args) => {
  const q = args.find((a) => a.startsWith('query=')) ?? '';
  if (q.includes('search(')) return { status: 0, stderr: '', stdout: JSON.stringify({ data: { search: { pageInfo: { hasNextPage: false }, nodes: [] } } }) };
  const data: Record<string, unknown> = {};
  for (const m of q.matchAll(/(p\d+): repository\(owner: "[^"]+", name: "[^"]+"\) \{ pullRequest\(number: (\d+)\)/g)) {
    const n = Number(m[2]);
    data[m[1] as string] = { pullRequest: open.includes(n) ? { ...card(n), state: 'OPEN', isDraft: false, baseRefName: 'develop', headRefName: 'h', author: { login: 'pat-fake', __typename: 'User' }, repository: { nameWithOwner: 'acme/widgets' }, reviewRequests: { nodes: [] }, reviewThreads: { nodes: [] }, reviews: { nodes: [] } } : null };
  }
  return { status: 0, stderr: '', stdout: JSON.stringify({ data }) };
};

test('a pruned PR leaves the list with the updatedAt it was judged at, and the rebuild does not bring it back', () => {
  const { statusDir, draftsFile } = setup([3, 5]);
  pruneOthers({ statusDir, draftsFile, self: 'me-fake', run: gh({ 3: { comments: [cm('lee-fake', '2026-10-02T00:00:00Z')] }, 5: {} }) });
  const s = readList(listPath(statusDir));
  assert.deepEqual([...s.active.keys()], ['acme/widgets#5']);
  assert.equal(s.dropped.get('acme/widgets#3')?.updatedAt, card(3).updatedAt);
  // The rebuild reads reviews but not inline comments, so by itself it would call #3 unsettled: it must not read it at all.
  const again = refreshOthers(statusDir, SCOPE, NOW, graphql([3, 5]));
  assert.deepEqual(again.prs.map((p) => p.number), [5]);
});

test('a pruned PR stays off while a discovery sees nothing new, and returns when it is asked about again after something happened', () => {
  const { statusDir, draftsFile } = setup([3]);
  pruneOthers({ statusDir, draftsFile, self: 'me-fake', run: gh({ 3: { comments: [cm('lee-fake', '2026-10-02T00:00:00Z')] } }) });
  const seen = (updatedAt: string): Run => (cmd, args) => {
    const q = args.find((a) => a.startsWith('query=')) ?? '';
    if (q.includes('review-requested:@me')) return { status: 0, stderr: '', stdout: JSON.stringify({ data: { search: { pageInfo: { hasNextPage: false }, nodes: [{ number: 3, url: card(3).url, updatedAt, headRefName: 'h', baseRefName: 'develop', author: { login: 'pat-fake', __typename: 'User' }, repository: { nameWithOwner: 'acme/widgets' }, labels: { nodes: [] } }] } } }) };
    return graphql([3])(cmd, args);
  };
  assert.deepEqual(refreshOthers(statusDir, SCOPE, NOW, seen(card(3).updatedAt)).prs, []);
  assert.deepEqual(refreshOthers(statusDir, SCOPE, NOW, seen('2026-10-18T00:00:00Z')).prs.map((p) => p.number), [3]);
});
