/**
 * The `agent-retro` ledger entry: what an agent learned on one item, written before the item is closed. Pure: the CLI hands in the raw
 * flags and the rows already on the ledger.
 *
 * A retro carries lessons, each tagged with where it came from (`code`, `jack`, `process`), and may link `learned` rows the agent wrote
 * for facts with evidence. Or it says, with a reason, that there was nothing to learn. A `retro-reviewed` row closes it: the review
 * (playbooks/retro-review.md) promotes what lasts into learned rows, working rules or tickets and records what it did.
 *
 * Every lesson goes through the shared secret and PHI scanner before it is written, and `verify` runs the same rules on stored rows.
 * `done` on a briefed item refuses without a retro (`retroGate`), so the retro is written while the agent still remembers.
 */
import type { LedgerItem, LedgerRow } from '../ledger-core.ts';
import { describeFindings, scanFields } from '../secret-scan.ts';

export const RETRO_SOURCES = ['code', 'jack', 'process'] as const;
export type RetroSource = (typeof RETRO_SOURCES)[number];
export const LESSON_MAX = 300;
export const LESSONS_MAX = 10;
const CONTROL = /[\u0000-\u001f\u007f]/;
const ROW_ID = /^[a-z0-9]{4}$/;

/** Every field a stored `agent-retro` row may carry; `verify` reports any other, since nothing scanned it. */
export const AGENT_RETRO_ROW_FIELDS: ReadonlySet<string> = new Set(['id', 'ts', 'date', 'kind', 'text', 'retros', 'lessons', 'learnedIds', 'nothing', 'window', 'repo', 'stream', 'model', 'used', 'tokens', 'harness', 'agent']);
/** Every field a stored `retro-reviewed` row may carry. */
export const RETRO_REVIEWED_ROW_FIELDS: ReadonlySet<string> = new Set(['id', 'ts', 'date', 'kind', 'text', 'reviews', 'promoted', 'window', 'model', 'used', 'tokens', 'harness', 'agent']);

export interface Lesson { source: RetroSource; text: string }
export interface AgentRetroFields { retros: string; lessons: Lesson[]; learnedIds?: string[]; nothing?: string; text: string }

/** What `agent-retro` was given on the command line. `lessons` are the raw `--lesson "<source>: <text>"` values, in order. */
export interface RawAgentRetro { item: string | null; lessons: string[]; learned: string[]; nothing: string | null }

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Splits `<source>: <text>`; null when the prefix is not a known source. */
export function parseLesson(raw: string): Lesson | null {
  const m = /^\s*([a-z]+)\s*:\s*([\s\S]*)$/.exec(raw);
  if (!m || !(RETRO_SOURCES as readonly string[]).includes(m[1] ?? '')) return null;
  return { source: m[1] as RetroSource, text: m[2] ?? '' };
}

/** The refusals for one free-text field: required, one line, short, and clean by the scanner. No message echoes the value. */
function textRefusals(label: string, value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) return [`${label} is empty.`];
  const out: string[] = [];
  if (CONTROL.test(value)) out.push(`${label} has a control character or a line break: one plain line only.`);
  if (value.trim().length > LESSON_MAX) out.push(`${label} is over ${LESSON_MAX} characters: say it shorter.`);
  const findings = scanFields({ [label]: value });
  if (findings.length) out.push(`${label} was refused by the scanner (${describeFindings(findings).join('; ')}); say it without the value. Systems, ids and counts only.`);
  return out;
}

/** The refusals for a lesson list, a nothing reason and learned ids; shared by the write path and `verify`. */
function refusals(lessons: readonly unknown[], nothing: unknown, learnedIds: readonly unknown[], known: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const hasNothing = nothing !== undefined && nothing !== null;
  if (!lessons.length && !hasNothing) out.push('give at least one --lesson "<source>: <text>", or --nothing "<why there was nothing to learn>".');
  if (lessons.length && hasNothing) out.push('--nothing says there was nothing to learn, so it takes no --lesson.');
  if (lessons.length > LESSONS_MAX) out.push(`${lessons.length} lessons is over ${LESSONS_MAX}: keep the ones a later agent needs.`);
  lessons.forEach((l, i) => {
    const lesson = l as Partial<Lesson> | null;
    if (!lesson || !(RETRO_SOURCES as readonly unknown[]).includes(lesson.source)) out.push(`lesson ${i + 1} must start with a source: ${RETRO_SOURCES.join(', ')} (for example "code: the cache key ignores the locale").`);
    else out.push(...textRefusals(`lesson ${i + 1}`, lesson.text));
  });
  if (hasNothing) out.push(...textRefusals('--nothing', nothing));
  for (const id of learnedIds) if (typeof id !== 'string' || !ROW_ID.test(id) || !known.has(id)) out.push('--learned names a row that is not a learned row on this ledger.');
  return [...new Set(out)];
}

