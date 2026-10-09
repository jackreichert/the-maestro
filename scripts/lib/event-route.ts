/**
 * Event routing: which orchestrator window an inbox event is for, so two windows on one ledger do not eat each other's events.
 *
 * There is no second ownership table. An event names a repo (`fields.repo`); the stream config (`status_repo_streams`, repo short name
 * to stream) says which stream that repo belongs to; and the window that holds a live lease (lib/journal/leases.ts) on an open item
 * of that stream, or on an open item whose own `repo` is that repo, owns the event. When several windows qualify the one whose lease
 * runs longest wins (ties by window id), so every reader of one ledger computes the same owner.
 *
 * An event with no owner (no repo, no live lease, or no ledger configured) is unowned and goes to whichever window asks first.
 * An owner whose lease lapsed stops being an owner at that moment, so a dead window's events fall to the others and none is dropped.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { InboxEntry } from './event-inbox.ts';
import { fold, isOpen, mapStreamWith, parseLedger, readRegistry } from './ledger-core.ts';
import type { LedgerRow, RegistryLookup } from './ledger-core.ts';
import { foldLeases } from './journal/leases.ts';
import type { Lease } from './journal/leases.ts';

/** What the router reads: the ledger rows, the stream registry, the repo-to-stream config and the clock. */
export interface RouteContext {
  rows: readonly LedgerRow[];
  registry: RegistryLookup | null;
  repoStreams: Record<string, string>;
  nowMs: number;
}

const shortRepo = (repo: string | undefined): string => (repo ?? '').split('/').pop()!.toLowerCase();

type OpenLease = { lease: Lease; stream?: string; repo: string };
const leaseCache = new WeakMap<RouteContext, OpenLease[]>();

/** The live leases on open items, each with the item's stream (registry-mapped) and repo, ready to match against events. Folds the ledger once per context. */
function openLeases(ctx: RouteContext): OpenLease[] {
  let out = leaseCache.get(ctx);
  if (!out) leaseCache.set(ctx, (out = foldOpenLeases(ctx)));
  return out;
}

function foldOpenLeases(ctx: RouteContext): OpenLease[] {
  const { items } = fold([...ctx.rows], ctx.registry);
  const open = new Map(items.filter((i) => isOpen(i) && i.id).map((i) => [i.id as string, i]));
  const out: OpenLease[] = [];
  for (const [item, lease] of foldLeases(ctx.rows)) {
    const it = open.get(item);
    if (it && lease.until > ctx.nowMs) out.push({ lease, stream: it.stream, repo: shortRepo(typeof it.repo === 'string' ? it.repo : undefined) });
  }
  return out;
}

/** The window that owns this event now, or undefined when it is unowned. */
export function ownerOf(entry: Pick<InboxEntry, 'fields'>, ctx: RouteContext): string | undefined {
  const repo = shortRepo(entry.fields.repo);
  if (!repo) return undefined;
  const configured = Object.entries(ctx.repoStreams).find(([r]) => r.toLowerCase() === repo)?.[1];
  const stream = configured === undefined ? undefined : mapStreamWith(ctx.registry, configured);
  const mine = openLeases(ctx).filter((l) => l.repo === repo || (stream !== undefined && l.stream === stream));
  mine.sort((a, b) => b.lease.until - a.lease.until || (a.lease.holder < b.lease.holder ? -1 : 1));
  return mine[0]?.lease.holder;
}

/** A router over the project's ledger on disk, or null when no ledger root is set or readable (then every event is unowned). Reads once per call of `ownerOf`'s caller: build it per poll. */
export function loadRouteContext(root: string, project: string, repoStreams: Record<string, string>, nowMs: number = Date.now()): RouteContext | null {
  if (!root) return null;
  const dir = join(root, 'Projects', project);
  const ledger = join(dir, 'Journal', 'ledger.jsonl');
  if (!existsSync(ledger)) return null;
  const rows = parseLedger(readFileSync(ledger, 'utf8'));
  return { rows, registry: readRegistry(join(dir, 'streams.json')), repoStreams, nowMs };
}

/** True when `window` has seen the event: its own `seen`/`handled` mark, or a mark that named no window (written before windows were recorded; that one is every window's). */
export const seenByWindow = (e: InboxEntry, window: string): boolean => e.seenWindows.includes(window) || e.seenAnonymous === true;

/**
 * Is this event for `window` to take? Never one that is handled. An owned event only to its owner, and only until the owner has
 * seen it. An unowned event to anyone while no window at all has seen it (the first window to mark it takes it).
 */
export function deliverableTo(e: InboxEntry, window: string, owner: string | undefined): boolean {
  if (e.handled) return false;
  if (owner !== undefined) return owner === window && !seenByWindow(e, window);
  return !e.seen;
}
