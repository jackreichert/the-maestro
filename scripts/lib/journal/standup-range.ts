/**
 * The paste-ready standup over a run of whole days: Yesterday / Today / Blockers, written for a team that cannot resolve
 * ledger ids, vault ticket ids or vault paths. `journal.ts standup --days N` and `GET /api/standup` both read this.
 * Pure: it reads the folded board it is given and the clock it is told, nothing else.
 */
import { streamTitle } from './board.ts';
import type { Groups } from './board.ts';
import type { LedgerItem } from '../ledger-core.ts';
import { shiftDay } from './approvals.ts';

export const MIN_DAYS = 1;
export const MAX_DAYS = 14;

/**
 * The standup as lines, not one string: the web route's secret withhold reads every JSON string as a whole, and a long multi-line text
 * can match across item boundaries and be replaced entirely, so each line is scanned on its own and the reader joins them.
 */
export interface StandupRange { days: number; from: string; to: string; defaultDays: number; lines: string[] }

/** A whole number in MIN_DAYS..MAX_DAYS from a raw query or flag value, or null for anything else (no clamping: a bad value is the caller's error). */
export function parseDays(raw: string | null | undefined): number | null {
    if (raw === null || raw === undefined || !/^\d{1,3}$/.test(raw)) return null;
    const n = Number(raw);
    return n >= MIN_DAYS && n <= MAX_DAYS ? n : null;
}

/** Days back that reach the previous working day: Monday reaches Friday (so Friday to Sunday), Sunday reaches Friday, any other day is yesterday. */
export function defaultDays(today: string): number {
    const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
    return dow === 1 ? 3 : dow === 0 ? 2 : 1;
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const weekday = (d: string): string => WEEKDAY[new Date(`${d}T00:00:00Z`).getUTCDay()] ?? d;

/** Words only a teammate can resolve are taken out: `[[wiki links]]`, lowercase vault ticket ids (`the-maestro-441`), home and vault paths, and ledger ids written as `id` or (id). Tracker keys (`ABC-123`) and PR numbers stay. */
export function teamSafe(text: string, ids: ReadonlySet<string>): string {
    const idToken = (m: string, id: string): string => (ids.has(id) ? '' : m);
    return text
        .replace(/\[\[[^\]]*\]\]/g, '')
        .replace(/\b[a-z][a-z0-9]*(?:-[a-z0-9]+)*-\d+\b/g, '')
        .replace(/(?:~|\/Users\/[^\s/]+|\/home\/[^\s/]+)(?:\/[^\s)]*)?/g, '')
        .replace(/\bProjects\/[^\s)]+/g, '')
        .replace(/`([a-z0-9]{4})`/g, idToken)
        .replace(/\(([a-z0-9]{4})\)/g, idToken)
        .replace(/\s+([,.;:)])/g, '$1')
        .replace(/\(\s*\)/g, '')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
}

const finishedText = (i: LedgerItem): string => i.closedBy?.kind === 'done' && i.closedBy.text ? i.closedBy.text : i.text ?? '';

const PER_STREAM = 5;
const LINE_MAX = 140;
const clip = (t: string): string => (t.length <= LINE_MAX ? t : `${t.slice(0, LINE_MAX).replace(/\s+\S*$/, '')}…`);

/** One bullet per stream with its items nested under it (at most PER_STREAM, each clipped, the rest counted). Items with no stream come last. */
function bullets(items: LedgerItem[], text: (i: LedgerItem) => string, ids: ReadonlySet<string>): string[] {
    const order: string[] = [];
    const by = new Map<string, string[]>();
    for (const i of items) {
        const t = teamSafe(text(i), ids);
        if (!t) continue;
        const key = i.stream ? streamTitle(i.stream) : 'Other';
        if (!by.has(key)) { by.set(key, []); order.push(key); }
        by.get(key)?.push(t);
    }
    order.sort((a, b) => (a === 'Other' ? 1 : 0) - (b === 'Other' ? 1 : 0));
    return order.flatMap((k) => {
        const all = by.get(k) ?? [];
        const more = all.length - PER_STREAM;
        return [`- ${k}`, ...all.slice(0, PER_STREAM).map((t) => `  - ${clip(t)}`), ...(more > 0 ? [`  - and ${more} more`] : [])];
    });
}

/**
 * The standup for the `days` whole days before `today` (the user's calendar day), oldest first. `tz` matches close times in the user's zone.
 * Today and Blockers are the board as it stands now, not as it stood on those days.
 */
export function standupRange(g: Groups, o: { today: string; days: number; tz?: string }): StandupRange {
    const from = shiftDay(o.today, -o.days);
    const to = shiftDay(o.today, -1);
    const ids = new Set(g.items.map((i) => i.id ?? ''));
    const done = Array.from({ length: o.days }, (_, k) => g.doneOn(shiftDay(from, k), o.tz ? { tz: o.tz } : {})).flat();
    const title = o.days === 1 ? 'Yesterday' : `Yesterday (${weekday(from)} to ${weekday(to)})`;
    const section = (name: string, lines: string[], empty: string): string[] => [`*${name}*`, ...(lines.length ? lines : [empty]), ''];
    const lines = [
        ...section(title, bullets(done, finishedText, ids), 'Nothing closed in this window.'),
        ...section('Today', bullets([...g.inflight, ...g.queued], (i) => i.text ?? '', ids), 'Nothing in flight.'),
        ...section('Blockers', bullets([...g.blocked, ...g.awaiting], (i) => i.text ?? '', ids), 'None.'),
    ].slice(0, -1);   // the last section's trailing blank line
    return { days: o.days, from, to, defaultDays: defaultDays(o.today), lines };
}
