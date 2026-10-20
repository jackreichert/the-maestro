// Run: node --test scripts/lib/journal/sweep-pileup-ask.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEPT_PILEUP, PILEUP_ASK_PREFIX, pileupAskTemplate, pileupAskText } from './sweep-pileup-ask.ts';
import { validateAskTemplate } from './ask-template.ts';

const counts = [{ label: 'untracked files', count: 20 }, { label: 'uncommitted changes', count: 6 }];

test('a pile over the threshold raises one question with the counts by reason; at or under it raises none', () => {
  assert.equal(pileupAskText(KEPT_PILEUP, counts, []), null);
  const text = pileupAskText(KEPT_PILEUP + 1, counts, []);
  assert.match(text ?? '', /^Worktrees are piling up: .* kept 26 worktrees \(20 untracked files, 6 uncommitted changes\)/);
});

test('an open question with the prefix suppresses a second one, whatever the count', () => {
  assert.equal(pileupAskText(60, counts, ['other', `${PILEUP_ASK_PREFIX}: old`]), null);
});

test('the template passes the shared ask validator', () => {
  assert.deepEqual(validateAskTemplate(pileupAskTemplate(30, counts, 'Triage the list.')).errors, []);
});
