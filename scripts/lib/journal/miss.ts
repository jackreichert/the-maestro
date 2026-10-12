/**
 * The `miss` ledger entry: a question the library could not answer. A `find` with no page, a how-do-I question put to a person, and an
 * eval partial each leave one, so the composer sees what was asked and not found, the same way it sees `learned` rows. Pure: the CLI
 * hands in the raw flags and the rows already on the ledger.
 *
 * A miss is closed by a `curated` row (library-write.ts): with the page that now answers it, or with a one-line reason it is out of scope.
 * The question text goes through the shared secret and PHI scanner before it is written, and `verify` runs the same rules on stored rows.
 */
import type { LedgerRow } from '../ledger-core.ts';
import { describeFindings, scanFields } from '../secret-scan.ts';

export const MISS_SOURCES = ['find', 'ask', 'eval'] as const;
export type MissSource = (typeof MISS_SOURCES)[number];
export const QUESTION_MAX = 200;
const CONTROL = /[\u0000-\u001f\u007f]/;
const TOPIC_WORDS = 4;
const STOP = new Set(['to', 'of', 'in', 'is', 'it', 'on', 'at', 'by', 'an', 'as', 'do', 'be', 'we', 'me', 'my', 'or', 'if', 'the', 'and', 'for', 'how', 'what', 'where', 'when', 'why', 'does', 'did', 'are', 'was', 'with', 'this', 'that', 'from', 'into', 'our', 'its', 'can', 'you', 'use', 'run', 'get', 'a', 'i']);

/** Every field a stored `miss` row may carry; `verify` reports any other, since nothing scanned it. */
export const MISS_ROW_FIELDS: ReadonlySet<string> = new Set(['id', 'ts', 'date', 'kind', 'text', 'source', 'topic', 'window', 'repo', 'stream', 'model', 'used', 'tokens', 'harness', 'agent']);

export interface MissFields { text: string; source: MissSource; topic: string }

/** The question's plain words, lowercased with stop words dropped, sorted and cut to four: two phrasings of one question share a key. Empty when no word is left. */
export function topicKey(question: string): string {
  const words = [...new Set((question.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? []).filter((w) => !STOP.has(w)))];
  return words.sort().slice(0, TOPIC_WORDS).join(' ');
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** The refusals for one question and source; empty when the row may be written. */
function refusals(text: unknown, source: unknown): string[] {
  const out: string[] = [];
  if (typeof text !== 'string' || !text.trim()) out.push('the question is required: what was asked and not found.');
  else {
    if (CONTROL.test(text.replace(/\s/g, ' '))) out.push('the question has a control character: plain text only.');
    if (text.trim().length > QUESTION_MAX) out.push(`the question is over ${QUESTION_MAX} characters: say it shorter.`);
    const findings = scanFields({ question: text });
    if (findings.length) out.push(`the question was refused by the scanner (${describeFindings(findings).join('; ')}); ask it without the value.`);
  }
  if (!(MISS_SOURCES as readonly unknown[]).includes(source)) out.push(`--source is required and must be one of: ${MISS_SOURCES.join(', ')}.`);
  return out;
}

export type MissParse = { fields: MissFields; errors?: undefined } | { fields?: undefined; errors: string[] };

/** What `miss` does with its flags: the fields to store when every rule passes, else the refusals. */
export function parseMiss(question: string, source: string | null): MissParse {
  const text = oneLine(question);
  const errors = refusals(text, source);
  return errors.length ? { errors } : { fields: { text, source: source as MissSource, topic: topicKey(text) } };
}

/** Where a new miss goes: it repeats one logged the same day (same repo and same question, ignoring case and spacing), or it is new. */
export function seenMiss(rows: readonly LedgerRow[], f: MissFields, repo: string | undefined, date: string): { kind: 'same'; id: string } | { kind: 'new' } {
  const key = f.text.toLowerCase();
  const same = rows.find((r) => r.kind === 'miss' && r.date === date && (r.repo ?? undefined) === repo && typeof r.text === 'string' && oneLine(r.text).toLowerCase() === key && typeof r.id === 'string');
  return same ? { kind: 'same', id: same.id as string } : { kind: 'new' };
}

/** The miss rows no `curated` row has closed yet, oldest first. */
export function pendingMisses(rows: readonly LedgerRow[]): LedgerRow[] {
  const closed = new Set(rows.filter((r) => r.kind === 'curated' && typeof r.closes === 'string').map((r) => r.closes as string));
  return rows.filter((r) => r.kind === 'miss' && typeof r.id === 'string' && !closed.has(r.id));
}

/** Open misses grouped by topic key, largest group first: one page answers a group. An empty topic groups under "(none)". */
export function missGroups(rows: readonly LedgerRow[]): { topic: string; ids: string[] }[] {
  const by = new Map<string, string[]>();
  for (const r of pendingMisses(rows)) {
    const k = typeof r.topic === 'string' && r.topic ? r.topic : '(none)';
    by.set(k, [...(by.get(k) ?? []), r.id as string]);
  }
  return [...by].map(([topic, ids]) => ({ topic, ids })).sort((a, b) => b.ids.length - a.ids.length || a.topic.localeCompare(b.topic));
}

/** Problems with one stored `miss` row, for `verify`: the write-time rules, plus any field `miss` never sets. Messages never echo the question. */
export function missProblems(row: LedgerRow): string[] {
  const extra = Object.keys(row).filter((k) => !MISS_ROW_FIELDS.has(k));
  return [...(extra.length ? [`${extra.length} field(s) the write path never sets`] : []), ...refusals(row.text, row.source)];
}
