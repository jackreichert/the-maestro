// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/lib/teammate/context.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextProblem, findJiraKeys, permalink, readJira, renderSummary, renderTicket } from './context.ts';
import type { Fetcher, ReviewContext } from './context.ts';
import { planReview } from './bar.ts';

const HEAD = 'a'.repeat(40);
const DIFF = new Map([['src/mod/a b.ts', new Set([10, 11, 12, 30])], ['src/b.ts', new Set([5])]]);
const NICE = 'The ID validation before anything goes into a URL is careful and easy to follow.';
const CTX: ReviewContext = {
  summary: 'Shows the named sender on each delivery row in the referral details panel.',
  ticket: { status: 'read', key: 'WID-1234', verdict: 'partly', missing: ['empty state copy'], extra: ['a new index'] },
  tests: { status: 'reported', count: 4, ran: 'node --test on the delivery module, 4 passing', gaps: ['the sender lookup is mocked'] },
  core: [{ path: 'src/mod/a b.ts', start: 10, end: 12, label: 'Delivery rows join the sender' }, { path: 'src/b.ts', start: 5, end: 5, label: 'Name passed to the view' }],
};

test('the Jira key is taken from the title first, then the branch, then the body, once each', () => {
  assert.deepEqual(findJiraKeys({ title: 'WID-12 fix', branch: 'feat/WID-99-x', body: 'see WID-12 and AB-7' }), ['WID-12', 'WID-99', 'AB-7']);
  assert.deepEqual(findJiraKeys({ title: 'no key', body: 'UTF-8 and x' }), []);
});

test('a permalink pins the exact lines at the head sha, and encodes odd path characters', () => {
  const k = CTX.core[0];
  assert.ok(k);
  assert.equal(permalink('acme/widgets', HEAD, k), `https://github.com/acme/widgets/blob/${HEAD}/src/mod/a%20b.ts#L10-L12`);
  assert.equal(permalink('acme/widgets', HEAD, { path: 'x.ts', start: 7, end: 7, label: 'x' }), `https://github.com/acme/widgets/blob/${HEAD}/x.ts#L7-L7`);
});

test('the body reads: what it does, core logic, tests, ticket match, suggestions, then the compliment and the closing line', () => {
  const plan = planReview({ repo: 'acme/widgets', pr: 3, head: HEAD }, NICE, [], new Map([['src/mod/a b.ts', new Set([10, 11, 12])], ['src/b.ts', new Set([5])]]), CTX);
  const t = plan.draft?.text ?? '';
  const at = ['**What it does**', '**Core logic**', '**Tests:** 4 tests added or changed.', '**Ticket match (WID-1234):** partly matches.', '**Suggestions**\nNone.', NICE, 'Nothing here blocks'].map((h) => t.indexOf(h));
  assert.ok(at.every((i) => i >= 0), t);
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'sections come in that order');
  assert.match(t, /Missing from the PR:\n- empty state copy/);
  assert.match(t, /Extra in the PR:\n- a new index/);
  assert.ok(t.includes(`[Delivery rows join the sender](https://github.com/acme/widgets/blob/${HEAD}/src/mod/a%20b.ts#L10-L12) (\`src/mod/a b.ts#L10-L12\`)`), t);
  assert.match(t, /only mocked or checked by hand: the sender lookup is mocked/i);
  assert.deepEqual(plan.draft?.review?.context, CTX, 'the context is stored on the draft as fields');
  assert.equal(plan.draft?.review?.compliment, NICE);
});

test('no ticket and unreadable Jira are said plainly, with no verdict and no guess', () => {
  assert.match(renderTicket({ status: 'none' }), /could not find a Jira key .* did not check this against a ticket/);
  const u = renderTicket({ status: 'unreadable', key: 'WID-5', reason: 'no Jira access here: JIRA_API_TOKEN not set' });
  assert.match(u, /WID-5.*could not read it from Jira .*did not check the PR against it/);
  assert.doesNotMatch(u, /does what it says|partly|something else/);
  assert.match(renderSummary('acme/widgets', HEAD, { ...CTX, ticket: { status: 'none' } }, []), /Ticket match:\*\* I could not find/);
});

test('context is refused unless it is complete and on the diff', () => {
  assert.equal(contextProblem(CTX, DIFF), null);
  assert.match(contextProblem(undefined, DIFF) ?? '', /needs its context/);
  assert.match(contextProblem({ ...CTX, summary: 'Too short.' }, DIFF) ?? '', /what the PR does/);
  assert.match(contextProblem({ ...CTX, core: [] }, DIFF) ?? '', /1 to 5/);
  assert.match(contextProblem({ ...CTX, core: [{ path: 'src/b.ts', start: 5, end: 6, label: 'Name passed on' }] }, DIFF) ?? '', /not on lines the PR changes/);
  assert.match(contextProblem({ ...CTX, core: [{ path: 'tests/x.ts', start: 1, end: 1, label: 'Outside the diff' }] }, DIFF) ?? '', /path and a line range/);
  assert.match(contextProblem({ ...CTX, ticket: { status: 'read', key: 'WID-1' } }, DIFF) ?? '', /verdict is one of/);
  assert.match(contextProblem({ ...CTX, ticket: { status: 'none', verdict: 'partly' } }, DIFF) ?? '', /needs a ticket that was read/);
  assert.match(contextProblem({ ...CTX, ticket: { status: 'unreadable' } }, DIFF) ?? '', /still needs the key/);
  assert.match(contextProblem({ ...CTX, tests: undefined as never }, DIFF) ?? '', /tests part needs a status/);
  assert.match(contextProblem({ ...CTX, tests: { status: 'not-checked' } }, DIFF) ?? '', /need the reason/);
  assert.match(contextProblem({ ...CTX, tests: { status: 'reported', count: 2, ran: 'node --test' } }, DIFF) ?? '', /gaps/);
  assert.match(contextProblem({ ...CTX, tests: { status: 'reported', count: -1, ran: 'node --test', gaps: [] } }, DIFF) ?? '', /count/);
  assert.match(contextProblem({ ...CTX, core: [{ path: 'src/b.ts', start: 5, end: 5, label: 'x' }] }, DIFF) ?? '', /short label/);
  assert.match(contextProblem({ ...CTX, summary: '' }, DIFF) ?? '', /what the PR does/);
});

