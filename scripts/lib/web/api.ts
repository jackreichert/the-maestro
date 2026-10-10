/**
 * The JSON the Podium client reads over HTTP: PodiumState and ChartsData, built from the ledger, the PR cache and priorities.
 *
 * Two jobs, kept apart. `readBoard` is the only place that touches the disk: it folds the ledger in this process (no child
 * process, no GitHub) and feeds `gatherInputsCached`, the page generator's own read path. The pure reducers in state.ts and
 * charts.ts then turn those inputs into data, and `toWire` reshapes their output into the contract the client checks
 * (client/src/contract.ts), adding the content hash `seq` and the per-tab Markdown fragments.
 *
 * Read-only by construction and checked by the server test (the ledger is byte-identical afterwards): nothing here writes a
 * file or calls GitHub. Every call opens a fresh store, so a streams.json edit made by the CLI between requests is seen.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openStore } from '../journal/store.ts';
import { boardContextFor } from '../journal/board-context.ts';
import { footerDone, groups } from '../journal/board.ts';
import type { Groups } from '../journal/board.ts';
import { statusJson } from '../journal/status-json.ts';
import { triageItems } from '../journal/triage.ts';
import { ticketNoteRef } from '../status-page/render.ts';
import type { PageConfig, Ref } from '../status-page/render.ts';
import { gatherInputsCached } from '../status-page/generate.ts';
import { DEFAULT_PRIORITIES_MAX, localDate } from '../status-page/priorities.ts';
import type { GatheredInputs } from '../status-page/generate.ts';
import { buildCharts as reduceCharts } from './charts.ts';
import { buildState as reduceState } from './state.ts';
import type { PodiumState as ReducedState, WorkItem as ReducedWork } from './state.ts';
import type { AskCard, BlockedItem, ChartsData, DeferredItem, DoneItem, FooterRow, PodiumState, WorkItem } from '../../web/client/src/types.ts';

/** Where the data lives and how to read it: the ledger root and project, the status directory, and the page settings. */
export interface WebConfig {
  vault: string; project: string; statusDir: string; page: PageConfig; warn?: (message: string) => void;
  /** The notes vault the stream home base reads tickets from (`vault_root`); absent means no tickets are read. */
  vaultRoot?: string;
  /** `priorities_max`: the cap the page shows and the write path enforces. Default 5. */
  prioritiesMax?: number;
}

const MAX_FRAGMENT_BYTES = 64 * 1024;
const FRAGMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Not a real session: the reducers read only `footer.ledger`, and this keeps the server from reading the user's session files. */
const NO_SESSION = { available: false, unavailable: 'not read by the web server' } as const;

export interface Board { inputs: GatheredInputs; g: Groups }

/** One consistent read of everything a response needs. Done-today is the page zone's day, matched on close timestamps, not the UTC date stored on each row. */
export function readBoard(cfg: WebConfig, now: Date): Board {
  const utcDay = now.toISOString().slice(0, 10);
  const day = localDate(now, cfg.page.tz);
  const store = openStore({ vault: cfg.vault, project: cfg.project, dryRun: false, warn: cfg.warn ?? (() => {}) });
  const entries = store.readLedger();   // read once: the board and the triage metadata see the same rows
  const ctx = boardContextFor({ ...store, readLedger: () => entries }, { has: () => false, today: () => utcDay, dryRun: false });
  const g = groups(ctx);
  const view = footerDone(g, day, { tz: cfg.page.tz });
  const journal = (sub: 'status' | 'triage'): unknown => (sub === 'status'
    ? statusJson(g, day, NO_SESSION, view.all, view.sinceRoll)
    : { items: triageItems({ readLedger: ctx.readLedger, fold: ctx.fold, today: ctx.today, resolveRefFile: () => null }, utcDay, utcDay) });
  return { inputs: gatherInputsCached(cfg.statusDir, cfg.page, { journal, now: () => now }), g };
}

const toRef = ({ label, url }: Ref): { label: string; url?: string } => (url === undefined ? { label } : { label, url });

