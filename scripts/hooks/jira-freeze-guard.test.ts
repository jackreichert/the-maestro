import assert from 'node:assert/strict';
import { test } from 'node:test';
import { run } from './jira-freeze-guard.ts';
import { decide, targets } from '../lib/jira-freeze.ts';

const FROZEN = ['pilot-hold'];
const labels = (map: Record<string, string[] | undefined>) => (k: string) => map[k];
const call = (tool: string, tool_input: unknown) => JSON.stringify({ tool_name: tool, tool_input });
const T = 'mcp__claude_ai_Atlassian__';

test('a comment on a frozen ticket is refused, case-insensitively, with a clear message', () => {
  const out = JSON.parse(run(call(`${T}addCommentToJiraIssue`, { issueIdOrKey: 'AB-1', commentBody: 'x' }), FROZEN, labels({ 'AB-1': ['Pilot-Hold'] })));
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /AB-1 carries the frozen label "Pilot-Hold"/);
});

test('edit, transition, link and worklog are refused too; an unknown write tool counts as a write', () => {
  const l = labels({ 'AB-1': ['pilot-hold'], 'AB-2': [] });
  for (const t of ['editJiraIssue', 'transitionJiraIssue', 'addWorklogToJiraIssue', 'someNewWriteTool']) {
    assert.equal(decide(`${T}${t}`, { issueIdOrKey: 'AB-1' }, FROZEN, l).deny, true, t);
  }
  assert.equal(decide(`${T}createIssueLink`, { inwardIssue: { key: 'AB-2' }, outwardIssue: { key: 'AB-1' } }, FROZEN, l).deny, true);
});

test('a read of the same ticket passes, and the lookup is never called', () => {
  const never = () => { throw new Error('lookup called'); };
  assert.equal(run(call(`${T}getJiraIssue`, { issueIdOrKey: 'AB-1' }), FROZEN, never), '');
  assert.equal(run(call(`${T}searchJiraIssuesUsingJql`, { jql: 'labels = x' }), FROZEN, never), '');
});

test('a write on an unfrozen ticket passes', () => {
  assert.equal(run(call(`${T}editJiraIssue`, { issueIdOrKey: 'AB-2', fields: { summary: 's' } }), FROZEN, labels({ 'AB-2': ['other'] })), '');
});

test('fails closed: unreadable labels refuse the write', () => {
  const out = JSON.parse(run(call(`${T}transitionJiraIssue`, { issueIdOrKey: 'AB-3' }), FROZEN, labels({})));
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /labels could not be read/);
});

test('setting the frozen label on a ticket is refused without a lookup', () => {
  const d = decide(`${T}editJiraIssue`, { issueIdOrKey: 'AB-4', fields: { labels: ['pilot-hold'] } }, FROZEN, () => { throw new Error('no'); });
  assert.equal(d.deny, true);
});

test('no frozen labels configured: the guard does nothing; non-Atlassian tools are ignored', () => {
  assert.equal(run(call(`${T}editJiraIssue`, { issueIdOrKey: 'AB-1' }), [], labels({})), '');
  assert.equal(run(call('Bash', { command: 'ls' }), FROZEN, labels({})), '');
});

test('a crash inside the guard refuses', () => {
  const boom = () => { throw new Error('boom'); };
  assert.equal(JSON.parse(run(call(`${T}editJiraIssue`, { issueIdOrKey: 'AB-1' }), FROZEN, boom)).hookSpecificOutput.permissionDecision, 'deny');
});

test('targets finds keys and numeric ids under issue fields, not stray numbers', () => {
  assert.deepEqual(targets({ issueIdOrKey: '10001', cloudId: '123', parent: { key: 'AB-9' } }).issues.sort(), ['10001', 'AB-9']);
});
