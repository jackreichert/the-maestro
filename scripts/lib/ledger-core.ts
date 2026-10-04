/**
 * The ledger's shared core: what a row means once the append-only log is folded, and how a stream
 * name maps through the registry. journal.mjs and ledger-index.ts both import it, so there is one
 * definition of "open", of the fold, and of the alias mapping.
 *
 * Pure functions only. Importing this module runs no CLI and touches no file until you call
 * readRegistry(). The registry is passed in, never read from a global.
 */
import { readFileSync, existsSync } from 'node:fs';

/** One line of ledger.jsonl. The named fields are the ones the fold reads; rows carry others (text, date, ref, gate...) it passes through. */
export interface LedgerRow {
    id?: string;
    kind?: string;
    stream?: string;
    model?: string;
    used?: unknown;
    tokens?: unknown;
    harness?: unknown;
    /** Id of the item this row closes. */
    closes?: string;
    /** Id of the item whose usage marks this row amends. */
    annotates?: string;
    /** Id of the item a `tag` row files under `stream`. */
    tags?: string;
    /** Id of the item a `carry` row re-homes to `stream`. */
    carries?: string;
    /** Item ids an `archive` row hides. */
    ids?: string[];
    /** Item id a `defer` row hides until `until` (YYYY-MM-DD). */
    defers?: string;
    until?: string;
    pending?: boolean;
    /** The text, date (YYYY-MM-DD) and timestamp every row written by journal carries. */
    text?: string;
    date?: string;
    ts?: string;
    repo?: string;
    ticket?: string;
    /** A paste block's name, a gate (`date:YYYY-MM-DD` or free text), and an approval (`standing` or `one-off`) with its scope. */
    paste?: string;
    gate?: string;
    approval?: string;
    scope?: string;
    /** Files a record points at, and the row an `approval-tag` approves. */
    refs?: string[];
    approves?: string;
    why?: string;
    /** Tracker keys a note records as moved. */
    transitioned?: string[];
    [field: string]: unknown;
}

/** A folded item: the row that opened it, its stream mapped through the registry, and the row that closed it. */
export type LedgerItem = LedgerRow & { closedBy: LedgerRow | null; state: string | undefined };

export interface StreamMeta { aliases?: unknown[]; status?: string }
export interface Registry {
    streams: Record<string, StreamMeta>;
    hasStreams: boolean;
    models: Record<string, { aliases?: unknown[] }> | undefined;
}

/** The part of a Registry the name lookups read; `hasStreams` matters only to callers that enforce stream names. */
export type RegistryLookup = Pick<Registry, 'streams'> & Partial<Pick<Registry, 'models'>>;

type UsageMark = Pick<LedgerRow, 'model' | 'used' | 'tokens' | 'harness'>;


// Kinds that keep an item on the board until something closes it. A `decision` is a record of
// something already decided, so it is not open; only one written with `ask --kind decision`
// (`pending: true`) is a decision still waiting on the user.
export const OPEN_KINDS = ['wip', 'blocked', 'question'];
export const isPendingDecision = (i: LedgerRow): boolean => i.kind === 'decision' && i.pending === true;
export const isOpen = (i: LedgerRow & { closedBy?: LedgerRow | null }): boolean => !i.closedBy && ((i.kind !== undefined && OPEN_KINDS.includes(i.kind)) || isPendingDecision(i));
// Rows that are events about items, not items themselves.
export const NON_ITEM_KINDS = ['rolled', 'stamp', 'tag', 'approval-tag', 'fact', 'carry', 'archive', 'unarchive', 'claim', 'released', 'defer'];

/**
 * id -> until (YYYY-MM-DD) for every item a `defer` row hides on `today`: the latest defer row per item wins,
 * and it stops hiding on its `until` date. A closed item is never deferred.
 */
export function activeDeferrals(entries: LedgerRow[], today: string): Map<string, string> {
    const latest = new Map<string, string>();
    for (const e of entries) if (e.kind === 'defer' && e.defers && e.until) latest.set(e.defers, e.until);
    return new Map([...latest].filter(([, until]) => until > today));
}

// ── stream registry ─────────────────────────────────────────────────────────

/**
 * { streams, hasStreams, models } from a streams.json path, or null when there is no (readable)
 * registry. `streams` is { Canonical: { aliases: [], status } }; `hasStreams` says the file has a
 * `streams` section at all (without one, stream names are not enforced); `models` is
 * { canonical-id: { aliases: [] } }, or undefined when the file has none.
 * `onMalformed` is called when the file exists but is not valid JSON.
 */
export function readRegistry(path: string, onMalformed?: () => void): Registry | null {
    if (!existsSync(path)) return null;
    try {
        const j = JSON.parse(readFileSync(path, 'utf8'));
        const obj = <T>(v: unknown): Record<string, T> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, T>) : null);
        return { streams: obj<StreamMeta>(j?.streams) || {}, hasStreams: Boolean(obj(j?.streams)), models: obj<{ aliases?: unknown[] }>(j?.models) || undefined };
    } catch {
        if (onMalformed) onMalformed();
        return null;
    }
}

/**
 * Parses ledger.jsonl text into rows, skipping blank lines. A line that is not JSON is dropped and reported through
 * `onMalformed(n)`, where n counts the non-blank lines from 1. The JSON is not checked against LedgerRow: rows carry
 * whatever the writer put there, and the fold reads only the fields it names.
 */
