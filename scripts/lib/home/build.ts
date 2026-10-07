/**
 * The home base of one stream, as a pure function of what the server has already read: the ticket forest, the validated config,
 * the ledger's ticket links, the open PRs and the page settings. No file, clock or process access here.
 *
 * Honest numbers only: every count states what it counts, a percentage is the client's to print beside its fraction, nothing is
 * estimated, and what the files cannot say becomes an `unknown` with its fix in the sentence.
 */
import { createHash } from 'node:crypto';
import { buildForest } from '../vault/tickets.ts';
import type { Forest, Issue, Loaded, Ticket } from '../vault/tickets.ts';
import { obsidianUri } from '../status-page/links.ts';
import { trackerRef } from '../status-page/render.ts';
import type { PageConfig, Pr } from '../status-page/render.ts';
import { PR_STALE_MS } from '../web/state.ts';
import type { Homes } from './config.ts';
import { mapUnits, subtree } from './mapping.ts';
import type { LedgerLink } from './mapping.ts';
import { buildRail } from './rail.ts';
import { prsNaming } from './prs.ts';
import { epicDocs } from './epic-docs.ts';
import type { Doc, Docs } from './docs.ts';
import type { EpicSummary, Ref, StreamHome, TicketRow, Unknown } from './types.ts';

/** A ledger item that names a ticket, reduced to what the home base reads. */
export interface LedgerFact { id: string; stream?: string; ticket: string; state: 'inflight' | 'queued' | 'blocked' | 'ask' | 'done' | 'other' }

export interface HomeInput {
  stream: string;
  /** Every stream the board knows, `other` excluded. */
  streams: string[];
  now: Date;
  /** Null when no vault root is configured. */
  vault: Loaded | null;
  homes: Homes;
  ledger: LedgerFact[];
  prs: Pr[];
  prData: { fetchedAt: Date | null };
  page: PageConfig;
  /** The documents of one project; called only for the projects this stream maps. */
  readDocs: (project: string) => Docs;
}

const ROW_CAP = 200;
const UNKNOWN_CAP = 100;
const QUIET_DAYS = 14;
const DAY_MS = 86_400_000;
const TITLE_MAX = 300;
const DONE_MEANS_MAX = 600;
const POINTED_SHARE = 0.8;
const SCALE_MAX = 5;
const LIST_IDS = 5;

