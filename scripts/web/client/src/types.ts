/**
 * The JSON contract between the Podium server (a later slice) and this client, from the design note's endpoint
 * shapes. Types only, no DOM references, so server code can `import type` from here.
 */

/** A link the server built; the client never builds a URL from text. */
export interface Ref { label: string; url?: string }

export interface AskLinks { note?: Ref; tracker: Ref[]; prs: Ref[] }

export interface AskCard {
  id: string;
  stream: string;
  needed: string;
  context: string;
  ageDays: number;
  date: string;
  ts: string;
  links: AskLinks;
  /** Decision fields, present only on an ask that carries them; `default` only on a two-way door, `by` already formatted. */
  recommend?: string;
  door?: 'one-way' | 'two-way';
  default?: string;
  by?: string;
  class?: string;
  /** A run-this ask: the block file to run, shown and never read by the page. */
  paste?: string;
}

export interface WorkItem { id: string; stream: string; text: string; ticket?: Ref; links: AskLinks; model?: string; since: string }
export interface BlockedItem extends WorkItem { gate?: string }
export interface DoneItem extends WorkItem { closedAt: string }
export interface DeferredItem extends WorkItem { until: string }

export interface PrCard {
  repo: string; short: string; number: number; title: string; url: string; stream: string;
  base: string; head: string; isDraft: boolean; ci: string; mergeable: string; mergeStateStatus: string;
  unresolved: number; review: string; flags: string[]; twinOf?: number; stackedOn?: number;
}

export type PrioritiesState =
  | { state: 'ok'; date: string; items: { text: string; stream?: string }[] }
  | { state: 'missing' }
  | { state: 'stale'; date: string };

export interface FooterRow { stream: string; asks: number; working: number; queued: number; blocked: number; done: number }

export interface PodiumState {
  generatedAt: string;
  today: string;
  tz: string;
  streams: string[];
  priorities: PrioritiesState;
  /** `priorities_max`: how many priorities the list may hold. */
  prioritiesMax: number;
  footer: FooterRow[];
  prData: { fetchedAt: string | null; stale: boolean };
  asks: AskCard[];
  working: WorkItem[];
  queued: WorkItem[];
  blocked: BlockedItem[];
  done: DoneItem[];
  deferred: DeferredItem[];
  prs: PrCard[];
  seq: string;
  /** Client-slice addition: Markdown for sections not yet converted to JSON, keyed by tab id. */
  fragments?: Record<string, string>;
}

export interface ChartsData {
  days: string[];
  throughput: { date: string; total: number; byStream: Record<string, number> }[];
  ageBuckets: { label: string; count: number; ids: string[] }[];
  prMix: { byState: Record<string, number>; byStream: Record<string, Record<string, number>> };
  modelMix: { byFamily: Record<string, number>; source: 'ledger' | 'tokens' };
}

/** `ask-busy`: a card is partway through an action (true) or has finished it (false); the page holds redraws until it has. */
export interface AskBusyDetail { busy: boolean }
/** What `ask-resolve` carries; this slice writes nothing to the network. */
export interface AskResolveDetail { id: string; answer: string }