export type AgentRetroParse = { fields: AgentRetroFields; errors?: undefined } | { fields?: undefined; errors: string[] };

/** What `agent-retro` does with its flags: the fields to store when every rule passes, else the refusals. `learnedIds` are the learned rows on the ledger. */
export function parseAgentRetro(raw: RawAgentRetro, learnedIds: ReadonlySet<string>): AgentRetroParse {
  const errors: string[] = [];
  if (!raw.item) errors.push('name the item: journal.ts agent-retro <item id> ...');
  const parsed = raw.lessons.map((l) => parseLesson(l));
  const lessons = parsed.map((l) => (l ? { source: l.source, text: oneLine(l.text) } : null));
  const nothing = raw.nothing === null ? undefined : oneLine(raw.nothing);
  errors.push(...refusals(lessons, nothing, raw.learned, learnedIds));
  if (errors.length) return { errors };
  const kept = lessons as Lesson[];
  const counts = RETRO_SOURCES.map((s) => [s, kept.filter((l) => l.source === s).length] as const).filter(([, n]) => n > 0).map(([s, n]) => `${s} ${n}`);
  const text = nothing !== undefined ? 'retro: nothing to learn' : `retro: ${kept.length} lesson${kept.length === 1 ? '' : 's'} (${counts.join(', ')})`;
  return { fields: { retros: raw.item as string, lessons: kept, ...(raw.learned.length ? { learnedIds: [...raw.learned] } : {}), ...(nothing !== undefined ? { nothing } : {}), text } };
}

const same = (a: LedgerRow, f: AgentRetroFields): boolean =>
  JSON.stringify([a.lessons ?? [], a.learnedIds ?? [], a.nothing ?? null]) === JSON.stringify([f.lessons, f.learnedIds ?? [], f.nothing ?? null]);

/** The same retro for the same item is already on the ledger: report it instead of writing it twice. */
export function seenRetro(rows: readonly LedgerRow[], f: AgentRetroFields): { kind: 'same'; id: string } | { kind: 'new' } {
  const hit = rows.find((r) => r.kind === 'agent-retro' && r.retros === f.retros && typeof r.id === 'string' && same(r, f));
  return hit ? { kind: 'same', id: hit.id as string } : { kind: 'new' };
}

/** Item ids that have a `brief` row: work dispatched to an agent, which owes a retro. */
const briefedIds = (rows: readonly LedgerRow[]): Set<string> => new Set(rows.filter((r) => r.kind === 'brief' && typeof r.briefs === 'string').map((r) => r.briefs as string));
const retroFor = (rows: readonly LedgerRow[]): Set<string> => new Set(rows.filter((r) => r.kind === 'agent-retro' && typeof r.retros === 'string').map((r) => r.retros as string));

/** Why `done` must refuse this item, or null when it may close: a briefed in-flight item with no retro. Only the CLI asks; automatic closers never do. */
export function retroGate(rows: readonly LedgerRow[], target: Pick<LedgerItem, 'id' | 'kind'>): string | null {
  if (target.kind !== 'wip' || typeof target.id !== 'string') return null;
  if (!briefedIds(rows).has(target.id) || retroFor(rows).has(target.id)) return null;
  return `${target.id} was briefed to an agent and has no retro. Write one first: journal.ts agent-retro ${target.id} --lesson "code: ..." --lesson "jack: ..." (or --nothing "<why>"). To close without one, pass --no-retro "<why>"; the reason is recorded.`;
}

/** The refusals for `done --no-retro "<why>"`: a reason is required, and it is scanned like a lesson. */
export const noRetroRefusals = (why: string | null): string[] => (why && why.trim() ? textRefusals('--no-retro', oneLine(why)) : ['--no-retro needs the reason there is no retro, for example --no-retro "the agent was stopped before it finished".']);

/** Ids a `retro-reviewed` row has closed: retros, and closed items that had none. */
const reviewedIds = (rows: readonly LedgerRow[]): Set<string> => new Set(rows.filter((r) => r.kind === 'retro-reviewed' && typeof r.reviews === 'string').map((r) => r.reviews as string));

/** The agent-retro rows no `retro-reviewed` row has closed, oldest first. */
export function pendingRetros(rows: readonly LedgerRow[]): LedgerRow[] {
  const reviewed = reviewedIds(rows);
  return rows.filter((r) => r.kind === 'agent-retro' && typeof r.id === 'string' && !reviewed.has(r.id));
}

