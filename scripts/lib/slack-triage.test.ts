// Run: node --test scripts/lib/slack-triage.test.ts
// Pure over text: no Slack, no vault, no files. Names are fictional.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addressed, countVerdicts, decide, parseMessages, parseRules, ruleProblem, tagOf, triageText } from './slack-triage.ts';
import type { SlackMessage } from './slack-triage.ts';

const RULES = {
  me: ['Arthur Dent', 'Arthur'],
  channels: { eng: { group: 'engineering', playbook: 'engineering.md' }, client: { group: 'client', playbook: 'sub/client.md' } },
  rules: [
    { name: 'reminder-bot', reason: 'standup reminder', verdict: 'drop', authors: ['Marvin'] },
    { name: 'ack-only', reason: 'a bare acknowledgement', verdict: 'drop', match: '^(ty|thanks)!*$', flags: 'i' },
    { name: 'my-commitment', reason: 'the user promised a follow-up', verdict: 'model', label: 'commitment', route: 'ledger', self: true, match: "\\bI'll\\b" },
    { name: 'pr-post', reason: 'a teammate PR post', verdict: 'drop', route: 'review-batch', channels: ['eng'], match: 'github\\.com/\\S+/pull/\\d+' },
    { name: 'client-file', reason: 'a file shared in a client channel', verdict: 'surface', label: 'fyi', channels: ['client'], match: '\\[file\\]' },
    { name: 'thread-reply', reason: 'replies in eng go to the model', verdict: 'model', channels: ['eng'], reply: true },
  ],
};
const rules = parseRules(JSON.stringify(RULES), '/overlay/slack');
const msg = (author: string, text: string, extra: Partial<SlackMessage> = {}): SlackMessage => ({ line: 3, date: '2026-10-15', time: '17:46', reply: false, author, text, ...extra });

test('parseMessages reads posts and replies with their file line, and skips headers', () => {
  const text = '# Slack new messages: eng\n\nNote: x\n- 2026-10-15 17:46 ET **Ford Prefect**: hello ⏎ there\n- 2026-10-15 17:47 ET ↳ **Trillian**: reply\nnot a message';
  assert.deepEqual(parseMessages(text), [
    { line: 4, date: '2026-10-15', time: '17:46', reply: false, author: 'Ford Prefect', text: 'hello ⏎ there' },
    { line: 5, date: '2026-10-15', time: '17:47', reply: true, author: 'Trillian', text: 'reply' },
  ]);
});

test('parseMessages splits a quoted parent off a reply and keeps only the reply text', () => {
  const text = '- 2026-10-19 12:41 ET ↳ **Trillian** (re 2026-10-19 12:39 ET **Arthur Dent**: "can we ship the (big) one..."): yes, ship it';
  assert.deepEqual(parseMessages(text), [{ line: 1, date: '2026-10-19', time: '12:41', reply: true, author: 'Trillian', text: 'yes, ship it', parent: 'Arthur Dent' }]);
});

test('a reply to the user\'s post is never dropped unread, and the quote alone does not count as a mention', () => {
  const toMe = parseMessages('- 2026-10-19 12:41 ET ↳ **Trillian** (re 2026-10-19 12:39 ET **Arthur Dent**: "status?"): thanks')[0]!;
  const d = decide(toMe, 'eng', rules);
  assert.deepEqual([d.verdict, d.rule], ['model', 'ack-only+addressed']);
  const quoted = parseMessages('- 2026-10-19 12:41 ET ↳ **Trillian** (re 2026-10-19 12:39 ET **Ford**: "@Arthur look"): thanks')[0]!;
  assert.equal(decide(quoted, 'eng', rules).verdict, 'drop');
});

test('tagOf prefers the header, then the file name before .new-', () => {
  assert.equal(tagOf('# Slack new messages: client\n', '/x/other.new-20261015T000000Z.md'), 'client');
  assert.equal(tagOf('', '/x/eng.new-20261015T000000Z.md'), 'eng');
  assert.equal(tagOf('', '/x/eng.md'), 'eng');
});

test('the first matching rule decides, and each condition narrows it', () => {
  assert.equal(decide(msg('Marvin', 'Reminder: standup'), 'eng', rules).rule, 'reminder-bot');
  assert.equal(decide(msg('Ford Prefect', 'Thanks!'), 'eng', rules).verdict, 'drop');
  const pr = decide(msg('Ford Prefect', 'small fix github.com/acme/widget/pull/12'), 'eng', rules);
  assert.deepEqual([pr.verdict, pr.rule, pr.route], ['drop', 'pr-post', 'review-batch']);
  assert.equal(decide(msg('Ford Prefect', 'github.com/acme/widget/pull/12'), 'client', rules).rule, 'no-rule', 'channels limits the rule');
  assert.equal(decide(msg('Ford Prefect', 'why?', { reply: true }), 'eng', rules).rule, 'thread-reply');
  assert.equal(decide(msg('Ford Prefect', 'why?'), 'eng', rules).rule, 'no-rule', 'reply: true skips a top-level post');
});