const ok = (json: unknown): Fetcher => async () => ({ ok: true, status: 200, json: async () => json });

test('readJira does one GET, returns summary and description, and never needs a body or a token in its result', async () => {
  const env = { JIRA_BASE_URL: 'https://acme.atlassian.net/', JIRA_EMAIL: 'x@example.com', JIRA_API_TOKEN: 'secret-token' };
  let seen = '';
  const r = await readJira('WID-1', env, async (u, i) => { seen = `${u} ${Object.keys(i.headers).join(',')}`; return { ok: true, status: 200, json: async () => ({ fields: { summary: 'Show sender', description: 'h2. Done\n* a', issuetype: { name: 'Story' }, status: { name: 'In Review' } } }) }; });
  assert.deepEqual(r, { status: 'read', key: 'WID-1', summary: 'Show sender', description: 'h2. Done\n* a', issueType: 'Story', ticketStatus: 'In Review' });
  assert.match(seen, /^https:\/\/acme\.atlassian\.net\/rest\/api\/2\/issue\/WID-1\?fields=/);
  assert.doesNotMatch(JSON.stringify(r), /secret-token/);
});

test('readJira says unreadable, with a value-free reason, for missing credentials, a refusal, a bad base or a thrown error', async () => {
  const none = await readJira('WID-1', {}, ok({}));
  assert.equal(none.status, 'unreadable');
  assert.match((none as { reason: string }).reason, /JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN not set/);
  const env = { JIRA_BASE_URL: 'https://acme.atlassian.net', JIRA_EMAIL: 'x@example.com', JIRA_API_TOKEN: 'secret-token' };
  assert.match(((await readJira('WID-1', env, async () => ({ ok: false, status: 401, json: async () => ({}) }))) as { reason: string }).reason, /HTTP 401/);
  assert.match(((await readJira('WID-1', { ...env, JIRA_BASE_URL: 'https://evil.example.com' }, ok({}))) as { reason: string }).reason, /atlassian\.net/);
  const thrown = await readJira('WID-1', env, async () => { throw new Error('boom secret-token'); });
  assert.doesNotMatch(JSON.stringify(thrown), /secret-token/);
  assert.equal((await readJira('../x', env, ok({}))).status, 'unreadable');
});

test('no part of the summary is ever silently left out: each is present, or says not checked or none', () => {
  const plan = planReview({ repo: 'acme/widgets', pr: 3, head: HEAD }, NICE, [{ category: 'other', text: 'Could we name this after what it holds? It reads as a count today.', path: 'src/b.ts', line: 5 }], new Map([['src/mod/a b.ts', new Set([10, 11, 12])], ['src/b.ts', new Set([5])]]), { ...CTX, tests: { status: 'not-checked', reason: 'the package has no test script and nothing was run' }, ticket: { status: 'unreadable', key: 'WID-9', reason: 'no Jira access here' } });
  const t = plan.draft?.text ?? '';
  for (const part of ['**What it does**', '**Core logic**', '**Tests:** not checked: the package has no test script', '**Ticket match (WID-9):** I found the ticket but could not read it', '**Suggestions**\n1. Non-blocking, `src/b.ts:5`: Could we name this']) assert.ok(t.includes(part), part);
  assert.ok(t.indexOf('**Suggestions**') < t.indexOf(NICE));
  const blocked = planReview({ repo: 'acme/widgets', pr: 3, head: HEAD }, NICE, [{ category: 'security', kind: 'secret', text: 'This looks like a key committed in the file; could we move it to the secret store?', path: 'src/b.ts', line: 5 }, { category: 'other', text: 'Could we name this after what it holds? It reads as a count today.', path: 'src/mod/a b.ts', line: 10 }], new Map([['src/mod/a b.ts', new Set([10, 11, 12])], ['src/b.ts', new Set([5])]]), CTX).draft?.text ?? '';
  assert.match(blocked, /\*\*Suggestions\*\*\n1\. Blocking, `src\/b\.ts:5`: This looks like a key[^\n]*\n2\. Non-blocking/);
});

test('summaryView builds the card from a stored context and tolerates an older shape, saying not recorded', async () => {
  const { summaryView } = await import('./context.ts');
  const v = summaryView('acme/widgets', HEAD, CTX);
  assert.equal(v.core[0]?.url, `https://github.com/acme/widgets/blob/${HEAD}/src/mod/a%20b.ts#L10-L12`);
  assert.match(v.tests, /^4 tests added or changed\. Ran: node --test/);
  assert.match(v.ticket, /^WID-1234: partly matches\./);
  const old = summaryView('acme/widgets', HEAD, { summary: 'An older draft kept this much.', ticket: { status: 'none' }, core: [{ path: 'x.ts', start: 1, end: 2, text: 'old label' } as never] });
  assert.equal(old.tests, 'Not recorded for this draft.');
  assert.equal(old.core[0]?.label, 'old label');
  assert.equal(summaryView('acme/widgets', HEAD, {}).summary, 'Not recorded for this draft.');
});
