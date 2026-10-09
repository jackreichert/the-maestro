/**
 * The event inbox: `<event_dir>/events.jsonl`, an append-only record of what the loop saw, so an actionable event survives a
 * session ending and is delivered once. Three row kinds share the file: `event` (what happened), `seen` (some session was shown
 * it) and `handled` (someone acted and acked). State is folded from the rows when read; nothing is rewritten.
 *
 * What a row may carry is fixed here, not by the producers: an `event` row is built field by field from `ROW_KEYS`, its `fields`
 * pass through `FIELD_RULES`, and `readInbox` rebuilds every entry the same way, so a hand-edited or older row cannot put free text
 * (a title, a comment body, a login, an org name) in front of a reader. The digest keeps the free-text summary; the inbox keeps
 * `{ repo, number, who: bot|human, count }` and a `kind`, which is all an alert or a hook line is built from.
 *
 * Several processes may append at once (the loop, `events ack`, a waiter marking seen). Each row is one `O_APPEND` write of a
 * single line, which the OS appends whole. A crash can leave the last line without its newline; the next append then starts with
 * a newline in the same write, so it cannot fuse with the fragment, and `readInboxReport` counts the fragment as torn. A duplicated `event` id (two writers racing the dedupe check) collapses to the first
 * on read, and `seen`/`handled` rows are idempotent, so no lock is needed.
 */
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { DigestEvent } from './types.ts';
import { cleanWindowId } from './window-id.ts';

/** The extracted facts an alert or hook line may use. */
export interface EventFields { repo?: string; number?: number; who?: 'bot' | 'human'; count?: number }

/** An event row as stored. */
export interface InboxEvent {
  id: string;
  watch: string;
  type: string;
  /** A lowercase token such as `thread`, `conflict`, `changes-requested` (see KIND_RULES). */
  kind: string;
  at: string;
  actionable: boolean;
  fields: EventFields;
}

/** An event with its folded state. */
/** `seenBy` and `handledBy` are the window ids on the first `seen` and `handled` rows; absent when the mark carried none (an older row or a caller that gave no window). */
export interface InboxEntry extends InboxEvent { seen: boolean; handled: boolean; seenBy?: string; handledBy?: string }

export const inboxPath = (eventDir: string): string => join(eventDir, 'events.jsonl');

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const KIND = /^[a-z][a-z0-9-]{0,39}$/;
const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
/** A time as canonical ISO text, or null. Re-serialised, never passed through: the date parser accepts trailing free text such as "(note)", so a check alone would let it into the file. */
const isoTime = (v: unknown): string | null => { const t = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(t) ? new Date(t).toISOString() : null; };
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** Allowlisted fields: a value is kept only when its rule accepts it, and any other key is dropped. */
const FIELD_RULES: Record<keyof EventFields, (v: unknown) => boolean> = {
  repo: (v) => typeof v === 'string' && REPO.test(v),
  number: (v) => isCount(v) && v > 0,
  who: (v) => v === 'bot' || v === 'human',
  count: isCount,
};

/** The allowlisted subset of `raw`; anything not in FIELD_RULES, or failing its rule, is dropped. */
export function cleanFields(raw: unknown): EventFields {
  if (typeof raw !== 'object' || raw === null) return {};
  const src = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, ok] of Object.entries(FIELD_RULES)) if (key in src && ok(src[key])) out[key] = src[key];
  return out as EventFields;
}

/** Summary prefix to kind, first match wins. Everything else is `other`. */
const KIND_RULES: [RegExp, string][] = [
  [/^CONFLICT-CLEARED\b/, 'conflict-cleared'],
  [/^CONFLICT\b/, 'conflict'],
  [/^DECISION\b.*-> CHANGES_REQUESTED\b/, 'changes-requested'],
  [/^DECISION\b.*-> APPROVED\b/, 'approved'],
  [/^DECISION\b/, 'decision'],
  [/^APPROVED-UNMERGED\b/, 'approved-unmerged'],
  [/^THREAD\b/, 'thread'],
  [/^REPLY\b/, 'reply'],
  [/^COMMENT\b/, 'comment'],
  [/^REVIEW\b/, 'review'],
  [/^LEFT-OPEN-SET\b/, 'left-open-set'],
  [/^NOTION-CHANGED\b/, 'notion-changed'],
  [/^reminder\b/, 'reminder'],
  [/^\d+ new message/, 'message'],
  [/^check keeps failing\b/, 'check-failing'],
  [/^watch expired\b/, 'watch-expired'],
];

