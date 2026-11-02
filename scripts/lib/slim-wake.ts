/**
 * The slim-mode wake table: which pr-watch lines wake the main session and which only land in the digest and the Podium's data (info line, logged as noise
 * so the hourly sweep lists it). One table, first match wins, and a line no row matches wakes: an unknown kind fails loud, never silent.
 * Applied only in slim mode (`mode: slim`); full mode never reads it. Only pr-watch lines are in scope: every other watch type (status-watch answers,
 * the budget hard line, the standup reminder, loop health) keeps its own behaviour and still wakes.
 * A podium-only line is not lost: pr-watch marks the Podium's PR data dirty on any line it emits (event-types/pr-watch.ts), and the demoted line stays in the digest and inbox as info.
 */
import type { PrState } from './quiet-wakes.ts';

export type SlimAction = 'wake' | 'podium';

/** What a row is shown: the line without its self-review tag, its inbox kind and author class, and the PR state the quiet-wake rule read from gh (only LEFT-OPEN-SET lines have one). */
export interface SlimLine { line: string; kind: string; who: 'bot' | 'human' | undefined; prState: PrState | undefined }

export interface SlimRow { name: string; action: SlimAction; reason: string; applies: (l: SlimLine) => boolean }

const kindIs = (...kinds: string[]) => (l: SlimLine): boolean => kinds.includes(l.kind);
/** The inbox kinds that are a person or bot writing on a PR. */
const ACTIVITY_KINDS = ['thread', 'reply', 'comment', 'review'];
const byBot = (...kinds: string[]) => (l: SlimLine): boolean => kinds.includes(l.kind) && l.who === 'bot';

/** Wake rows come first so a demotion row can never shadow them (a `DECISION ... -> CHANGES_REQUESTED` line is kind `changes-requested`, not `decision`). */
export const SLIM_WAKE_TABLE: SlimRow[] = [
  { name: 'red-checks', action: 'wake', reason: 'a check failed', applies: (l) => /^(CHECKS-FAILING|CI failing)\b/.test(l.line) },
  { name: 'changes-requested', action: 'wake', reason: 'a review requested changes', applies: kindIs('changes-requested') },
  { name: 'human-activity', action: 'wake', reason: 'a person wrote on a PR', applies: (l) => ACTIVITY_KINDS.includes(l.kind) && l.who !== 'bot' },
  { name: 'ready', action: 'podium', reason: 'a draft was promoted; Jack or the thread did it, so there is nothing to do', applies: kindIs('ready') },
  { name: 'approved', action: 'podium', reason: 'an approval is on the Podium; Jack knows his own merge plan', applies: kindIs('approved', 'approved-unmerged') },
  { name: 'decision', action: 'podium', reason: 'a review decision flip with nothing to fix', applies: kindIs('decision') },
  { name: 'bot-activity', action: 'podium', reason: 'a bot or Copilot line; batched on the Podium', applies: byBot(...ACTIVITY_KINDS) },
  { name: 'copilot', action: 'podium', reason: 'Copilot review state; the threads are on the Podium', applies: (l) => /^COPILOT-(REVIEW|LATE)\b/.test(l.line) },
  { name: 'review-wait', action: 'podium', reason: 'a teammate PR is waiting for review; an ask, not a wake', applies: kindIs('review-wait') },
  { name: 'left-open-set-closed', action: 'podium', reason: 'a PR closed without merging', applies: (l) => l.kind === 'left-open-set' && l.prState === 'CLOSED' },
];

/** The row that decides this line, or undefined (a line nothing matches wakes). */
export const slimDecision = (l: SlimLine): SlimRow | undefined => SLIM_WAKE_TABLE.find((r) => r.applies(l));
