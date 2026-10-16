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
  /** The registered script this run-this ask was raised for: its id, linked to the Scripts tab. */
  script?: string;
  /** An ask written with the template; absent on an older free-text ask (legacy layout). `needed` is then the whole one-line question. */
  sections?: AskSections;
  /** What the writer checked before asking. */
  searched?: string;
}
export interface AskSections { blocked: string; context: string[]; options: { option: string; cost: string }[]; links: Ref[] }

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
  /** Checks alone make a PR here ready to merge (the repo is named by `self_review_repos`). Older servers omit it. */
  readyOnChecks?: boolean;
  /** When the PR was opened; absent when the server has no date for it. */
  createdAt?: string;
}

export interface Priority { text: string; stream?: string }

export type PrioritiesState =
  | { state: 'ok'; date: string; items: Priority[] }
  | { state: 'missing' }
  | { state: 'stale'; date: string };

export interface FooterRow { stream: string; asks: number; working: number; stale?: number; queued: number; blocked: number; done: number }

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
  /** In flight with no live lease past `stale_wip_days`; not counted in `working`. */
  stale: WorkItem[];
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

/** A document of an epic. `url` is built by the server (obsidian://open for a note, http(s) for an outside document). */
export interface DocItem { title: string; kind: string; project: string; ticket: string; status?: string; updated?: string; url?: string }
export interface EpicDocs { groups: { kind: string; items: DocItem[]; more: number }[]; unattributedRecent: number }

/** A run of text in a brief; `link.url` was built by the server. */
export interface Inline { text: string; strong?: true; em?: true; code?: true; link?: { url: string; kind: 'web' | 'note' } }
/** A brief as a typed tree: no Markdown and no HTML reach the page. */
export type Block =
  | { type: 'heading'; level: 3 | 4; runs: Inline[] }
  | { type: 'paragraph'; runs: Inline[] }
  | { type: 'quote'; runs: Inline[] }
  | { type: 'list'; ordered: boolean; items: { runs: Inline[]; children: { runs: Inline[] }[] }[] };
export interface EpicBrief { state: 'fresh' | 'stale' | 'missing' | 'too-long' | 'unreadable'; updated?: string; staleBecause?: string[]; ref?: Ref; blocks?: Block[] }

/** One epic's progress and what to do next, as the server counted it. */
export interface HomeEpic {
  id: string; title: string; note: Ref; status: string;
  total: number; closed: number; inProgress: number; blocked: number; notStarted: number;
  verify: { required: boolean; verified: number };
  awaiting: number; unknowns: number; quietDays: number | null;
  tracker?: Ref; next?: HomeTicket;
  /** Open PRs naming the epic or one of its open tickets, at most three; absent from a server that predates it. */
  prs?: Ref[]; prsMore?: number;
  /** Absent from a server that predates epic documents. */
  docs?: EpicDocs; brief?: EpicBrief;
}

/** Something the files cannot tell, with the fix in its text. `epic` names the epic block it counts toward. */
export interface HomeUnknown { kind: string; text: string; ref?: Ref; epic?: string }

/** One link in the rail. The server builds `url` (http, https or `obsidian://open`); the client re-checks it before it becomes an href. */
export interface RailLink { label: string; kind: 'note' | 'tracker' | 'pr' | 'web'; url: string; meta?: string }
export interface RailGroup { group: 'pinned' | 'epics' | 'docs' | 'prs' | 'runbooks'; items: RailLink[]; more: number }

/** A document the user shared for a project. `url` (http, https or `obsidian://open`) is re-checked by the client before it becomes an href; `path` is relative, never absolute. */
export interface SharedDoc { title: string; kind: 'web' | 'note' | 'file'; url?: string; path?: string; why?: string; by: string; project: string; date: string }

/** One written definition of done: an open epic's or a project's "What done looks like", as the server parsed it. */
export interface DoneCriterion { text: string; checked: boolean | null }
export interface DoneSource {
  kind: 'epic' | 'project'; name: string; ref: Ref; items: DoneCriterion[]; prose: string | null; more: number;
  progress: { done: number; total: number; unit: 'checked' | 'tickets' } | null; finished: boolean;
}

