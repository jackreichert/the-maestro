/**
 * The question the roll raises when its worktree sweep keeps a pile of worktrees: more than KEPT_PILEUP, so the sweep is no longer keeping the odd
 * one for a reason and the tree is filling up. A sweep that keeps everything prints counts, but a roll's output is easy to miss; the question puts
 * the pile on the Podium with the counts by reason. Counts only: never a path or a file's name.
 * A question is raised once: while an open question with this prefix exists, the next roll writes nothing, whatever the count has become.
 */
import { SYSTEM_LINK } from './ask-template.ts';
import type { AskTemplateInput } from './ask-template.ts';

/** More kept worktrees than this raises the question. */
export const KEPT_PILEUP = 25;
export const PILEUP_ASK_PREFIX = 'Worktrees are piling up';

/** One reason and how many worktrees the sweep kept for it (what `keptCounts` returns). */
export interface KeptCount { label: string; count: number }

const breakdown = (counts: KeptCount[]): string => counts.map((c) => `${c.count} ${c.label}`).join(', ');

/** The question text for a pile, or null when the sweep kept no more than KEPT_PILEUP or an open question already covers it. */
export function pileupAskText(kept: number, counts: KeptCount[], openTexts: Iterable<string>): string | null {
  if (kept <= KEPT_PILEUP) return null;
  for (const t of openTexts) if (t.startsWith(PILEUP_ASK_PREFIX)) return null;
  return `${PILEUP_ASK_PREFIX}: the roll's worktree sweep kept ${kept} worktrees (${breakdown(counts)}). \`branch-sweep.ts --apply-worktrees --dry-run --verbose\` lists each with its reason.`;
}

/** The fixed template of this system-generated ask, checked by the same validator as a person's ask before it is written. */
export function pileupAskTemplate(kept: number, counts: KeptCount[], recommend: string): AskTemplateInput {
  return {
    question: `Clear out the ${kept} worktrees the roll keeps?`,
    blocked: `Nothing is blocked, but ${kept} kept worktrees hold disk and branches, and the roll keeps them until each reason below is dealt with.`,
    context: [`Kept by reason: ${breakdown(counts)}.`, 'Squash-merged branches and untracked build noise are already removed by the sweep; what is left is real work, or unverifiable.'],
    options: ['Triage the kept list now (push or discard each, then the next roll removes them) -- takes a pass over the list', 'Leave them -- disk and branches keep growing and the roll asks again once this question is closed'],
    recommend,
    links: [SYSTEM_LINK],
  };
}
