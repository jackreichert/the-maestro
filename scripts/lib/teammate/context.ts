/**
 * The summary a teammate review carries, in six parts and this order: What it does, Core logic (permalinks), Tests, Ticket match, Suggestions, Compliment.
 * The first four are the `ReviewContext` the reviewer reports; Suggestions come from the review's inline comments and the Compliment from the review itself.
 * `submit` requires the context on every draft, approvals included. A part is never left out: it is given, or it says "not checked: <why>" (`contextProblem`
 * refuses anything else). The context is stored on the draft as fields (so the Podium renders it), and `renderSummary` writes the same parts as the markdown body.
 *
 * Reading the ticket: `findJiraKeys` picks the key out of the PR's title, branch and body (in that order). `readJira` does one read-only GET against
 * the Jira REST API with credentials from the environment (names only: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN; values are never printed or
 * returned). Without them, or when Jira refuses, it says `unreadable` with a short reason, and the draft says so plainly: the ticket is never guessed.
 * Nothing here writes to Jira or GitHub.
 */
export const VERDICTS = ['does what it says', 'partly', 'does something else'] as const;
export type Verdict = (typeof VERDICTS)[number];
export const MAX_CORE_CHANGES = 5;
const MAX_LIST = 6;
const MAX_ITEM = 200;

/** How the PR compares with its ticket. `read` carries a verdict; `none` (no key found) and `unreadable` (key found, Jira could not be read) never do. */
export interface TicketMatch { status: 'read' | 'none' | 'unreadable'; key?: string; verdict?: Verdict; missing?: string[]; extra?: string[]; reason?: string }
/** One place where behaviour changes: lines `start`..`end` of `path` on the PR head, with a short label for the link. */
export interface CoreChange { path: string; start: number; end: number; label: string }
/**
 * What the tests say. `reported`: how many tests the PR adds or changes (`count`), what was run (`ran`) and what is only mocked or checked by hand
 * (`gaps`, empty when nothing is). `not-checked`: the tests were not looked at or run, and `reason` says why.
 */
export interface TestsReport { status: 'reported' | 'not-checked'; count?: number; ran?: string; gaps?: string[]; reason?: string }
export interface ReviewContext { summary: string; core: CoreChange[]; tests: TestsReport; ticket: TicketMatch }
/** A suggestion as the summary lists it: one line, with the place it is anchored to. */
export interface SuggestionLine { blocking: boolean; path: string; line: number; text: string }

/** Things shaped like a Jira key that are not one. */
const NOT_KEYS = new Set(['UTF-8', 'UTF-16', 'ISO-8601', 'SHA-1', 'SHA-256', 'SHA-512', 'ES-5', 'HTTP-2', 'MD-5']);
const KEY = /\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g;
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Jira keys in the order they are most trustworthy: the title, then the branch name, then the body. Unique, first seen first. */
export function findJiraKeys(o: { title?: string; branch?: string; body?: string }): string[] {
  const seen = new Set<string>();
  for (const t of [o.title, o.branch, o.body]) for (const m of (t ?? '').match(KEY) ?? []) if (!NOT_KEYS.has(m)) seen.add(m);
  return [...seen];
}

/** `https://github.com/<owner>/<repo>/blob/<headSha>/<path>#L<a>-L<b>`: the exact lines at the PR head, so the link cannot drift when the branch moves. */
export function permalink(repo: string, head: string, c: CoreChange): string {
  const path = c.path.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${repo}/blob/${head}/${path}#L${c.start}-L${c.end}`;
}

