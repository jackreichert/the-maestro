/**
 * The cold-start page: what a fresh session needs to state current work from disk alone, generated from the ledger and the
 * library at read time (so it is never stale) and bounded in size. Pure: nothing here reads a file, the clock or a process.
 *
 * Sections: Current work (per stream: in flight with its brief and report path, blocked, queued, last note), Decisions pending
 * (open asks), How to work (current library pages per active stream, then the commands that print the full views).
 *
 * Guarantees, each enforced where it is applied:
 *  - Every open in-flight, blocked and ask id is in the text at every size level; only wording shrinks. If even the shortest form
 *    does not fit, the text is cut and `truncated` is true, and `coldStartCheck` fails on the ids that fell off.
 *  - Every item text, path and field passes `scanText`; a hit replaces the text with a marker, never the matched value.
 */
import { fold, isInFlight, isOpen, isQueued } from './ledger-core.ts';
import type { LedgerItem, LedgerRow, RegistryLookup } from './ledger-core.ts';
import { askBits } from './journal/ask-fields.ts';
import { scanText } from './library/scan.ts';

export const COLD_START_MAX_CHARS = 12_000;
export const WITHHELD = '[withheld: secret shape]';
const NO_STREAM = 'other';
const SECTION_WORK = '## Current work';
const SECTION_ASKS = '## Decisions pending';
const SECTION_HOW = '## How to work';

/** One library page, as the cold-start page needs it: where it is, what it is about and whether it is current. */
export interface LibraryEntry { path: string; kind: string; stream: string; status: string; verifiedAt: string }
export interface ColdInput { rows: LedgerRow[]; registry: RegistryLookup | null; library: LibraryEntry[]; /** Clock for ages; the caller passes it in. */ now: Date; maxChars?: number }
export interface ColdStart { text: string; truncated: boolean; level: number; ids: { inFlight: string[]; blocked: string[]; queued: string[]; asks: string[] } }

/** Text safe to print: whitespace collapsed, clipped, and replaced outright when a secret shape is found in it. */
export function safe(raw: unknown, max: number): string {
  const t = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  if (scanText(t).length) return WITHHELD;
  return t.length > max ? `${t.slice(0, Math.max(1, max - 1))}…` : t;
}

const streamOf = (i: { stream?: string }): string => i.stream || NO_STREAM;
const day = (ts: string | undefined): string => (ts ?? '').slice(0, 10);

/** Per-level wording budgets: higher levels say less, never name fewer in-flight, blocked or ask items. */
interface Level { text: number; queuedText: boolean; notes: boolean; pages: number; askText: number; stakes: boolean }
const LEVELS: Level[] = [
  { text: 120, queuedText: true, notes: true, pages: 4, askText: 120, stakes: true },
  { text: 70, queuedText: true, notes: false, pages: 2, askText: 70, stakes: true },
  { text: 50, queuedText: false, notes: false, pages: 1, askText: 45, stakes: false },
  { text: 0, queuedText: false, notes: false, pages: 0, askText: 0, stakes: false },
];

interface Folded { inFlight: LedgerItem[]; blocked: LedgerItem[]; queued: LedgerItem[]; asks: LedgerItem[]; notes: LedgerItem[]; brief: Map<string, { brief?: string; report?: string }> }

function foldBoard(rows: LedgerRow[], registry: RegistryLookup | null): Folded {
  const f = fold(rows, registry);
  const open = f.items.filter((i) => isOpen(i) && !f.hidden.has(i.id ?? ''));
  const brief = new Map<string, { brief?: string; report?: string }>();
  for (const r of rows) if (r.kind === 'brief' && r.briefs) brief.set(r.briefs, { brief: r.brief, report: r.report });
  return {
    inFlight: open.filter(isInFlight), blocked: open.filter((i) => i.kind === 'blocked'), queued: open.filter(isQueued),
    asks: open.filter((i) => i.kind === 'question' || i.kind === 'decision'),
    notes: f.items.filter((i) => i.kind === 'note' && !f.hidden.has(i.id ?? '')), brief,
  };
}

const by = <T extends { stream?: string }>(xs: T[], s: string): T[] => xs.filter((x) => streamOf(x) === s);
const ageOf = (ts: string | undefined, now: Date): string => {
  const t = Date.parse(ts ?? '');
  if (!Number.isFinite(t)) return '';
  const d = Math.floor((now.getTime() - t) / 864e5);
  return d <= 0 ? 'today' : `${d}d`;
};

