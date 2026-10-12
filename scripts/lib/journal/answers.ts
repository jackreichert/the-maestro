/**
 * Answers and discuss marks: what a person said about an open ask, kept in the ledger so no page regeneration or ended
 * session can lose it. Two non-item rows, each pointing at its ask with `of`:
 *   `answer`   the person's reply (`text`), from the page or from chat (`source`)
 *   `discuss`  "let's talk this through first" (`text` is the topic, possibly empty)
 * Neither closes the ask: `resolve` still does that, once somebody has acted. Recording is idempotent, so a watcher that
 * crashes and re-reads the same edit writes nothing twice.
 */
import { fold, isOpen } from '../ledger-core.ts';
import type { LedgerRow } from '../ledger-core.ts';

export type AnswerKind = 'answer' | 'discuss';
export type RecordOutcome = 'written' | 'same' | 'no-ask';

export interface AnswerStore {
  readLedger(): LedgerRow[];
  append<E>(entry: E): E;
  newId(existing: { id?: string }[]): string;
}

export interface RecordOptions {
  kind: AnswerKind;
  /** Ask id, or a unique prefix of one. */
  ask: string;
  text: string;
  /** Where it came from: `page` (the status page), `chat`. */
  source: string;
  usage: object;
  now: () => string;
  today: () => string;
}

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** The open ask whose id is `needle` (exactly, else as the only prefix match), or null. */
export function openAsk(entries: LedgerRow[], needle: string): LedgerRow | null {
  const asks = fold(entries, null).items.filter((i) => isOpen(i) && (i.kind === 'question' || i.kind === 'decision'));
  const exact = asks.find((i) => i.id === needle);
  if (exact) return exact;
  const hits = asks.filter((i) => needle && (i.id ?? '').startsWith(needle));
  return hits.length === 1 ? (hits[0] as LedgerRow) : null;
}

/** The latest row of `kind` about `ask`, or undefined. */
export const latestRow = (entries: LedgerRow[], kind: AnswerKind, ask: string): LedgerRow | undefined =>
  [...entries].reverse().find((e) => e.kind === kind && e.of === ask);

/** Appends the row unless the ask is gone (`no-ask`) or its latest row of this kind already says the same thing (`same`). */
export function recordAnswer(store: AnswerStore, o: RecordOptions): RecordOutcome {
  const entries = store.readLedger();
  const target = openAsk(entries, o.ask);
  if (!target?.id) return 'no-ask';
  const text = squash(o.text);
  if (latestRow(entries, o.kind, target.id)?.text === text) return 'same';
  store.append({ id: store.newId(entries), ts: o.now(), date: o.today(), kind: o.kind, of: target.id, source: o.source, text, ...(target.stream ? { stream: target.stream } : {}), ...o.usage });
  return 'written';
}