const clip = (s: string, n: number): string => { const t = s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const isOpen = (t: Ticket): boolean => t.status !== 'closed';
const daysSince = (date: string | undefined, now: Date): number | null => {
  const ms = date && /^\d{4}-\d{2}-\d{2}/.test(date) ? Date.parse(`${date.slice(0, 10)}T00:00:00Z`) : NaN;
  return Number.isNaN(ms) ? null : Math.max(0, Math.floor((now.getTime() - ms) / DAY_MS));
};
const quiet = (days: number | null): number | null => (days !== null && days >= QUIET_DAYS ? days : null);

/** The text under a `## <heading>` of a ticket body, up to the next `## `. */
function section(body: string, heading: RegExp): string | null {
  const lines = body.split('\n');
  const at = lines.findIndex((l) => heading.test(l));
  if (at === -1) return null;
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}
/** A closed ticket is verified when its `## Verified` section has a line that starts with an ISO date. */
const isVerified = (t: Ticket): boolean => t.status === 'closed' && (section(t.body, /^## Verified\s*$/i)?.split('\n').some((l) => /^\s*(?:[-*]\s*)?\d{4}-\d{2}-\d{2}\b/.test(l)) ?? false);

type Bucket = 'inProgress' | 'blocked' | 'notStarted';

export function buildStreamHome(inp: HomeInput): StreamHome {
  const { stream, now, page } = inp;
  const unknowns: Unknown[] = inp.homes.warnings.map((text) => ({ kind: 'config-invalid', text }));
  const cfg = inp.homes.streams[stream];
  const base = (over: Partial<StreamHome>): StreamHome => finish({
    stream, generatedAt: now.toISOString(), seq: '', mapping: { source: 'auto', configFound: Boolean(cfg) }, epics: [], loose: [], left: { inProgress: [], blocked: [], notStarted: [], truncated: 0 },
    doneMeans: [], links: [], history: null, unknowns, freshness: { tickets: '', prs: prState(inp), tracker: null }, ...over,
  });
  if (!inp.vault) {
    unknowns.push({ kind: 'no-vault', text: 'No vault root is configured, so no tickets are read. Set vault_root (VAULT_ROOT) and restart the web server.' });
    return base({});
  }
  const forest = buildForest(inp.vault.tickets);
  for (const id of cfg?.epics ?? []) if (!forest.byId.has(id)) unknowns.push({ kind: 'config-invalid', text: `stream-homes.json: epic ${id} is not a ticket in the vault; ignored.` });
  const links: LedgerLink[] = inp.ledger.filter((f) => f.stream && inp.streams.includes(f.stream)).map((f) => ({ stream: f.stream as string, ticket: f.ticket }));
  const mapping = mapUnits(forest, inp.homes, inp.streams, links);
  const mine = [...mapping.claims].filter(([, c]) => c.stream === stream);
  const epicIds = mine.map(([id]) => id).filter((id) => forest.children(id).length > 0 || cfg?.epics.includes(id));
  const looseIds = mine.map(([id]) => id).filter((id) => !epicIds.includes(id));

  const facts = new Map<string, LedgerFact[]>();
  for (const f of inp.ledger) facts.set(f.ticket, [...(facts.get(f.ticket) ?? []), f]);

  const nested = new Set(mapping.units.filter((u) => forest.parentOf.has(u)));   // a nested epic listed in config is its own unit: its tree is not also its parent's
  const own = (id: string): string[] => subtree(forest, id, nested);
  const ctx: Ctx = { inp, forest, facts, own, verifyRequired: (id) => cfg?.done[id] === 'verified' || (forest.byId.get(id)?.labels.includes('verify-required') ?? false) };
  const owned = new Set([...epicIds, ...looseIds].flatMap(own));
  const epics = epicIds.map((id) => epicSummary(ctx, id, unknowns)).sort((a, b) => (newest(ctx, b.id) ?? '').localeCompare(newest(ctx, a.id) ?? '') || a.id.localeCompare(b.id));
  const openOf = (id: string): Ticket[] => own(id).map((x) => forest.byId.get(x) as Ticket).filter((t) => isOpen(t) && t.id !== id);
  const leftTickets = [...epicIds.flatMap(openOf), ...looseIds.map((id) => forest.byId.get(id) as Ticket).filter(isOpen)];
  const left = { inProgress: [] as TicketRow[], blocked: [] as TicketRow[], notStarted: [] as TicketRow[], truncated: 0 };
  const sorted = [...new Map(leftTickets.map((t) => [t.id, t])).values()].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  sorted.forEach((t, i) => { if (i < ROW_CAP) left[bucketOf(ctx, t)].push(row(ctx, t)); else left.truncated += 1; });

  addStreamUnknowns(ctx, unknowns, { stream, mapping, owned, epicIds, forest });
  const projects = [...new Set([...(cfg?.projects ?? []), ...[...epicIds, ...looseIds].map((id) => (forest.byId.get(id) as Ticket).project)])].sort();
  const docs = new Map<string, Doc[]>();
  for (const project of projects) { const d = inp.readDocs(project); docs.set(project, d.docs); for (const n of d.notes) unknowns.push({ kind: 'unreadable-doc', text: n }); }
  // Documents attributed to an epic may sit in any project its tickets live in; those projects are read for the epic's shelf only, so they add nothing to the rail unless the stream maps them.
  const read = new Map<string, Doc[]>(docs);
  const attributed = new Set<string>();
  for (const e of epics) {
    const tree = new Set(own(e.id));
    for (const project of new Set([...tree].map((x) => forest.byId.get(x)?.project).filter((p): p is string => !!p))) {
      if (read.has(project)) continue;
      const d = inp.readDocs(project);
      read.set(project, d.docs);
      for (const n of d.notes) unknowns.push({ kind: 'unreadable-doc', text: n });
    }
    const found = epicDocs({ epic: e.id, tree, epicBody: (forest.byId.get(e.id) as Ticket).body, docs: [...tree].flatMap((x) => forest.byId.get(x)?.project ?? []).filter((p, i, a) => a.indexOf(p) === i).flatMap((p) => read.get(p) ?? []), vaultName: page.vaultName, now });
    e.docs = found.docs;
    for (const p of found.paths) attributed.add(p);
  }
  const railDocs = new Map([...docs].map(([project, ds]) => [project, ds.filter((d) => !attributed.has(d.path))] as const));
  const rail = buildRail({ page, cfg, stream, epics, prs: inp.prs, docs: railDocs }, unknowns);
  for (const e of epics) e.unknowns = unknowns.filter((u) => u.epic === e.id).length;
  const source = !cfg || !cfg.epics.length ? 'auto' : epicIds.every((id) => cfg.epics.includes(id)) ? 'config' : 'mixed';
  return base({
    mapping: { source, configFound: Boolean(cfg) }, epics,
    loose: looseIds.map((id) => forest.byId.get(id) as Ticket).filter(isOpen).slice(0, ROW_CAP).map((t) => row(ctx, t)), left,
    links: rail,
    doneMeans: epicIds.flatMap((id) => { const t = forest.byId.get(id) as Ticket; const text = section(t.body, /^## What done looks like\s*$/i); return text?.trim() ? [{ epic: id, text: clip(text, DONE_MEANS_MAX) }] : []; }),
    unknowns: unknowns.length > UNKNOWN_CAP ? [...unknowns.slice(0, UNKNOWN_CAP), { kind: 'config-invalid' as const, text: `${unknowns.length - UNKNOWN_CAP} more unknowns are not shown.` }] : unknowns,
    freshness: { tickets: inp.vault.newestMtime ? new Date(inp.vault.newestMtime).toISOString() : '', prs: prState(inp), tracker: null },
  });
}

interface Ctx { inp: HomeInput; forest: Forest; facts: Map<string, LedgerFact[]>; own: (id: string) => string[]; verifyRequired: (epic: string) => boolean }

const prState = (inp: HomeInput): { fetchedAt: string | null; stale: boolean } => ({
  fetchedAt: inp.prData.fetchedAt ? inp.prData.fetchedAt.toISOString() : null,
  stale: !inp.prData.fetchedAt || inp.now.getTime() - inp.prData.fetchedAt.getTime() > PR_STALE_MS,
});

function finish(h: StreamHome): StreamHome {
  const { generatedAt, seq, ...body } = h;
  void seq;
  return { ...h, generatedAt, seq: createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 12) };
}

const noteRef = (page: PageConfig, t: Ticket): Ref => (page.vaultName ? { label: t.id, url: obsidianUri(page.vaultName, t.path.replace(/\.md$/, '')) } : { label: t.id });

/** The tracker key a ticket's `external` names (a leading `jira-` dropped, checked against tracker_key_pattern), or null. */
function trackerKey(page: PageConfig, t: Ticket): string | null {
  const key = (t.external ?? '').replace(/^jira-/i, '');
  try { return key && new RegExp(`^(?:${page.trackerKeyPattern})$`).test(key) ? key : null; } catch { return null; }
}

/**
 * open ticket -> bucket. Something real that blocks it wins over progress: a `blocked` status, an unresolved `blocked-by`, or a
 * blocked ledger item all make it blocked, even when its status says in progress. Then a status of in progress, then a ledger item in flight.
 */
function bucketOf(ctx: Ctx, t: Ticket): Bucket {
  const open = ctx.facts.get(t.id) ?? [];
  const unresolved = t.blockedBy.some((b) => { const x = ctx.forest.byId.get(b); return x !== undefined && isOpen(x); });
  if (t.status === 'blocked' || unresolved || open.some((f) => f.state === 'blocked')) return 'blocked';
  return t.status === 'in-progress' || open.some((f) => f.state === 'inflight') ? 'inProgress' : 'notStarted';
}

function row(ctx: Ctx, t: Ticket): TicketRow {
  const key = trackerKey(ctx.inp.page, t);
  const named = prsNaming(ctx.inp.prs, [t.id, key ?? '']);
  return {
    id: t.id, title: clip(t.title, TITLE_MAX), status: t.status, ...(t.points ? { points: t.points } : {}), priority: t.priority, ref: noteRef(ctx.inp.page, t),
    ...(key ? { tracker: trackerRef(ctx.inp.page, key) } : {}), prs: named.shown, ...(named.more ? { prsMore: named.more } : {}), awaitsYou: (ctx.facts.get(t.id) ?? []).some((f) => f.state === 'ask'),
    quietDays: isOpen(t) ? quiet(daysSince(t.updated, ctx.inp.now)) : null,
  };
}

/** The newest `updated` date in a tree, or undefined. */
const newest = (ctx: Ctx, id: string): string | undefined => ctx.own(id).map((x) => ctx.forest.byId.get(x)?.updated).filter((d): d is string => !!d).sort().at(-1);

function epicSummary(ctx: Ctx, id: string, unknowns: Unknown[]): EpicSummary {
  const { forest, inp } = ctx;
  const t = forest.byId.get(id) as Ticket;
  const below = ctx.own(id).filter((x) => x !== id).sort().map((x) => forest.byId.get(x) as Ticket);
  // Totals come from the tree this epic owns, so a nested epic another unit owns is not counted twice; with no such epic they equal forest.roll (and ticket.mjs).
  const roll = { total: below.length, closed: below.filter((b) => b.status === 'closed').length, ptsTotal: below.reduce((n, b) => n + b.points, 0), ptsDone: below.filter((b) => b.status === 'closed').reduce((n, b) => n + b.points, 0) };
  const open = below.filter(isOpen);
  const counts = { inProgress: 0, blocked: 0, notStarted: 0 };
  for (const o of open) counts[bucketOf(ctx, o)] += 1;
  const required = ctx.verifyRequired(id);
  const pointedOpen = open.filter((o) => o.points > 0).length;
  const pointed = open.length > 0 && pointedOpen / open.length >= POINTED_SHARE;
  if (!pointed && below.some((b) => b.points > 0) && open.length) unknowns.push({ kind: 'sparse-points', epic: id, text: `${id}: ${pointedOpen} of ${open.length} open tickets are pointed, so no points-weighted progress is shown.` });
  const big = below.filter((b) => b.points > SCALE_MAX).map((b) => b.id);
  if (big.length) unknowns.push({ kind: 'big-points', epic: id, text: `${id}: ${big.slice(0, LIST_IDS).join(', ')}${big.length > LIST_IDS ? ` and ${big.length - LIST_IDS} more` : ''} ${big.length === 1 ? 'is' : 'are'} pointed above ${SCALE_MAX}; the scale says split ${big.length === 1 ? 'it' : 'them'}.` });
  const unverified = below.filter((b) => b.status === 'closed' && !isVerified(b)).map((b) => b.id);
  if (required && unverified.length) unknowns.push({ kind: 'closed-not-verified', epic: id, text: `${id}: closed but not verified (no dated "## Verified" line): ${unverified.slice(0, LIST_IDS).join(', ')}${unverified.length > LIST_IDS ? ` and ${unverified.length - LIST_IDS} more` : ''}.` });
  if (!section(t.body, /^## What done looks like\s*$/i)?.trim()) unknowns.push({ kind: 'no-done-means', epic: id, text: `${id} has no "What done looks like" section; ask for one, do not guess it.` });
  const key = trackerKey(inp.page, t);
  const rows = open.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const next = rows.find((o) => bucketOf(ctx, o) === 'inProgress') ?? rows.find((o) => bucketOf(ctx, o) === 'notStarted');
  const tree = new Set(below.map((b) => b.id));
  return {
    id, title: clip(t.title, TITLE_MAX), note: noteRef(inp.page, t), ...(key ? { tracker: trackerRef(inp.page, key) } : {}), status: t.status,
    total: roll.total, closed: roll.closed, ...counts,
    verify: { required, verified: below.filter(isVerified).length },
    points: pointed ? { done: roll.ptsDone, total: roll.ptsTotal, pointedOpen, open: open.length } : null,
    ...(next ? { next: row(ctx, next) } : {}),
    awaiting: [...tree, id].reduce((n, x) => n + (ctx.facts.get(x) ?? []).filter((f) => f.state === 'ask').length, 0),
    docs: { groups: [], unattributedRecent: 0 }, unknowns: 0, quietDays: quiet(daysSince(newest(ctx, id), inp.now)),
  };
}

/** The unknowns that belong to the stream as a whole; each epic's own were added by `epicSummary`. */
function addStreamUnknowns(ctx: Ctx, out: Unknown[], s: { stream: string; mapping: ReturnType<typeof mapUnits>; owned: Set<string>; epicIds: string[]; forest: Forest }): void {
  const { forest, inp } = ctx;
  for (const [unit, a] of s.mapping.ambiguous) if (a.streams.includes(s.stream)) out.push({ kind: 'ambiguous-epic', epic: unit, text: `${unit} is claimed equally by ${a.streams.join(' and ')} (${a.rule}); pin it in stream-homes.json.` });
  for (const id of s.owned) {
    const t = forest.byId.get(id) as Ticket;
    if (t.parent && !forest.byId.has(t.parent) && t.parent !== t.id) out.push({ kind: 'missing-parent', text: `${id} names parent ${t.parent}, which is not in the vault; it is treated as top level.` });
  }
  for (const loop of forest.cycles) if (loop.split(' -> ').some((x) => s.owned.has(x))) out.push({ kind: 'parent-cycle', text: `Parent loop ${loop}; one edge is ignored. Fix the parent of the last ticket.` });
  const projects = new Set([...(inp.homes.streams[s.stream]?.projects ?? []), ...[...s.owned].map((id) => (forest.byId.get(id) as Ticket).project)]);
  const issues = (inp.vault?.issues ?? []) as Issue[];
  const mine = issues.filter((i) => !i.path?.split('/')[1] || projects.has(i.path.split('/')[1] as string));   // a vault-wide problem concerns every stream
  for (const i of mine) out.push({ kind: 'unreadable-note', text: i.text });
  if (issues.length > mine.length) out.push({ kind: 'unreadable-note', text: `${issues.length - mine.length} notes in other projects could not be read; a ticket there that is a parent or child of this stream's would be missing from its counts.` });
  const disagree: Unknown[] = [];
  for (const id of s.owned) {
    const t = forest.byId.get(id) as Ticket;
    for (const f of ctx.facts.get(id) ?? []) {
      if (f.state === 'done' && isOpen(t)) disagree.push({ kind: 'ledger-ticket', text: `${id}: ledger item ${f.id} says done, the ticket is still ${t.status}.` });
      else if (!isOpen(t) && ['inflight', 'queued', 'blocked', 'ask'].includes(f.state)) disagree.push({ kind: 'ledger-ticket', text: `${id}: closed here, but ledger item ${f.id} is still open.` });
    }
  }
  out.push(...disagree.slice(0, 10));
  if (disagree.length > 10) out.push({ kind: 'ledger-ticket', text: `${disagree.length - 10} more tickets disagree with the ledger.` });
  const keys = [...s.owned].filter((id) => trackerKey(inp.page, forest.byId.get(id) as Ticket)).length;
  if (keys) out.push({ kind: 'tracker-unread', text: `${keys} linked tracker key${keys === 1 ? '' : 's'}; their status is not read here.` });
}
