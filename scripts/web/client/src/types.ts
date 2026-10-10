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
  /** The repo is in `self_review_repos`: only the user reviews it, so the board lists it apart from the org's PRs. Older servers omit it. */
  selfReview?: boolean;
  /** When the PR was opened; absent when the server has no date for it. */
  createdAt?: string;
}

export interface Priority { text: string; stream?: string }

export type PrioritiesState =
  | { state: 'ok'; date: string; items: Priority[] }
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
  throughput: { date: string; total: number; byStream: Record<string, number>; ids: string[] }[];
  ageBuckets: { label: string; count: number; ids: string[] }[];
  prMix: { byState: Record<string, number>; byStream: Record<string, Record<string, number>> };
  modelMix: { byFamily: Record<string, number>; source: 'ledger' | 'tokens' };
  /** Finished items in the window, newest first, so a bar can open them; the server caps the list. */
  doneItems: ChartDoneItem[];
  /** Open non-draft PRs by age, split by whether the review-queue cap counts them. Empty when the server predates it. */
  prAge: PrAge;
  /** The review-queue count against its cap, or why there is none. */
  reviewQueue: { count: number; cap: number } | { unavailable: string };
}

export interface ChartDoneItem { id: string; stream: string; text: string; finishedAt: string; ticket?: Ref }
/** A pull request as a chart mark links to it; `createdAt` is absent when the server has none. */
export interface PrRef { repo: string; number: number; title: string; url: string; stream: string; createdAt?: string }
export interface PrAge { buckets: { label: string; inQueue: PrRef[]; other: PrRef[] }[]; unknownAge: { inQueue: PrRef[]; other: PrRef[] }; drafts: number }

/** `ask-busy`: a card is partway through an action (true) or has finished it (false); the page holds redraws until it has. */
export interface AskBusyDetail { busy: boolean }
/** What `ask-resolve` carries: the ask that was just answered and the text the server recorded. Fired once per answer. */
export interface AskResolveDetail { id: string; answer: string }

/** One ticket row on the home base: what is left, the next item of an epic. `prs` are at most three; `prsMore` counts the rest. */
export interface HomeTicket {
  id: string; title: string; status: string; priority: number; ref: Ref; prs: Ref[]; awaitsYou: boolean;
  tracker?: Ref; points?: number; prsMore?: number; quietDays: number | null;
}

/** One epic's progress and what to do next, as the server counted it. */
export interface HomeEpic {
  id: string; title: string; note: Ref; status: string;
  total: number; closed: number; inProgress: number; blocked: number; notStarted: number;
  verify: { required: boolean; verified: number };
  awaiting: number; unknowns: number; quietDays: number | null;
  tracker?: Ref; next?: HomeTicket;
}

/** Something the files cannot tell, with the fix in its text. `epic` names the epic block it counts toward. */
export interface HomeUnknown { kind: string; text: string; ref?: Ref; epic?: string }

/** One link in the rail. The server builds `url` (http, https or `obsidian://open`); the client re-checks it before it becomes an href. */
export interface RailLink { label: string; kind: 'note' | 'tracker' | 'pr' | 'web'; url: string; meta?: string }
export interface RailGroup { group: 'pinned' | 'epics' | 'docs' | 'prs' | 'runbooks'; items: RailLink[]; more: number }

/** The part of `GET /api/streams/:name/home` this client draws; fields it does not read are left out here and ignored on arrival. */
export interface StreamHome {
  stream: string;
  epics: HomeEpic[];
  loose: HomeTicket[];
  left: { inProgress: HomeTicket[]; blocked: HomeTicket[]; notStarted: HomeTicket[]; truncated: number };
  doneMeans: { epic: string; text: string }[];
  links: RailGroup[];
  unknowns: HomeUnknown[];
  freshness: { prs: { fetchedAt: string | null; stale: boolean } };
}