/** A reducer work row as the client's: the ticket as a link, the tracker keys as `links.tracker`, and the always-present strings. */
function wireWork(page: PageConfig, w: ReducedWork): WorkItem {
  const { ticket, links, since, ...rest } = w;
  return { ...rest, since: since ?? '', ...(ticket ? { ticket: toRef(ticketNoteRef(page, ticket)) } : {}), links: { tracker: links.filter((l) => l.label !== ticket), prs: [] } };
}

/** The Markdown fragment for each tab that has `<statusDir>/fragments/<tab>.md`. Tab names come from the stream list and are re-checked, never from the request. */
function readFragments(statusDir: string, tabs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tab of tabs) {
    if (!FRAGMENT_NAME.test(tab)) continue;
    const path = join(statusDir, 'fragments', `${tab}.md`);
    try { const st = lstatSync(path); if (st.isFile() && st.size <= MAX_FRAGMENT_BYTES) out[tab] = readFileSync(path, 'utf8'); } catch { /* an unreadable fragment is a missing one, not a failed page */ }
  }
  return out;
}

/** The reducer's state in the client's contract, with fragments and the content hash. */
function toWire(cfg: WebConfig, s: ReducedState): PodiumState {
  const work = (w: ReducedWork): WorkItem => wireWork(cfg.page, w);
  const footer: FooterRow[] = s.footer.map((r) => ({ stream: r.name ?? 'all', asks: r.awaiting + r.paste, working: r.inflight, queued: r.queued, blocked: r.blocked, done: r.done }));
  const asks: AskCard[] = s.asks.map((a) => ({ ...a, ts: a.ts ?? '' }));
  const blocked: BlockedItem[] = s.blocked.map((b) => ({ ...work(b), ...(b.gate ? { gate: b.gate } : {}) }));
  const done: DoneItem[] = s.done.map((d) => ({ ...work(d), closedAt: d.closedAt ?? '' }));
  const deferred: DeferredItem[] = s.deferred.map((d) => ({ ...work(d), until: d.until }));
  const { generatedAt, ...body } = {
    ...s, footer, asks, prs: s.prs.map((p) => ({ ...p, review: p.review ?? '' })), blocked, done, deferred, working: s.working.map(work), queued: s.queued.map(work),
    fragments: readFragments(cfg.statusDir, ['overview', ...s.streams]),
  };
  return { generatedAt, ...body, prioritiesMax: cfg.prioritiesMax ?? DEFAULT_PRIORITIES_MAX, seq: createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 12) };
}

/** The whole board as the client's PodiumState. */
export function buildState(cfg: WebConfig, now: Date = new Date()): PodiumState {
  return toWire(cfg, reduceState(readBoard(cfg, now).inputs));
}

/** The same state narrowed to one stream, or null when `name` is not one of its streams. */
export function buildStream(cfg: WebConfig, name: string, now: Date = new Date()): PodiumState | null {
  const s = buildState(cfg, now);
  if (!s.streams.includes(name)) return null;
  const mine = <T extends { stream: string }>(rows: T[]): T[] => rows.filter((r) => r.stream === name);
  return { ...s, asks: mine(s.asks), working: mine(s.working), queued: mine(s.queued), blocked: mine(s.blocked), done: mine(s.done), deferred: mine(s.deferred), prs: mine(s.prs), footer: mine(s.footer), fragments: s.fragments && name in s.fragments ? { [name]: s.fragments[name] as string } : {} };
}

/** The chart data for the last `days` days (the caller clamps the range). Done items carry their ticket note as a link, like the board's rows. */
export function buildCharts(cfg: WebConfig, days: number, now: Date = new Date()): ChartsData {
  const { inputs, g } = readBoard(cfg, now);
  const c = reduceCharts({ items: g.items, awaiting: [...g.awaiting, ...g.paste], prs: inputs.prs, selfReview: cfg.page.selfReviewRepos ?? [], reviewQueueCap: cfg.page.reviewQueueCap, now, tz: cfg.page.tz, days });
  const noteOf = new Map<string, string>();
  for (const [ticket, ids] of Object.entries(inputs.ticketMap)) for (const id of ids) noteOf.set(id, ticket);
  const doneItems = c.doneItems.map(({ ticket, ...d }) => {
    const note = ticket ?? noteOf.get(d.id);
    return note ? { ...d, ticket: toRef(ticketNoteRef(cfg.page, note)) } : d;
  });
  return { ...c, doneItems };
}
