/**
 * Review-miss harvest, pure logic: turn a PR's review threads, review bodies and issue comments into distinct findings, with
 * mechanical hints that a cheap model then confirms (playbooks/review-miss-harvest.md). Nothing here touches the network or disk.
 *
 * A hint is never a verdict. `planning`, `ci`, `outside-diff` and the coverage lines say what the text looks like; the triage
 * record, written by the runner, says what it is.
 */
import { createHash } from 'node:crypto';
import { scanText } from './secret-scan.ts';
import { isBotLogin } from './github-bots.ts';

export type Kind = 'copilot' | 'aikido' | 'human';
export type FateHint = 'fixed' | 'deferred' | 'declined' | 'resolved' | 'open';

/** One comment as read from GitHub, before dedupe. `srcId` is the GraphQL node id, so a re-read never counts twice. */
export interface Item { srcId: string; pr: string; change: string; kind: Kind; author: string; path: string; text: string; fate: FateHint; outsideDiff: boolean }

/** A distinct finding: every item that said the same thing, across twin PRs and repeat passes. */
export interface Finding {
  id: string; seen: string; kind: Kind; path: string; gist: string; prs: string[]; changes: string[]; threads: number; srcIds: string[];
  fate: FateHint; hints: string[];
}

export interface Triage {
  id: string; klass: 'mithril' | 'planning' | 'dropped'; fate: FateHint; real: boolean; why?: string;
  coverage?: 'covered' | 'partial' | 'not-covered'; skill?: string; cite?: string; category?: string; candidate?: string;
}

const STOP = new Set('this that with from have will would should could does which when then than into also only more some what where there their they them been being were here such each other about after before because while your you the and for are not but can its it\'s'.split(' '));
const WITHHELD = '[withheld: PHI or secret shape]';

/** A code-level gist: fences, suggestions, links and addresses removed, whitespace folded, cut at 240. A scan hit withholds the whole text. */
export function gistOf(body: string): string {
  const flat = body.replace(/```[\s\S]*?```/g, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/https?:\/\/\S+/g, ' ').replace(/\S+@\S+\.\S+/g, ' ').replace(/\s+/g, ' ').trim();
  if (scanText(flat).length) return WITHHELD;
  return flat.length > 240 ? `${flat.slice(0, 237)}...` : flat;
}

/** Content words of a text, for similarity and for the coverage grep. */
export const tokens = (text: string): Set<string> =>
  new Set((text.toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) ?? []).filter((w) => !STOP.has(w)));

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let both = 0;
  for (const t of a) if (b.has(t)) both++;
  return both / (a.size + b.size - both);
}

const base = (p: string): string => p.split('/').pop() ?? p;
const SAME_PATH = 0.6;
const ANY_PATH = 0.8;

/** True when two findings say the same thing: the same file and mostly the same words, or nearly the same words anywhere. */
export function sameFinding(a: { path: string; gist: string }, b: { path: string; gist: string }): boolean {
  if (a.gist === WITHHELD || b.gist === WITHHELD) return false;   // withheld text says nothing, so two of them are never the same finding
  const j = jaccard(tokens(a.gist), tokens(b.gist));
  return base(a.path) === base(b.path) ? j >= SAME_PATH : j >= ANY_PATH;
}

const FATE_RANK: FateHint[] = ['fixed', 'deferred', 'declined', 'resolved', 'open'];
const betterFate = (a: FateHint, b: FateHint): FateHint => (FATE_RANK.indexOf(a) <= FATE_RANK.indexOf(b) ? a : b);

/** Short stable id: the same first-seen gist and path always get the same id. */
export const idOf = (kind: string, path: string, gist: string): string => createHash('sha1').update(`${kind}|${path}|${gist}`).digest('hex').slice(0, 6);

// Planning misses: the work was possible with prior art the author did not look for (a core helper, a sibling EMR's approach).
const PLANNING = [
  /\b(already|existing)\b.{0,60}\b(helper|util(?:ity|ities)?|function|module|constant|client|wrapper|shared)\b/i,
  /\bcore\b.{0,40}\b(already|has|have|provides?|exports?)\b/i,
  /\b(sibling|other|another)\s+(emr|scraper|adapter|integration|connector|provider)s?\b/i,
  /\b(duplicat\w+|re-?implement\w*|reinvent\w*)\b.{0,40}\b(existing|helper|util\w*|logic|function|implementation)\b/i,
  /\bdoes (this|it|that) differently\b/i,
];
const CI_CATCHES = /\b(lint(?:er)?|eslint|ruff|mypy|prettier|flake8|type[- ]?check(?:er)?|formatting|import order|unused (?:import|variable))\b/i;
const PRE_EXISTING = /\b(pre-?existing|already (?:on|in) (?:develop|main|staging)|not part of this (?:pr|change))\b/i;

export const isPlanningMiss = (text: string): boolean => PLANNING.some((p) => p.test(text));
export const isCiCatchable = (text: string): boolean => CI_CATCHES.test(text);

/** The mechanical hints for an item: which not-a-mithril-miss or planning-miss shapes its text or place matches. */
export function hintsFor(item: Pick<Item, 'text' | 'outsideDiff'>): string[] {
  const out: string[] = [];
  if (isPlanningMiss(item.text)) out.push('planning');
  if (isCiCatchable(item.text)) out.push('ci');
  if (item.outsideDiff || PRE_EXISTING.test(item.text)) out.push('pre-existing');
  return out;
}