/** The part of `GET /api/streams/:name/home` this client draws; fields it does not read are left out here and ignored on arrival. */
export interface StreamHome {
  stream: string;
  epics: HomeEpic[];
  loose: HomeTicket[];
  left: { inProgress: HomeTicket[]; blocked: HomeTicket[]; notStarted: HomeTicket[]; truncated: number };
  doneMeans: { epic: string; text: string }[];
  done: { sources: DoneSource[]; fix: string | null };
  links: RailGroup[];
  shared: SharedDoc[]; sharedMore: number;
  unknowns: HomeUnknown[];
  freshness: { prs: { fetchedAt: string | null; stale: boolean } };
}

/** One open epic as `GET /api/epics` sends it: the counts, the next ticket and the PRs that name it. */
export interface EpicLine {
  id: string; title: string; note: Ref; tracker?: Ref; status: string;
  total: number; closed: number; inProgress: number; blocked: number; notStarted: number;
  awaiting: number; quietDays: number | null;
  next?: { id: string; title: string; ref: Ref };
  prs: Ref[]; prsMore?: number;
}

/** `GET /api/epics`: each stream's open epics, and the epics no stream claims. */
export interface EpicsData { streams: { stream: string; epics: EpicLine[] }[]; unfiled: EpicLine[] }

/** One local branch waiting for a re-review before it is pushed, as `GET /api/local-review` sends it. `where` and the command are container-relative. */
export interface LocalUnit {
  id: string; repo: string; branch: string; head: string; ahead: number; at: string; subject: string;
  where: string; checkedOut: boolean; base: string; command: string;
  verdict: { state: 'ship-it' | 'needs-work' | 'stale' | 'none'; at?: string };
}

/** `GET /api/local-review`. `available: false` carries the reason, so "not read" never looks like "nothing waiting". */
export interface LocalReview { generatedAt: string; available: boolean; reason?: string; units: LocalUnit[]; more: number; notes: string[]; cleanup: LocalCleanup }

/** What the queue leaves out: branches already on their base, branches sharing a ticket key with a base commit, `local/*` overlays, and the paste block that deletes the landed ones. */
export interface LocalCleanup { landed: number; superseded: number; special: number; commands: string[] }

/** What one stream is doing, in a word, from its counts: an ask open, then anything blocked, then work in flight or shipped this week. Never a score. */
export type ProjectStateWord = 'waiting on you' | 'blocked' | 'moving' | 'quiet';

/**
 * One status row on Home, per stream (a tab), naming the vault projects it covers. Every count is a count of rows, never a rate.
 * `status` is the project's CONTEXT `## Now` line, else the stream's first priority today; null when neither says anything.
 */
export interface ProjectRow {
  stream: string; projects: string[];
  status: { text: string; from: 'context' | 'priority' } | null;
  /** Today's priority rank (1 is first), or null when no priority today names the stream. */
  rank: number | null;
  asks: number; inflight: number; blocked: number; prs: number;
  /** Whole days since the oldest open ask, in-flight or blocked item began; null with nothing open. */
  oldestOpenDays: number | null;
  /** The newest page day in the weekly window on which the stream finished something, or null for none. */
  lastShipped: string | null;
  /** Finished in the last seven page days, today included. */
  shippedWeek: number;
  state: ProjectStateWord;
}

/** A link Home lists: a pin from `stream-homes.json`, or a project's CONTEXT or library INDEX note. The URL is built by the server. */
export interface HomeLink { label: string; kind: 'pin' | 'context' | 'library'; stream: string; url: string }

/** Items finished in one seven-day period, `start` its first page day; the last period ends today. */
export interface WeekCount { start: string; total: number; byStream: Record<string, number> }

/** `GET /api/projects`: Home's status rows, important links and done-per-week series. No absolute path anywhere. */
export interface ProjectsData { generatedAt: string; today: string; rows: ProjectRow[]; links: HomeLink[]; weeks: WeekCount[] }

/** One side of a develop/staging pair. The URL is the server's; the client re-checks it before it becomes a link. */
/** `merged` is set only on a develop side kept beside its still-open staging twin after the develop PR merged. */
export interface OpenPrSide { number: number; url: string; merged?: boolean }
/**
 * Both sides of a twin-flow PR, in one place so a missing side is visible.
 * Absent when the PR's base is neither develop nor staging. A missing side is omitted, not a guess.
 */
export interface OpenPrSides { develop?: OpenPrSide; staging?: OpenPrSide }