/** Fact extractors over a summary; each returns the fields it finds (the rule table decides what survives). */
const FIELD_EXTRACTORS: ((summary: string) => Record<string, unknown>)[] = [
  (s) => { const m = s.match(/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)#(\d+)/); return m ? { repo: m[1], number: Number(m[2]) } : {}; },
  (s) => { const m = s.match(/ by (\S+?)[ :(]/); return m ? { who: /\[bot\]$|-bot$|^copilot/i.test(m[1]) ? 'bot' : 'human' } : {}; },
  (s) => { const m = s.match(/^(\d+) new message/); return m ? { count: Number(m[1]) } : {}; },
];

const kindOf = (summary: string): string => {
  for (const [re, kind] of KIND_RULES) if (re.test(summary)) return kind;
  return 'other';
};

/**
 * A short stable id from watch, type, time and summary. A digest line replayed after a crash keeps its time, so it gets the same id and is
 * a no-op; a later occurrence of the same words (a second text, a conflict that returns) has a new time and so is a new event.
 */
export const eventId = (e: Pick<DigestEvent, 'watch' | 'type' | 'summary'> & { at: string }): string => createHash('sha256').update(`${e.watch}|${e.type}|${e.at}|${e.summary}`).digest('hex').slice(0, 12);

/** Builds the stored form of a digest event, or null when its watch or type is not a plain token (it is refused, not written). The summary is read here and goes no further. */
export function toInboxEvent(e: DigestEvent): InboxEvent | null {
  const at = isoTime(e.at);
  if (!TOKEN.test(String(e.watch)) || !TOKEN.test(String(e.type)) || at === null) return null;
  const raw = Object.assign({}, ...FIELD_EXTRACTORS.map((x) => x(String(e.summary))));
  return { id: eventId({ ...e, at }), watch: e.watch, type: e.type, kind: kindOf(String(e.summary)), at, actionable: e.actionable === true, fields: cleanFields(raw) };
}

/** Rebuilds an event from a parsed row using only the keys the inbox defines; null when it does not have the shape. */
function cleanEvent(raw: unknown): InboxEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const ok = r.row === 'event' && typeof r.id === 'string' && /^[0-9a-f]{12}$/.test(r.id) && typeof r.watch === 'string' && TOKEN.test(r.watch)
    && typeof r.type === 'string' && TOKEN.test(r.type) && typeof r.kind === 'string' && KIND.test(r.kind) && isoTime(r.at) !== null;
  if (!ok) return null;
  return { id: r.id as string, watch: r.watch as string, type: r.type as string, kind: r.kind as string, at: isoTime(r.at) as string, actionable: r.actionable === true, fields: cleanFields(r.fields) };
}

/** The parsed rows, and how many non-empty lines were not JSON (a torn write); those are skipped, not hidden: callers report the count. */
function readRows(eventDir: string): { rows: unknown[]; torn: number } {
  const file = inboxPath(eventDir);
  const rows: unknown[] = [];
  let torn = 0;
  if (!existsSync(file)) return { rows, torn };
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try { rows.push(JSON.parse(line)); } catch { torn += 1; }
  }
  return { rows, torn };
}

/** Every event with its seen and handled state, oldest first. A repeated id keeps its first row; unknown or malformed rows are skipped. */
export const readInbox = (eventDir: string): InboxEntry[] => readInboxReport(eventDir).entries;

