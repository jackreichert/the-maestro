// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/lib/teammate/others-slack.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanNote, scanSlack } from './others-slack.ts';

const OWNERS = ['acme-fake'];
const PR = 'https://github.com/acme-fake/widgets/pull/7';
const note = (...lines: string[]): string => `# engineering\n\n${lines.join('\n')}\n`;

test('a PR link with review wording is an ask; only the key, channel, author and time are kept', () => {
  const s = scanNote(note(`- 2026-10-13 09:00 ET **Frodo Fake**: can someone take a look at ${PR}? it blocks the demo`), 'engineering', { owners: OWNERS });
  assert.equal(s.asks.length, 1);
  assert.deepEqual(Object.keys(s.asks[0] ?? {}).sort(), ['at', 'author', 'channel', 'key']);
  assert.equal(s.asks[0]?.key, 'acme-fake/widgets#7');
  assert.equal(s.asks[0]?.channel, 'engineering');
  assert.equal(s.asks[0]?.author, 'Frodo Fake');
  assert.equal(s.asks[0]?.at, Date.parse('2026-10-13T13:00:00Z'));
  assert.ok(!JSON.stringify(s).includes('demo'), 'no message text is kept');
});

test('a PR link with no review wording is not an ask', () => {
  assert.deepEqual(scanNote(note(`- 2026-10-13 09:00 ET **Frodo Fake**: deployed ${PR} to staging`), 'e', { owners: OWNERS }).asks, []);
});

test('review wording with no PR link is not an ask', () => {
  assert.deepEqual(scanNote(note('- 2026-10-13 09:00 ET **Frodo Fake**: please review my change'), 'e', { owners: OWNERS }).asks, []);
});

test('a message that says the review is done, or the PR merged, is not an ask', () => {
  const s = scanNote(note(`- 2026-10-13 09:00 ET **A**: thanks for the review ${PR}`, `- 2026-10-13 09:05 ET **B**: ${PR} merged, no review needed`), 'e', { owners: OWNERS });
  assert.deepEqual(s.asks, []);
});

test('a link to an owner outside the review owners is ignored, and several links in one ask are all asks', () => {
  const s = scanNote(note(`- 2026-10-13 09:00 ET **A**: PTAL https://github.com/other-fake/x/pull/1 and ${PR} and https://github.com/acme-fake/widgets/pull/8`), 'e', { owners: OWNERS });
  assert.deepEqual(s.asks.map((a) => a.key).sort(), ['acme-fake/widgets#7', 'acme-fake/widgets#8']);
});

test('a link is case-folded into the list key and the newest ask of a PR wins', () => {
  const s = scanNote(note(`- 2026-10-13 09:00 ET **A**: PTAL https://github.com/ACME-fake/Widgets/pull/7`, `- 2026-10-14 09:00 ET **A**: bump, PTAL ${PR}`), 'e', { owners: OWNERS });
  assert.equal(s.asks.length, 1);
  assert.equal(s.asks[0]?.at, Date.parse('2026-10-14T13:00:00Z'));
});

test('a reply by someone else that takes it on is a claim on the thread\'s PRs', () => {
  const s = scanNote(note(`- 2026-10-13 09:00 ET **Frodo**: PTAL ${PR}`, '- 2026-10-13 09:10 ET ↳ **Samwise**: I\'ll take it'), 'e', { owners: OWNERS, selfNames: ['pip fake'] });
  assert.deepEqual(s.claims, [{ key: 'acme-fake/widgets#7', at: Date.parse('2026-10-13T13:10:00Z') }]);
});

test('with no self names no claim is read, so your own "I\'ll take it" cannot drop a PR', () => {
  const t = note(`- 2026-10-13 09:00 ET **Frodo**: PTAL ${PR}`, '- 2026-10-13 09:10 ET ↳ **Pip Fake**: I\'ll take it');
  assert.deepEqual(scanNote(t, 'e', { owners: OWNERS }).claims, []);
  assert.equal(scanNote(t, 'e', { owners: OWNERS }).asks.length, 1);
});

test('the poster replying "on it", or you replying, is not a claim; a claim outside a thread with an ask is not either', () => {
  const t = note(`- 2026-10-13 09:00 ET **Frodo**: PTAL ${PR}`, '- 2026-10-13 09:10 ET ↳ **Frodo**: on it, rebasing', '- 2026-10-13 09:11 ET ↳ **Pip Fake**: I\'ll take it');
  assert.deepEqual(scanNote(t, 'e', { owners: OWNERS, selfNames: ['pip fake'] }).claims, []);
  assert.deepEqual(scanNote(note('- 2026-10-13 09:00 ET **Frodo**: lunch?', '- 2026-10-13 09:10 ET ↳ **Samwise**: I\'ll take it'), 'e', { owners: OWNERS }).claims, []);
});

test('a reply in one thread does not claim another thread\'s PR', () => {
  const t = note(`- 2026-10-13 09:00 ET **A**: PTAL ${PR}`, '- 2026-10-13 09:30 ET **B**: standup notes up', '- 2026-10-13 09:31 ET ↳ **C**: got it');
  assert.deepEqual(scanNote(t, 'e', { owners: OWNERS }).claims, []);
});

test('scanSlack reads engineering notes only, names the channel by the note, and tolerates a missing folder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slack-notes-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'engineering-reviews.md'), note(`- 2026-10-13 09:00 ET **A**: PTAL ${PR}`));
  writeFileSync(join(dir, 'random.md'), note(`- 2026-10-13 09:00 ET **A**: PTAL https://github.com/acme-fake/widgets/pull/9`));
  const s = scanSlack(dir, { owners: OWNERS });
  assert.deepEqual(s.asks.map((a) => [a.key, a.channel]), [['acme-fake/widgets#7', 'engineering-reviews']]);
  assert.deepEqual(scanSlack(join(dir, 'nope'), { owners: OWNERS }), { asks: [], claims: [] });
  assert.deepEqual(scanSlack(undefined, { owners: OWNERS }), { asks: [], claims: [] });
});