/** One open PR in the Open PRs tab. `review` is none for a PR nobody has decided on; `twins` are the other PRs of the repo on the same head branch (or its develop/staging pair). */
export interface OpenPrRow {
  number: number; title: string; url: string; base: string; head: string; isDraft: boolean;
  review: 'approved' | 'changes-requested' | 'none'; unresolved: number; mergeable: 'mergeable' | 'conflicting' | 'unknown';
  twins: number[]; sides?: OpenPrSides; ageDays?: number; ticket?: { label: string; url?: string };
  /** CI conclusion from the PR cache. Absent on a server that predates the redesigned board. */
  ci?: string;
  /** Checks alone make this PR ready to merge (`self_review_repos` names its repo). */
  readyOnChecks?: boolean;
  /** Logins whose latest review is an approval; absent on a server without review history. */
  approvers?: string[];
  /** The parent PR this one is stacked on, when both are open. */
  stackedOn?: number;
  /** A staging PR that waits on its develop twin (`number` and `url` absent when no twin was found). Absent when it need not wait. */
  waitsOnDevelop?: { number?: number; url?: string };
}
export interface OpenPrsRepo { repo: string; count: number; prs: OpenPrRow[] }
/** `team` repos are reviewed by others; `self-review` repos only by the user (`self_review_repos`). */
export interface OpenPrsGroup { id: 'team' | 'self-review'; label: string; count: number; repos: OpenPrsRepo[] }
export interface OpenPrsData {
  generatedAt: string;
  prData: { fetchedAt: string | null; stale: boolean; failure?: string };
  total: number; groups: OpenPrsGroup[];
}
/** One open teammate PR in the Others' PRs tab (`GET /api/others-prs`). `youAsked` is true when the user is a requested reviewer. */
export interface OthersPrRow {
  repo: string; number: number; title: string; url: string; author: string; authorName?: string; base: string; updatedAt: string; openedAt?: string; ageDays?: number;
  youAsked: boolean; handsOff?: boolean; /** Newer fields, absent from an older server: read as clean. */ isDraft?: boolean; ci?: 'pass' | 'fail' | 'pending' | 'none'; conflicting?: boolean; block?: 'release' | 'blocked'; awaitingAuthor?: boolean; notAsked?: boolean; /** When the latest ask for review was made (Slack post or reply, else the PR's opening); stale: no activity inside the active window, with the reason. */ askedAt?: string; stale?: boolean; staleWhy?: string; review: 'review-required' | 'approved' | 'changes-requested'; unresolved: number; copilotThreads: number;
}
/** `prData.fetchedAt` is null until the first read; `failure` says why the last read did not refresh the list. Rows run newest activity first. */
export interface OthersPrsData { generatedAt: string; prData: { fetchedAt: string | null; stale: boolean; failure?: string }; total: number; prs: OthersPrRow[] }

/** Where the PR refresh stands: `locked` means another rebuild held the page lock. */
export interface PrsRefreshStatus { state: 'idle' | 'running' | 'done' | 'failed' | 'locked'; startedAt?: string; finishedAt?: string; message?: string }

/** One cost metric for `GET /api/cost`: today's value against the 7-day median, its limit, and the last days as a series. Numbers are null where there is none (JSON has no NaN). */
export interface CostMetric {
  name: string; fmt: 'n' | 'pct' | 'ratio' | 'usd';
  today: number | null; median7: number | null; vs7: number | null; regression: boolean;
  limit: number | null; dir: 'max' | 'min' | null; status: 'PASS' | 'MISS' | '-';
  /** One entry per calendar day ending at `date`; null on a day with no row. */
  series: (number | null)[];
}
/** The model mix of one day's orchestrator read, as fractions, with the targets it is held to (Opus at most `opusMax`, Haiku at least `haikuMin`). */
export interface CostMix { opus: number | null; sonnet: number | null; haiku: number | null; opusMax: number; haikuMin: number }
export interface CostExperiment { id: string; practice: string; metric: string; threshold: string; start: string; status: string; result: string }
/** `GET /api/cost`. `state` is `empty` when there is no history to read (the `reason` says why); `stale` when the newest day is before yesterday. */
export interface CostData {
  state: 'ok' | 'empty'; reason?: string; date: string | null; stale: boolean; days: string[];
  metrics: CostMetric[]; regressions: string[]; mix: CostMix | null;
  running: CostExperiment[]; recent: CostExperiment[]; today: CostExperiment | null;
}