function workLines(b: Folded, streams: string[], lv: Level, now: Date): string[] {
  const t = (s: unknown): string => (lv.text ? safe(s, lv.text) : '');
  const out: string[] = [];
  for (const s of streams) {
    const fl = by(b.inFlight, s), bl = by(b.blocked, s), q = by(b.queued, s);
    out.push(`### ${s}: ${fl.length} in flight, ${bl.length} blocked, ${q.length} queued`);
    for (const i of fl) {
      const files = b.brief.get(i.id ?? '');
      const bits = [i.model ? safe(i.model, 24) : '', ageOf(i.ts, now), files?.report ? `report: ${safe(files.report, 160)}` : '', files?.brief && lv.text >= 70 ? `brief: ${safe(files.brief, 160)}` : ''].filter(Boolean);
      out.push(`- \`${i.id}\` ${t(i.text)}${bits.length ? ` · ${bits.join(' · ')}` : ''}`.trimEnd());
    }
    for (const i of bl) out.push(`- blocked \`${i.id}\` ${t(i.text)}${i.gate && lv.text ? ` · gate: ${safe(i.gate, 50)}` : ''}`.trimEnd());
    if (q.length) out.push(lv.queuedText ? `- queued: ${q.map((i) => `\`${i.id}\` ${safe(i.text, 50)}`).join('; ')}` : `- queued: ${q.map((i) => `\`${i.id}\``).join(' ')}`);
    const note = lv.notes ? by(b.notes, s).sort((x, y) => (y.ts ?? '').localeCompare(x.ts ?? ''))[0] : undefined;
    if (note) out.push(`- last note (${day(note.ts)}): ${safe(note.text, 160)}`);
  }
  return out;
}

function askLines(b: Folded, lv: Level, now: Date): string[] {
  return [...b.asks].sort((x, y) => (x.ts ?? '').localeCompare(y.ts ?? '')).map((a) => {
    const stakes = lv.stakes ? askBits(a as Parameters<typeof askBits>[0], 60).map((x) => safe(x, 90)).join(' · ') : '';
    return `- \`${a.id}\` [${streamOf(a)}] ${lv.askText ? safe(a.text, lv.askText) : ''} · ${ageOf(a.ts, now) || 'new'}${stakes ? ` · ${stakes}` : ''}`.replace(/ {2,}/g, ' ');
  });
}

function howLines(streams: string[], library: LibraryEntry[], lv: Level): string[] {
  const out: string[] = [];
  for (const s of streams) {
    const pages = library.filter((p) => p.status === 'current' && p.stream.toLowerCase() === s.toLowerCase())
      .sort((a, b) => (a.kind === 'runbook' ? 0 : 1) - (b.kind === 'runbook' ? 0 : 1) || b.verifiedAt.localeCompare(a.verifiedAt)).slice(0, lv.pages);
    if (pages.length) out.push(`- ${s}: ${pages.map((p) => `${safe(p.path, 120)} (${safe(p.kind, 16)}, verified ${safe(p.verifiedAt, 10)})`).join('; ')}`);
  }
  out.push('- Full views: `journal.ts start-here`, `journal.ts handoff --all`, `journal.ts prime`; library: `library-check.ts`.');
  return out;
}

function render(b: Folded, library: LibraryEntry[], now: Date, lv: Level): string {
  const streams = [...new Set([...b.inFlight, ...b.blocked, ...b.queued].map(streamOf))].sort();
  const head = ['# Cold start', '', `Generated ${now.toISOString().slice(0, 16)}Z from the ledger and the library; read-only, regenerated at read time. Anything not here is in \`journal.ts start-here\`.`, ''];
  return [
    ...head, SECTION_WORK, '', ...(streams.length ? workLines(b, streams, lv, now) : ['Nothing in flight, blocked or queued.']), '',
    SECTION_ASKS, '', ...(b.asks.length ? askLines(b, lv, now) : ['None.']), '',
    SECTION_HOW, '', ...howLines(streams, library, lv), '',
  ].join('\n');
}

/** The page: the fullest wording that fits `maxChars`; at the shortest level the text is cut and `truncated` says so. */
export function coldStart(input: ColdInput): ColdStart {
  const max = input.maxChars ?? COLD_START_MAX_CHARS;
  const b = foldBoard(input.rows, input.registry);
  const id = (xs: LedgerItem[]): string[] => xs.map((i) => i.id ?? '');
  const ids = { inFlight: id(b.inFlight), blocked: id(b.blocked), queued: id(b.queued), asks: id(b.asks) };
  for (let level = 0; level < LEVELS.length; level += 1) {
    const text = render(b, input.library, input.now, LEVELS[level] as Level);
    if (text.length <= max || level === LEVELS.length - 1) {
      const fits = text.length <= max;
      return { text: fits ? text : `${text.slice(0, max)}\n… cut at ${max} characters`, truncated: !fits, level, ids };
    }
  }
  /* c8 ignore next: the loop always returns at the last level */
  throw new Error('unreachable');
}

/** The "Current work" and "Decisions pending" sections of a page: the statement a cold session reads and states. */
export function currentWorkStatement(text: string): string {
  const lines = text.split('\n');
  const start = lines.indexOf(SECTION_WORK);
  if (start < 0) return '';
  const end = lines.indexOf(SECTION_HOW, start);
  return lines.slice(start, end < 0 ? undefined : end).join('\n').trim();
}

export interface ColdCheck { ok: boolean; statement: string; missing: { id: string; why: string }[]; problems: string[] }

/**
 * The cold-start test: from the ledger rows and the library alone (no transcript), build the page, take its statement and fail
 * when any open in-flight, blocked, queued or ask id is not in it, when the page was cut, or when a secret shape is on it.
 */
export function coldStartCheck(input: ColdInput): ColdCheck {
  const page = coldStart(input);
  const statement = currentWorkStatement(page.text);
  const missing = (Object.entries(page.ids) as [string, string[]][])
    .flatMap(([group, ids]) => ids.filter((id) => !statement.includes(`\`${id}\``)).map((id) => ({ id, why: `open ${group} item not in the current-work statement` })));
  const problems = [
    ...(page.truncated ? [`page cut at ${input.maxChars ?? COLD_START_MAX_CHARS} characters`] : []),
    ...scanText(page.text).map((h) => `secret shape ${h.rule} on page line ${h.line}`),
  ];
  return { ok: !missing.length && !problems.length, statement, missing, problems };
}
