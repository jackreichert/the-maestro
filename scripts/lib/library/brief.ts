/** The "Library pages for this task" block of a dispatch brief. Pure; library-brief.ts finds the pages and prints it. */
import { join } from 'node:path';
import type { FoundPage } from './find.ts';
import { safeLine } from './safe-text.ts';

export const BRIEF_PAGES = 3;
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Up to three pages as absolute paths with their read-when lines and a freshness note, so the agent opens them before it re-derives anything. With no page, a line saying so and how to search again. */
export function briefBlock(hits: FoundPage[], vault: string, words: string): string {
  const head = 'Library pages for this task (read the ones that apply before re-deriving anything; `journal.ts find "<words>"` searches for more):';
  if (!hits.length) return `${head}\n- none found for "${clip(words, 80)}"; if you establish something a later agent would re-derive, end your report with a Learned: line`;
  return [head, ...hits.slice(0, BRIEF_PAGES).map((h) => {
    const note = h.stale ? ' [STALE: check the evidence before trusting it]' : h.verifiedAt ? ` [verified ${safeLine(h.verifiedAt, 40)}]` : '';
    return `- ${join(vault, h.path)}: ${safeLine(h.readWhen || h.title, 140)}${note}`;
  })].join('\n');
}
