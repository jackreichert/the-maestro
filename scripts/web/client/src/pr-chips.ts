/** PR status as text plus a symbol, so it never rests on colour alone. Pure and DOM-free. */
import type { PrCard } from './types.ts';

export interface Chip { text: string; tone: 'good' | 'bad' | 'warn' | '' }

export function prChips(pr: Pick<PrCard, 'ci' | 'isDraft' | 'mergeable' | 'unresolved'>): Chip[] {
  const ci = pr.ci.toUpperCase();
  const chips: Chip[] = [
    ci === 'SUCCESS' ? { text: '✓ CI passing', tone: 'good' }
      : ci === 'FAILURE' || ci === 'ERROR' ? { text: '✗ CI failing', tone: 'bad' }
        : { text: `• CI ${ci === 'NONE' ? 'none' : 'pending'}`, tone: 'warn' },
  ];
  if (pr.isDraft) chips.push({ text: 'Draft', tone: '' });
  if (pr.mergeable === 'CONFLICTING') chips.push({ text: '✗ Conflicting', tone: 'bad' });
  if (pr.unresolved > 0) chips.push({ text: `${pr.unresolved} open ${pr.unresolved === 1 ? 'thread' : 'threads'}`, tone: 'warn' });
  return chips;
}