/** Why the context is not acceptable, or null. `diff` is the RIGHT-side lines of the head's diff by path: a core change must sit on lines the PR touches. */
export function contextProblem(c: ReviewContext | undefined, diff: ReadonlyMap<string, ReadonlySet<number>>): string | null {
  if (!c || typeof c !== 'object') return 'a review needs its context: what the PR does, the ticket match and the core logic changes';
  if (str(c.summary).split(/\s+/).length < 6) return 'say what the PR does in a few plain lines';
  const t = c.ticket;
  if (!t || !['read', 'none', 'unreadable'].includes(t.status)) return 'the ticket match needs a status: read, none or unreadable';
  if (t.status === 'read') {
    if (!/^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/.test(str(t.key))) return 'a ticket that was read needs its Jira key';
    if (!(VERDICTS as readonly string[]).includes(str(t.verdict))) return `the ticket verdict is one of: ${VERDICTS.join(', ')}`;
  } else if (t.verdict !== undefined) return 'a verdict needs a ticket that was read; with no ticket or an unreadable one, say so and give none';
  if (t.status === 'unreadable' && !/^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/.test(str(t.key))) return 'an unreadable ticket still needs the key that was found';
  if (!Array.isArray(c.core) || c.core.length < 1 || c.core.length > MAX_CORE_CHANGES) return `name 1 to ${MAX_CORE_CHANGES} core logic changes`;
  for (const k of c.core) {
    const lines = diff.get(str(k.path));
    if (!lines || !Number.isSafeInteger(k.start) || !Number.isSafeInteger(k.end) || k.start < 1 || k.end < k.start || k.end - k.start > 80) return 'a core logic change needs a path and a line range of at most 80 lines';
    if (!lines.has(k.start) || !lines.has(k.end)) return `core logic change ${k.path}:${k.start}-${k.end} is not on lines the PR changes`;
    const label = str(k.label);
    if (label.length < 4 || label.length > 90) return 'each core logic change needs a short label (4 to 90 characters) for its link';
  }
  const tr = c.tests;
  if (!tr || !['reported', 'not-checked'].includes(tr.status)) return 'the tests part needs a status: reported, or not-checked with the reason';
  if (tr.status === 'not-checked') { if (str(tr.reason).length < 4) return 'tests that were not checked need the reason'; } else {
    if (!Number.isSafeInteger(tr.count) || (tr.count as number) < 0) return 'reported tests need a count (0 when the PR adds none)';
    if (str(tr.ran).length < 4) return 'reported tests need what was run (or "nothing run" with the reason)';
    if (!Array.isArray(tr.gaps)) return 'reported tests need `gaps`: what is only mocked or checked by hand ([] when nothing is)';
  }
  return null;
}

const bullets = (items: string[] | undefined): string[] => (items ?? []).map((i) => clip(str(i), MAX_ITEM)).filter(Boolean).slice(0, MAX_LIST);

/** The ticket paragraph: the verdict with what is missing and what is extra, or a plain statement that there was no ticket or it could not be read. */
export function renderTicket(t: TicketMatch): string {
  if (t.status === 'none') return '**Ticket match:** I could not find a Jira key in the title, branch or description, so I did not check this against a ticket.';
  if (t.status === 'unreadable') return `**Ticket match (${t.key}):** I found the ticket but could not read it from Jira${str(t.reason) ? ` (${clip(str(t.reason), MAX_ITEM)})` : ''}, so I did not check the PR against it.`;
  const out = [`**Ticket match (${t.key}):** ${t.verdict === 'does what it says' ? 'does what it says' : t.verdict === 'partly' ? 'partly matches' : 'does something else'}.`];
  const missing = bullets(t.missing);
  const extra = bullets(t.extra);
  out.push(missing.length ? `Missing from the PR:\n${missing.map((i) => `- ${i}`).join('\n')}` : 'Nothing from the ticket is missing.');
  out.push(extra.length ? `Extra in the PR:\n${extra.map((i) => `- ${i}`).join('\n')}` : 'Nothing extra beyond the ticket.');
  return out.join('\n');
}

/** The tests part as plain text: count, what ran, and what is only mocked or manual; or "not checked" with the reason. */
export function testsText(t: TestsReport): string {
  if (t.status === 'not-checked') return `Not checked: ${clip(str(t.reason), MAX_ITEM)}.`;
  const gaps = bullets(t.gaps);
  const n = t.count as number;
  return `${n} ${n === 1 ? 'test' : 'tests'} added or changed. Ran: ${clip(str(t.ran), MAX_ITEM)}. ${gaps.length ? `Only mocked or checked by hand: ${gaps.join('; ')}.` : 'Nothing found that is only mocked or checked by hand.'}`;
}
export const renderTests = (t: TestsReport): string => `**Tests:** ${testsText(t).replace(/^Not checked/, 'not checked')}`;

/** The ticket match as plain text on one line (the draft body carries the bulleted form). */
export const ticketText = (t: TicketMatch): string => renderTicket(t).replace(/^\*\*Ticket match( \(([^)]*)\))?:\*\* ?/, (_m, _a, key) => (key ? `${key}: ` : '')).replace(/\n- /g, ' - ').replace(/\n/g, ' ');