/** Fate from what Jack's reply says. A hint only: the thread state and one reply cannot tell a declined thing from a fixed one for sure. */
export function fateFrom(resolved: boolean, jackReplies: string[]): FateHint {
  const said = jackReplies.join(' ').toLowerCase();
  if (/\b(false positive|not an issue|by design|intended|won'?t|declin|out of scope|pre-?existing|not a bug)\b/.test(said)) return 'declined';
  if (/\b(defer|follow-?up|later|ticket|separate pr)\b/.test(said)) return 'deferred';
  if (/\b(fixed|done|addressed|good catch|updated|pushed)\b/.test(said)) return 'fixed';
  return resolved ? 'resolved' : 'open';
}

const authorKind = (login: string): Kind => (/copilot/i.test(login) ? 'copilot' : /aikido/i.test(login) ? 'aikido' : 'human');

interface Node { id?: string; body?: string; author?: { login?: string } | null }
interface Thread { id?: string; isResolved?: boolean; path?: string; comments?: { nodes?: Node[] } }
export interface PrNode {
  headRefName?: string; author?: { login?: string } | null; files?: { pageInfo?: { hasNextPage?: boolean }; nodes?: { path: string }[] };
  reviewThreads?: { nodes?: Thread[] }; reviews?: { nodes?: Node[] }; comments?: { nodes?: Node[] };
}

/**
 * Items from one PR node. Inline threads come from the first comment's author; later comments by `jack` only set the fate and are never stored.
 * Review bodies and issue comments count for humans and Aikido only: a Copilot overview body repeats its inline threads. Jack's own comments are skipped.
 */
export function itemsFrom(pr: PrNode, ref: string, jack: string): Item[] {
  const files = pr.files?.pageInfo?.hasNextPage ? null : new Set((pr.files?.nodes ?? []).map((f) => f.path));
  const change = `${ref.split('#')[0]}:${pr.headRefName ?? ref}`;
  const mine = (n: Node | undefined): boolean => (n?.author?.login ?? '').toLowerCase() === jack.toLowerCase();
  const out: Item[] = [];
  for (const t of pr.reviewThreads?.nodes ?? []) {
    const [first, ...rest] = t.comments?.nodes ?? [];
    const login = first?.author?.login ?? '';
    if (!first?.id || !login || mine(first)) continue;
    const text = gistOf(first.body ?? '');
    out.push({ srcId: first.id, pr: ref, change, kind: authorKind(login), author: login, path: t.path ?? '', text, outsideDiff: !!t.path && !!files && !files.has(t.path), fate: fateFrom(!!t.isResolved, rest.filter(mine).map((n) => n.body ?? '')) });
  }
  const loose = [...(pr.reviews?.nodes ?? []), ...(pr.comments?.nodes ?? [])];
  for (const n of loose) {
    const login = n.author?.login ?? '';
    const kind = authorKind(login);
    if (!n.id || !login || mine(n) || kind === 'copilot' || (kind === 'human' && isBotLogin(login)) || (n.body ?? '').trim().length < 20) continue;
    out.push({ srcId: n.id, pr: ref, change, kind, author: login, path: '', text: gistOf(n.body ?? ''), outsideDiff: false, fate: 'open' });
  }
  return out;
}

/** Folds items into the findings so far. An item whose `srcId` is already counted is skipped, so a re-read changes nothing. Returns a new list. */
export function mergeItems(existing: Finding[], items: Item[], today: string): Finding[] {
  const all = existing.map((f) => ({ ...f }));
  for (const it of items) {
    if (all.some((f) => f.srcIds.includes(it.srcId))) continue;
    const hit = all.find((f) => f.kind === it.kind && sameFinding(f, { path: it.path, gist: it.text }));
    if (hit) {
      hit.threads += 1; hit.srcIds.push(it.srcId); hit.fate = betterFate(hit.fate, it.fate);
      if (!hit.prs.includes(it.pr)) hit.prs.push(it.pr);
      if (!hit.changes.includes(it.change)) hit.changes.push(it.change);
      hit.hints = [...new Set([...hit.hints, ...hintsFor(it)])];
    } else {
      all.push({ id: idOf(it.kind, it.path, it.text), seen: today, kind: it.kind, path: it.path, gist: it.text, prs: [it.pr], changes: [it.change], threads: 1, srcIds: [it.srcId], fate: it.fate, hints: hintsFor(it) });
    }
  }
  return all;
}

/** The skill lines that share the most words with a finding, for the coverage call. `skills` maps a skill name to its lines. */
export function coverageHints(gist: string, skills: Record<string, string[]>, top = 2): { skill: string; shared: number; line: string }[] {
  const want = tokens(gist);
  const scored: { skill: string; shared: number; line: string }[] = [];
  for (const [skill, lines] of Object.entries(skills)) {
    for (const line of lines) {
      let shared = 0;
      for (const t of tokens(line)) if (want.has(t)) shared++;
      if (shared >= 3) scored.push({ skill, shared, line: line.trim().slice(0, 160) });
    }
  }
  return scored.sort((a, b) => b.shared - a.shared).slice(0, top);
}

/** Why a triaged finding is not a mithril miss, or null when it counts. */
export const dropReason = (t: Triage): string | null => (t.klass === 'dropped' || !t.real ? t.why ?? 'not a real miss' : null);

/** `ready` when two or more distinct changes (twin copies are one change) or two or more repos carry the evidence; otherwise `watching`. */
export function candidateStatus(findings: Finding[]): 'ready' | 'watching' {
  const changes = new Set(findings.flatMap((f) => f.changes));
  const repos = new Set(findings.flatMap((f) => f.prs.map((p) => p.split('#')[0])));
  return findings.length >= 2 && (changes.size >= 2 || repos.size >= 2) ? 'ready' : 'watching';
}
