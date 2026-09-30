/**
 * The ledger's shared core: what a row means once the append-only log is folded, and how a stream
 * name maps through the registry. journal.mjs and ledger-index.mjs both import it, so there is one
 * definition of "open", of the fold, and of the alias mapping.
 *
 * Pure functions only. Importing this module runs no CLI and touches no file until you call
 * readRegistry(). The registry is passed in, never read from a global.
 */
import { readFileSync, existsSync } from 'node:fs';

// Kinds that keep an item on the board until something closes it.
export const OPEN_KINDS = ['wip', 'blocked', 'question', 'decision'];
export const isOpen = (i) => !i.closedBy && OPEN_KINDS.includes(i.kind);
// Rows that are events about items, not items themselves.
export const NON_ITEM_KINDS = ['rolled', 'stamp', 'tag', 'fact', 'carry', 'archive', 'unarchive'];

// ── stream registry ─────────────────────────────────────────────────────────

/**
 * { streams: { Canonical: { aliases: [], status } } } from a streams.json path, or null when there is
 * no (readable) registry. `onMalformed` is called when the file exists but is not valid JSON.
 */
export function readRegistry(path, onMalformed) {
    if (!existsSync(path)) return null;
    try {
        const j = JSON.parse(readFileSync(path, 'utf8'));
        return { streams: j && typeof j.streams === 'object' && j.streams ? j.streams : {} };
    } catch {
        if (onMalformed) onMalformed();
        return null;
    }
}

/** Canonical name for a canonical name, alias or case variant; null when the registry does not know it. */
export function canonicalOf(reg, name) {
    if (!reg || typeof name !== 'string') return null;
    const k = name.trim().toLowerCase();
    for (const [canon, meta] of Object.entries(reg.streams)) {
        if (canon.toLowerCase() === k || (meta?.aliases || []).some((a) => String(a).toLowerCase() === k)) return canon;
    }
    return null;
}

/** Read-time mapping: registered spellings become the canonical name, anything else is left alone. */
export const mapStreamWith = (reg, s) => (s ? canonicalOf(reg, s) ?? s : s);

// ── fold ────────────────────────────────────────────────────────────────────

const MARK_FIELDS = ['model', 'used', 'tokens', 'harness'];

/** Later stamps win field by field, so a partial stamp never erases an earlier one. */
export function mergeMark(prev, next) {
    const out = { ...(prev || {}) };
    for (const f of MARK_FIELDS) if (next[f] !== undefined) out[f] = next[f];
    return out;
}

export function withStamp(entry, stamped) {
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
export function fold(entries, reg) {
    const mapStream = (s) => mapStreamWith(reg, s);
    const byId = new Map();
    const stamped = new Map();
    for (const e of entries) {
        if (e.annotates) stamped.set(e.annotates, mergeMark(stamped.get(e.annotates), e));
        if (e.id && !e.annotates) byId.set(e.id, e);
    }
    const closed = new Map();
    const streams = new Map();
    const archivedBy = new Map();
    for (const e of entries) {
        if (e.closes) closed.set(e.closes, withStamp(e, stamped));
        if (e.kind === 'tag' && e.tags) streams.set(e.tags, e.stream || undefined);
        if (e.kind === 'carry' && e.carries) streams.set(e.carries, e.stream || undefined);
        if (e.kind === 'archive' && e.stream) archivedBy.set(mapStream(e.stream), e.ids || []);
        if (e.kind === 'unarchive' && e.stream) archivedBy.delete(mapStream(e.stream));
    }
    const items = [];
    for (const e of entries) {
        if (!e.id || e.closes || e.annotates || NON_ITEM_KINDS.includes(e.kind)) continue;
        const base = withStamp(e, stamped);
        const close = closed.get(e.id) || null;
        const stream = mapStream(streams.has(e.id) ? streams.get(e.id) : base.stream);
        items.push({ ...base, stream, closedBy: close, state: close ? close.kind : base.kind });
    }
    // Ids hidden by the latest archive event of each still-archived stream.
    const hidden = new Set([...archivedBy.values()].flat());
    return { items, byId, hidden, archivedStreams: new Set(archivedBy.keys()) };
}