/** What the Podium card shows for a stored context: plain text parts and the core links. Tolerates a context saved in an older shape, saying "not recorded". */
export interface SummaryView { summary: string; core: { label: string; path: string; start: number; end: number; url: string }[]; tests: string; ticket: string }
export function summaryView(repo: string, head: string, c: Partial<ReviewContext>): SummaryView {
  const none = 'Not recorded for this draft.';
  const core = (Array.isArray(c.core) ? c.core : []).filter((k) => k && typeof k.path === 'string' && Number.isSafeInteger(k.start) && Number.isSafeInteger(k.end))
    .map((k) => ({ label: clip(str(k.label) || str((k as { text?: unknown }).text) || `${k.path}`, 90), path: k.path, start: k.start, end: k.end, url: permalink(repo, head, k) }));
  return { summary: str(c.summary) || none, core, tests: c.tests ? testsText(c.tests) : none, ticket: c.ticket ? ticketText(c.ticket) : none };
}

const oneLine = (s: string): string => clip(s.replace(/\s+/g, ' ').trim(), MAX_ITEM);

/** The suggestions part: numbered, one line each, blocking first and marked; "None." when there are no comments. Never omitted. */
export function renderSuggestions(items: readonly SuggestionLine[]): string {
  if (!items.length) return '**Suggestions**\nNone.';
  return `**Suggestions**\n${items.map((i, n) => `${n + 1}. ${i.blocking ? 'Blocking' : 'Non-blocking'}, \`${i.path}:${i.line}\`: ${oneLine(i.text)}`).join('\n')}`;
}

/** The core logic lines for a context: label, range and permalink. */
export function coreLinks(repo: string, head: string, c: ReviewContext): { label: string; path: string; start: number; end: number; url: string }[] {
  return c.core.map((k) => ({ label: clip(str(k.label), 90), path: k.path, start: k.start, end: k.end, url: permalink(repo, head, k) }));
}

/**
 * The summary as the markdown the review body carries, parts one to five in order (the compliment and the closing line follow it). Call `contextProblem` first.
 */
export function renderSummary(repo: string, head: string, c: ReviewContext, suggestions: readonly SuggestionLine[]): string {
  const core = coreLinks(repo, head, c).map((k) => `- [${k.label}](${k.url}) (\`${k.path}#L${k.start}-L${k.end}\`)`).join('\n');
  return [`**What it does**\n${str(c.summary)}`, `**Core logic**\n${core}`, renderTests(c.tests), renderTicket(c.ticket), renderSuggestions(suggestions)].join('\n\n');
}

export type JiraRead =
  | { status: 'read'; key: string; summary: string; description: string; issueType: string; ticketStatus: string }
  | { status: 'unreadable'; key: string; reason: string };
export type Fetcher = (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/**
 * Reads one ticket with a single GET. Credentials come from `env`; when any is missing it returns `unreadable` without making a request. The
 * reason names the missing variable or the HTTP status, never a value, and a response body is never echoed.
 */
export async function readJira(key: string, env: NodeJS.ProcessEnv, fetcher: Fetcher): Promise<JiraRead> {
  if (!/^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/.test(key)) return { status: 'unreadable', key, reason: 'not a Jira key' };
  const missing = ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'].filter((n) => !env[n]);
  if (missing.length) return { status: 'unreadable', key, reason: `no Jira access here: ${missing.join(', ')} not set` };
  const base = (env.JIRA_BASE_URL as string).replace(/\/+$/, '');
  if (!/^https:\/\/[A-Za-z0-9.-]+\.atlassian\.net$/.test(base)) return { status: 'unreadable', key, reason: 'JIRA_BASE_URL is not an atlassian.net https address' };
  const auth = Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString('base64');
  try {
    const r = await fetcher(`${base}/rest/api/2/issue/${key}?fields=summary,description,issuetype,status`, { headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' } });
    if (!r.ok) return { status: 'unreadable', key, reason: `Jira answered HTTP ${r.status}` };
    const f = ((await r.json()) as { fields?: Record<string, unknown> }).fields ?? {};
    const name = (v: unknown): string => str((v as { name?: unknown } | null)?.name);
    return { status: 'read', key, summary: str(f.summary), description: typeof f.description === 'string' ? f.description : '', issueType: name(f.issuetype), ticketStatus: name(f.status) };
  } catch (e) {
    return { status: 'unreadable', key, reason: `the Jira request failed (${e instanceof Error ? e.name : 'error'})` };
  }
}