export function parseLedger(text: string, onMalformed?: (n: number) => void): LedgerRow[] {
    return text
        .split('\n')
        .filter((l) => l.trim())
        .map((l, i) => {
            try { return JSON.parse(l) as LedgerRow | null; } catch { onMalformed?.(i + 1); return null; }
        })
        .filter((row): row is LedgerRow => Boolean(row));
}

/** Canonical name for a canonical name, alias or case variant; null when the registry does not know it. */
export function canonicalOf(reg: RegistryLookup | null | undefined, name: unknown): string | null {
    if (!reg || typeof name !== 'string') return null;
    const k = name.trim().toLowerCase();
    for (const [canon, meta] of Object.entries(reg.streams)) {
        if (canon.toLowerCase() === k || (meta?.aliases || []).some((a) => String(a).toLowerCase() === k)) return canon;
    }
    return null;
}

/** `none` is reserved: it means "no stream", and is never a stream name. */
export const isNoStream = (s: unknown): boolean => typeof s === 'string' && s.trim().toLowerCase() === 'none';

/**
 * Read-time mapping: registered spellings become the canonical name, anything else is left alone.
 * A stored `none` (older rows) reads as no stream; the ledger itself is never rewritten.
 */
export const mapStreamWith = (reg: RegistryLookup | null | undefined, s: string | undefined): string | undefined => (s && !isNoStream(s) ? canonicalOf(reg, s) ?? s : (isNoStream(s) ? undefined : s));

// ── model names ─────────────────────────────────────────────────────────────

/** Canonical model id for a canonical id or alias (case-insensitive); null when the registry has no models section or does not know it. */
export function canonicalModel(reg: RegistryLookup | null | undefined, name: unknown): string | null {
    if (!reg?.models || typeof name !== 'string') return null;
    const k = name.trim().toLowerCase();
    for (const [canon, meta] of Object.entries(reg.models)) {
        if (canon.toLowerCase() === k || (meta?.aliases || []).some((a) => String(a).toLowerCase() === k)) return canon;
    }
    return null;
}

/** Read-time mapping: a registered spelling becomes the canonical id; anything else is left alone. */
export const mapModelWith = <M>(reg: RegistryLookup | null | undefined, m: M): M | string => (typeof m === 'string' && m ? canonicalModel(reg, m) ?? m : m);

// ── fold ────────────────────────────────────────────────────────────────────

const MARK_FIELDS: (keyof UsageMark)[] = ['model', 'used', 'tokens', 'harness'];

/** Later stamps win field by field, so a partial stamp never erases an earlier one. */
export function mergeMark(prev: UsageMark | undefined, next: UsageMark): UsageMark {
    const out: UsageMark = { ...(prev || {}) };
    for (const f of MARK_FIELDS) if (next[f] !== undefined) Object.assign(out, { [f]: next[f] });
    return out;
}

export function withStamp<E extends LedgerRow>(entry: E, stamped: Map<string, UsageMark>): E {
    const mark = entry?.id ? stamped.get(entry.id) : null;
    if (!mark) return entry;
    return {
        ...entry,
        model: mark.model ?? entry.model,
        used: mark.used ?? entry.used,
        tokens: mark.tokens ?? entry.tokens,
        harness: mark.harness ?? entry.harness,
    };
}

/**
 * Fold the append-only log into current state. Later entries referencing an earlier id (via `closes`)
 * supersede it; `tag` and `carry` rows re-home an item; `stamp` rows amend its usage marks.
 * `reg` is the stream registry (or null): streams are mapped through it as the items are built.
 */
export function fold(entries: LedgerRow[], reg: RegistryLookup | null | undefined) {
    const mapStream = (s: string | undefined) => mapStreamWith(reg, s);
    const mapModel = <E extends LedgerRow>(e: E): E => (e && e.model ? { ...e, model: mapModelWith(reg, e.model) } : e);
    const byId = new Map<string, LedgerRow>();
    const stamped = new Map<string, UsageMark>();
    for (const e of entries) {
        if (e.annotates) stamped.set(e.annotates, mergeMark(stamped.get(e.annotates), e));
        if (e.id && !e.annotates) byId.set(e.id, e);
    }
    const closed = new Map<string, LedgerRow>();
    const streams = new Map<string, string | undefined>();
    const archivedBy = new Map<string | undefined, string[]>();
    for (const e of entries) {
        if (e.closes) closed.set(e.closes, mapModel(withStamp(e, stamped)));
        if (e.kind === 'tag' && e.tags) streams.set(e.tags, e.stream || undefined);
        if (e.kind === 'carry' && e.carries) streams.set(e.carries, e.stream || undefined);
        if (e.kind === 'archive' && e.stream) archivedBy.set(mapStream(e.stream), e.ids || []);
        if (e.kind === 'unarchive' && e.stream) archivedBy.delete(mapStream(e.stream));
    }
    const items: LedgerItem[] = [];
    for (const e of entries) {
        if (!e.id || e.closes || e.annotates || (e.kind !== undefined && NON_ITEM_KINDS.includes(e.kind))) continue;
        const base = mapModel(withStamp(e, stamped));
        const close = closed.get(e.id) || null;
        const stream = mapStream(streams.has(e.id) ? streams.get(e.id) : base.stream);
        items.push({ ...base, stream, closedBy: close, state: close ? close.kind : base.kind });
    }
    // Ids hidden by the latest archive event of each still-archived stream.
    const hidden = new Set([...archivedBy.values()].flat());
    return { items, byId, hidden, archivedStreams: new Set(archivedBy.keys()) };
}