/** One briefed item closed by `done` without a retro, not yet seen by a review. `noRetro` is the reason given, when one was. */
export interface MissingRetro { item: string; text: string; closedAt: string; closedBy: string; noRetro?: string }

/**
 * Briefed items closed by `done` with no retro, that no review has seen. The rule starts with the first retro (or `--no-retro` close) on the
 * ledger, so history from before retros existed is not reported as missing.
 */
export function missingRetros(rows: readonly LedgerRow[]): MissingRetro[] {
  const adopted = rows.filter((r) => r.kind === 'agent-retro' || (r.kind === 'done' && typeof r.noRetro === 'string')).map((r) => String(r.ts ?? '')).filter(Boolean).sort()[0];
  if (!adopted) return [];
  const briefed = briefedIds(rows);
  const retros = retroFor(rows);
  const reviewed = reviewedIds(rows);
  const items = new Map(rows.filter((r) => typeof r.id === 'string' && r.kind === 'wip').map((r) => [r.id as string, r]));
  return rows
    .filter((r) => r.kind === 'done' && typeof r.closes === 'string' && String(r.ts ?? '') >= adopted)
    .filter((r) => briefed.has(r.closes as string) && !retros.has(r.closes as string) && !reviewed.has(r.closes as string))
    .map((r) => ({ item: r.closes as string, text: String(items.get(r.closes as string)?.text ?? r.text ?? ''), closedAt: String(r.ts ?? ''), closedBy: String(r.id), ...(typeof r.noRetro === 'string' ? { noRetro: r.noRetro } : {}) }));
}

/** The refusals for `retro-reviewed`: the id must be a pending retro or a missing-retro item, and the note and promotions are scanned. */
export function reviewRefusals(rows: readonly LedgerRow[], id: string | null, promoted: readonly string[], note: string | null): string[] {
  const out: string[] = [];
  const open = new Set([...pendingRetros(rows).map((r) => r.id as string), ...missingRetros(rows).map((m) => m.item)]);
  if (!id) out.push('name the retro (or the item closed without one): journal.ts retro-reviewed <id> --note "..."');
  else if (!open.has(id)) out.push(`${id} is not an unreviewed retro or a briefed item closed without one (journal.ts agent-retros lists them).`);
  if (!note) out.push('--note is required: what the review did with it, in one line (promoted, merged into a ticket, dropped and why).');
  else out.push(...textRefusals('--note', note));
  for (const p of promoted) if (!/^(learned|ticket|memory|rule|decision):[^\s,]{1,120}$/.test(p)) out.push('--promoted takes kind:id pairs, kind one of learned, ticket, memory, rule, decision (for example learned:ab12,ticket:proj-042).');
  return [...new Set(out)];
}

/** Problems with one stored `agent-retro` row, for `verify`: the write-time rules, plus any field the write path never sets. Messages never echo the text. */
export function agentRetroProblems(row: LedgerRow, learnedIds: ReadonlySet<string>): string[] {
  const extra = Object.keys(row).filter((k) => !AGENT_RETRO_ROW_FIELDS.has(k));
  const lessons = Array.isArray(row.lessons) ? (row.lessons as unknown[]) : row.lessons === undefined ? [] : [null];
  const learned = Array.isArray(row.learnedIds) ? (row.learnedIds as unknown[]) : [];
  return [
    ...(extra.length ? [`${extra.length} field(s) the write path never sets`] : []),
    ...(typeof row.retros === 'string' && row.retros ? [] : ['names no item (retros)']),
    ...refusals(lessons, row.nothing, learned, learnedIds),
  ];
}

/** Problems with one stored `retro-reviewed` row, for `verify`. */
export function retroReviewedProblems(row: LedgerRow): string[] {
  const extra = Object.keys(row).filter((k) => !RETRO_REVIEWED_ROW_FIELDS.has(k));
  const promoted = Array.isArray(row.promoted) ? (row.promoted as unknown[]) : [];
  return [
    ...(extra.length ? [`${extra.length} field(s) the write path never sets`] : []),
    ...(typeof row.reviews === 'string' && row.reviews ? [] : ['names nothing it reviewed (reviews)']),
    ...textRefusals('note', row.text),
    ...(promoted.every((p) => typeof p === 'string' && /^(learned|ticket|memory|rule|decision):[^\s,]{1,120}$/.test(p)) ? [] : ['promoted has an entry that is not kind:id']),
  ];
}
