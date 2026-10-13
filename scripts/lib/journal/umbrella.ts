import { isOpen } from '../ledger-core.ts';
import type { LedgerItem } from '../ledger-core.ts';

/**
 * An umbrella is a row that stands for a body of work, not one piece of it: an epic, a plan, a tracking row. Started as in-flight
 * work it can never be finished by one agent, so it goes stale holding a lease. `start` refuses one unless `--force` says it is
 * meant. The signal is the text (the words epic or umbrella) or, for an existing row, an open child that names it as `parent`.
 */
const UMBRELLA_WORDS = /\b(epic|umbrella)\b/i;

/** Why `start` should refuse this text or row, or null. `items` is the fold, so an existing row's open children are visible. */
export function umbrellaRefusal(subject: { id?: string; text?: unknown }, items: LedgerItem[]): string | null {
    const text = String(subject.text ?? '');
    const word = UMBRELLA_WORDS.exec(text)?.[1]?.toLowerCase();
    if (word) return `"${text.slice(0, 60)}" reads as an ${word}, a body of work and not one piece. Start a child item for the piece you are doing (--parent), or pass --force if this really is the unit of work.`;
    const kids = subject.id ? items.filter((i) => i.parent === subject.id && isOpen(i)) : [];
    if (kids.length) return `${subject.id} is the parent of ${kids.length} open item(s), so it is an umbrella. Start one of them (${kids.slice(0, 3).map((k) => k.id).join(', ')}), or pass --force.`;
    return null;
}