/** `readInbox` plus the number of torn (unparseable) lines it skipped, so a reader can say so instead of showing fewer events in silence. */
export function readInboxReport(eventDir: string): { entries: InboxEntry[]; torn: number } {
  const { rows, torn } = readRows(eventDir);
  const entries = new Map<string, InboxEntry>();
  const marks: { row: 'seen' | 'handled'; id: string; window?: string }[] = [];
  for (const raw of rows) {
    const row = (raw as { row?: unknown } | null)?.row;
    if (row === 'event') {
      const e = cleanEvent(raw);
      if (e && !entries.has(e.id)) entries.set(e.id, { ...e, seen: false, handled: false });
    } else if ((row === 'seen' || row === 'handled') && typeof (raw as { id?: unknown }).id === 'string') marks.push({ row, id: (raw as { id: string }).id, window: cleanWindowId(String((raw as { window?: unknown }).window ?? '')) || undefined });
  }
  for (const { row, id, window } of marks) {
    const entry = entries.get(id);
    if (!entry) continue;
    if (window && row === 'handled' && !entry.handledBy) entry.handledBy = window;
    if (window && !entry.seenBy) entry.seenBy = window;
    if (row === 'handled') { entry.handled = true; entry.seen = true; } else entry.seen = true;
  }
  return { entries: [...entries.values()], torn };
}

/** True when the open file is non-empty and its last byte is not a newline: a previous write was cut short. */
function endsMidLine(fd: number): boolean {
  const size = fstatSync(fd).size;
  if (size === 0) return false;
  const last = Buffer.alloc(1);
  readSync(fd, last, 0, 1, size - 1);
  return last[0] !== 0x0a;
}

/**
 * Appends one row as a single write. On a file that ends mid-line the same write begins with a newline, which closes the torn
 * fragment. Two writers that both see the torn tail each prefix a newline; the extra blank line is ignored on read, and neither row is lost.
 */
const appendRow = (eventDir: string, row: Record<string, unknown>): void => {
  mkdirSync(eventDir, { recursive: true });
  const fd = openSync(inboxPath(eventDir), 'a+');
  try {
    writeSync(fd, `${endsMidLine(fd) ? '\n' : ''}${JSON.stringify(row)}\n`);
  } finally {
    closeSync(fd);
  }
};

/** What `appendEvents` did: rows written, ids already in the inbox, and events refused for a bad watch, type or time. */
export interface AppendResult { added: number; duplicates: number; refused: number }

/**
 * Appends digest events to the inbox: the only write path for `event` rows. Each is reduced by `toInboxEvent` (which is where the
 * allowlist applies), and an id already present, in the file or earlier in this batch, is dropped, so replaying a digest after a crash adds nothing.
 */
export function appendEvents(eventDir: string, events: DigestEvent[]): AppendResult {
  const known = new Set(readInbox(eventDir).map((e) => e.id));
  const result: AppendResult = { added: 0, duplicates: 0, refused: 0 };
  for (const digest of events) {
    const e = toInboxEvent(digest);
    if (!e) { result.refused += 1; continue; }
    if (known.has(e.id)) { result.duplicates += 1; continue; }
    known.add(e.id);
    appendRow(eventDir, { row: 'event', id: e.id, watch: e.watch, type: e.type, kind: e.kind, at: e.at, actionable: e.actionable, fields: e.fields });
    result.added += 1;
  }
  return result;
}

/** Marks existing events with a `seen` or `handled` row, tagged with the marking window when one is given; skips ids already in that state or not in the inbox. Returns the ids that are not in the inbox. */
export function mark(eventDir: string, row: 'seen' | 'handled', ids: string[], now: number = Date.now(), window?: string): { unknown: string[] } {
  const entries = new Map(readInbox(eventDir).map((e) => [e.id, e]));
  const unknown: string[] = [];
  for (const id of new Set(ids)) {
    const entry = entries.get(id);
    if (!entry) { unknown.push(id); continue; }
    if (row === 'handled' ? entry.handled : entry.seen) continue;
    const by = cleanWindowId(window);
    appendRow(eventDir, { row, id, at: new Date(now).toISOString(), ...(by ? { window: by } : {}) });
  }
  return { unknown };
}

/** One line per event: `<id> <new|seen|handled> <kind> <watch> (<type>) <field=value ...>`. Built from the allowlisted parts only. */
export const formatEntry = (e: InboxEntry): string => {
  const facts = Object.entries(e.fields).map(([k, v]) => `${k}=${v}`).join(' ');
  return `${e.id} ${e.handled ? 'handled' : e.seen ? 'seen' : 'new'} ${e.actionable ? 'ACTION' : 'info'} ${e.kind} ${e.watch} (${e.type})${facts ? ` ${facts}` : ''}`;
};