test('the user\'s own post drops by default, and only self rules read it', () => {
  const own = decide(msg('Arthur Dent', 'github.com/acme/widget/pull/12'), 'eng', rules);
  assert.deepEqual([own.verdict, own.rule], ['drop', 'own-post'], 'a rule without self does not read own posts');
  const promise = decide(msg('arthur dent', "I'll post when the data lands"), 'client', rules);
  assert.deepEqual([promise.verdict, promise.label, promise.route, promise.rule], ['model', 'commitment', 'ledger', 'my-commitment']);
  assert.equal(decide(msg('Ford Prefect', "I'll post when the data lands"), 'client', rules).rule, 'no-rule', 'self rules skip everyone else');
});

test('an @-mention is never dropped: a drop rule is lifted to surface with an ask label', () => {
  const d = decide(msg('Ford Prefect', '@Arthur Dent can you review github.com/acme/widget/pull/12'), 'eng', rules);
  assert.deepEqual([d.verdict, d.label, d.rule], ['surface', 'ask', 'pr-post+mention']);
  const labelled = decide(msg('Ford Prefect', '@Arthur see [file]'), 'client', rules);
  assert.deepEqual([labelled.verdict, labelled.label], ['surface', 'fyi'], 'a rule label is kept');
  assert.equal(decide(msg('Arthur Dent', '@Arthur Dent note to self'), 'eng', rules).verdict, 'drop', 'the user mentioning themself is still their own post');
});

test('the bare name or a broadcast lifts a drop to model, never further', () => {
  const pr = decide(msg('Ford Prefect', 'Arthur, github.com/acme/widget/pull/12'), 'eng', rules);
  assert.deepEqual([pr.verdict, pr.rule], ['model', 'pr-post+addressed']);
  const here = decide(msg('Ford Prefect', '@here migrations ran github.com/acme/widget/pull/9'), 'eng', rules);
  assert.equal(here.verdict, 'model');
});

test('addressed matches whole names only', () => {
  assert.equal(addressed('@Arthur Dent hi', RULES.me), 'mention');
  assert.equal(addressed("Arthur's plan", RULES.me), 'name');
  assert.equal(addressed('@Arthurian legends', RULES.me), null);
  assert.equal(addressed('King Arthurs', RULES.me), null);
  assert.equal(addressed('anything', []), null);
});

test('a conversation with no playbook escalates instead of going to the cheap model', () => {
  const d = decide(msg('Ford Prefect', 'something new'), 'stray', rules);
  assert.deepEqual([d.verdict, d.rule, d.group, d.playbook], ['escalate', 'no-rule+no-playbook', '', '']);
  assert.equal(decide(msg('Ford Prefect', 'ty'), 'stray', rules).verdict, 'drop', 'a drop needs no playbook');
});

test('decisions carry the resolved playbook and never the message text', () => {
  const sentinel = 'SENTINEL-do-not-copy';
  const text = `# Slack new messages: client\n- 2026-10-15 09:00 ET **Trillian**: ${sentinel} [file]\n- 2026-10-15 09:01 ET **Zaphod**: ${sentinel}`;
  const ds = triageText(text, '/vault/client.new-x.md', rules);
  assert.equal(ds.length, 2);
  assert.equal(ds[0]!.playbook, '/overlay/slack/sub/client.md');
  assert.deepEqual([ds[0]!.line, ds[0]!.at, ds[0]!.author, ds[0]!.verdict], [2, '2026-10-15 09:00 ET', 'Trillian', 'surface']);
  assert.ok(!JSON.stringify(ds).includes(sentinel));
  assert.deepEqual(countVerdicts(ds), { drop: 0, model: 1, surface: 1, escalate: 0 });
});

test('ruleProblem rejects malformed rules, one named problem each', () => {
  const ok = { name: 'a', reason: 'r', verdict: 'drop', match: 'x' };
  assert.equal(ruleProblem(ok), null);
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ ...ok, name: 'Bad Name' }, /name/],
    [{ ...ok, extra: 1 }, /unknown key/],
    [{ ...ok, reason: '' }, /reason/],
    [{ ...ok, verdict: 'ignore' }, /verdict/],
    [{ ...ok, label: 'urgent' }, /label/],
    [{ ...ok, match: '(' }, /regular expression/],
    [{ ...ok, flags: 'g' }, /flags/],
    [{ name: 'a', reason: 'r', verdict: 'drop' }, /at least one condition/],
    [{ ...ok, channels: [] }, /channels/],
  ];
  for (const [rule, want] of cases) assert.match(String(ruleProblem(rule)), want, JSON.stringify(rule));
});

test('parseRules names every problem at once and loads nothing', () => {
  const bad = { me: [], channels: { eng: { group: 'engineering', playbook: 'x.txt' } }, rules: [{ name: 'a', reason: 'r', verdict: 'drop', match: 'x' }, { name: 'a', reason: 'r', verdict: 'drop', match: 'y' }] };
  assert.throws(() => parseRules(JSON.stringify(bad), '/'), (err: Error) => /`me`/.test(err.message) && /channel eng/.test(err.message) && /repeats a name/.test(err.message));
  assert.throws(() => parseRules('{not json', '/'), /not JSON/);
});
