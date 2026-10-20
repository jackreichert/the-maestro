/**
 * Slack triage prefilter: the deterministic first pass over a slack-watch new-messages file, before any model reads it.
 *
 * Each message gets one verdict from an ordered rule table (first match wins), and every verdict names the rule that made it and why:
 *   - `drop`: no model reads it and nothing is relayed (a reminder bot, a bare "thanks", the user's own post);
 *   - `model`: the cheap model reads it with the channel's playbook and decides;
 *   - `surface`: it must reach the user; a model may word the relay and refine the label, but may not drop it;
 *   - `escalate`: it goes straight to the stronger model (no playbook for the channel, a production error, anything that needs a check).
 *
 * The rule table is data: an org overlay ships it (a JSON file, `slack_triage_rules`), with the user's own Slack names and a channel map
 * (conversation tag to channel group and playbook). Two guarantees are enforced here, after the table, so no table entry can undo them:
 *   - a message by someone else that @-mentions the user is at least `surface` (labelled `ask` unless the rule gave a label), and one that
 *     names the user without the @, replies to the user's post, or broadcasts (@here, @channel, @everyone), is at least `model`. A mention
 *     can never be dropped;
 *   - a conversation with no playbook in the channel map never stops at `model` (the cheap model has nothing to follow): it escalates.
 *
 * Output carries no message text. A decision holds the tag, line number, time, author, verdict, label, route, rule and reason; the reader
 * opens the new-messages file at that line. So the prefilter's own output can be logged or passed on without spreading what was said.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const VERDICTS = ['drop', 'model', 'surface', 'escalate'] as const;
export type Verdict = typeof VERDICTS[number];

/** The flag labels: an ask of the user, a commitment or date, an incident or bug, a decision, or plain awareness. */
export const LABELS = ['ask', 'commitment', 'incident', 'decision', 'fyi'] as const;
export type Label = typeof LABELS[number];

/** One message line of a slack-watch note or new-messages file. `line` is 1-based in that file. */
export interface SlackMessage {
  line: number;
  date: string;
  time: string;
  reply: boolean;
  author: string;
  /** The message's own text: for a reply, without the quoted parent. */
  text: string;
  /** For a reply that quotes its parent, the parent's author. */
  parent?: string;
  /** A dated message line the format did not match (a new zone, a `*` in a name, a changed writer): never dropped, always escalated. */
  unparsed?: true;
}

/**
 * `- 2026-10-15 17:46 ET **Name**: text`, or a thread reply with `↳ ` before the author. A reply may quote its parent between the author and
 * the text: `↳ **Name** (re 2026-10-15 17:40 ET **Parent**: "first words..."): text`. Newlines inside a message are already folded by the writer.
 */
const MESSAGE = /^- (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) ET (↳ )?\*\*([^*]+)\*\*(?: \(re \d{4}-\d{2}-\d{2} \d{2}:\d{2} ET \*\*([^*]+)\*\*: ".*?"\))?: ?(.*)$/;

/** Any line that starts like a message, so a line the strict format misses is kept rather than silently lost. */
const DATED = /^- (\d{4}-\d{2}-\d{2}) (.*)$/;

/** The message lines of a note or new-messages file, in file order; headers and anything else are skipped. A dated line the format misses is kept as `unparsed`. */
export function parseMessages(text: string): SlackMessage[] {
  return text.split('\n').flatMap((l, i): SlackMessage[] => {
    const m = MESSAGE.exec(l);
    if (m) return [{ line: i + 1, date: m[1]!, time: m[2]!, reply: Boolean(m[3]), author: m[4]!.trim(), text: m[6]!, ...(m[3] && m[5] ? { parent: m[5].trim() } : {}) }];
    const d = DATED.exec(l);
    return d ? [{ line: i + 1, date: d[1]!, time: '', reply: false, author: '', text: d[2]!, unparsed: true }] : [];
  });
}

/** The conversation tag a new-messages file is for: its `# Slack new messages: <tag>` header, else the file name before `.new-`. */
export function tagOf(text: string, file: string): string {
  const h = /^# Slack new messages: (\S+)\s*$/m.exec(text);
  if (h) return h[1]!;
  const base = file.split('/').pop() ?? '';
  return base.includes('.new-') ? base.slice(0, base.indexOf('.new-')) : base.replace(/\.md$/, '');
}

/** One row of the rule table, compiled. Conditions all have to hold; an absent condition holds for every message. */
export interface TriageRule {
  name: string;
  reason: string;
  verdict: Verdict;
  label?: Label;
  /** Where the deterministic handling goes (for example a review batch or an incident log); passed through to the decision for the runner. */
  route?: string;
  channels?: string[];
  authors?: string[];
  match?: RegExp;
  reply?: boolean;
  /** True: the rule reads only the user's own posts. Absent or false: only everyone else's. */
  self?: boolean;
}

export interface ChannelEntry { group: string; playbook: string }

export interface TriageRules { me: string[]; channels: Record<string, ChannelEntry>; rules: TriageRule[]; baseDir: string }

/** One message's decision. No message text: the reader opens the new-messages file at `line`. */
export interface Decision {
  tag: string;
  group: string;
  playbook: string;
  line: number;
  at: string;
  author: string;
  reply: boolean;
  verdict: Verdict;
  label?: Label;
  route?: string;
  rule: string;
  reason: string;
}

/** Rule, group and route names: lower-case letters, digits and dashes. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,60}$/;
/** A quantified group that is itself quantified, such as `(a+)+`: the classic shape of a pattern that backtracks for minutes. */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)[+*{]/;
const RULE_KEYS = new Set(['name', 'reason', 'verdict', 'label', 'route', 'channels', 'authors', 'match', 'flags', 'reply', 'self']);
const strings = (v: unknown): boolean => Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string' && s.trim() !== '');
const compiles = (src: unknown, flags: unknown): boolean => { try { new RegExp(String(src), String(flags ?? '')); return true; } catch { return false; } };
const has = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);

/** Checks one raw rule must pass, in order; the first that fails names the problem. */
const RULE_CHECKS: { failsOn: (r: Record<string, unknown>) => boolean; message: string }[] = [
  { failsOn: (r) => typeof r.name !== 'string' || !SLUG.test(r.name), message: 'needs a name of lower-case letters, digits and dashes' },
  { failsOn: (r) => Object.keys(r).some((k) => !RULE_KEYS.has(k)), message: `has an unknown key (allowed: ${[...RULE_KEYS].join(', ')})` },
  { failsOn: (r) => typeof r.reason !== 'string' || !r.reason.trim() || /[\r\n]/.test(r.reason), message: 'needs a one-line reason' },
  { failsOn: (r) => !has(VERDICTS, r.verdict), message: `needs a verdict: ${VERDICTS.join(', ')}` },
  { failsOn: (r) => r.label !== undefined && !has(LABELS, r.label), message: `has a label outside ${LABELS.join(', ')}` },
  { failsOn: (r) => r.route !== undefined && (typeof r.route !== 'string' || !SLUG.test(r.route)), message: 'has a route that is not a lower-case dashed name' },
  { failsOn: (r) => r.channels !== undefined && !strings(r.channels), message: 'has channels that are not a list of tags' },
  { failsOn: (r) => r.authors !== undefined && !strings(r.authors), message: 'has authors that are not a list of names' },
  { failsOn: (r) => r.match !== undefined && (typeof r.match !== 'string' || !compiles(r.match, r.flags)), message: 'has a match that is not a valid regular expression' },
  { failsOn: (r) => typeof r.match === 'string' && NESTED_QUANTIFIER.test(r.match), message: 'has a nested quantifier such as (a+)+, which can hang on a long message; flatten it' },
  { failsOn: (r) => r.flags !== undefined && (typeof r.flags !== 'string' || !/^[imsu]*$/.test(r.flags)), message: 'has flags other than i, m, s, u' },
  { failsOn: (r) => r.reply !== undefined && typeof r.reply !== 'boolean', message: 'has a reply that is not true or false' },
  { failsOn: (r) => r.self !== undefined && typeof r.self !== 'boolean', message: 'has a self that is not true or false' },
  { failsOn: (r) => ['channels', 'authors', 'match', 'reply'].every((k) => r[k] === undefined), message: 'needs at least one condition (channels, authors, match or reply)' },
];

/** The problem with one raw rule, or null. */
export function ruleProblem(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'is not an object';
  return RULE_CHECKS.find((c) => c.failsOn(raw as Record<string, unknown>))?.message ?? null;
}

/** Parses and checks a rules file's JSON. Throws one error naming every problem, so a bad table never half-loads. */
export function parseRules(json: string, baseDir: string): TriageRules {
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(json) as Record<string, unknown>; } catch (err) { throw new Error(`slack triage rules are not JSON: ${err instanceof Error ? err.message : String(err)}`); }
  const problems: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('slack triage rules must be a JSON object');
  if (!strings(raw.me)) problems.push('`me` must list the user\'s Slack display names');
  const channels = (typeof raw.channels === 'object' && raw.channels !== null && !Array.isArray(raw.channels) ? raw.channels : null) as Record<string, unknown> | null;
  if (!channels) problems.push('`channels` must map each tag to { group, playbook }');
  for (const [tag, c] of Object.entries(channels ?? {})) {
    const e = c as Record<string, unknown> | null;
    if (!e || typeof e.group !== 'string' || !SLUG.test(e.group) || typeof e.playbook !== 'string' || !e.playbook.endsWith('.md')) problems.push(`channel ${tag} needs a group name and a .md playbook`);
  }
  const list = Array.isArray(raw.rules) ? raw.rules : null;
  if (!list) problems.push('`rules` must be a list');
  const names = new Set<string>();
  (list ?? []).forEach((r, i) => {
    const p = ruleProblem(r);
    const name = (r as { name?: unknown })?.name;
    if (p) problems.push(`rule ${i + 1}${typeof name === 'string' ? ` (${name})` : ''} ${p}`);
    else if (names.has(name as string)) problems.push(`rule ${i + 1} (${String(name)}) repeats a name`);
    else names.add(name as string);
  });
  if (problems.length) throw new Error(`slack triage rules: ${problems.join('; ')}`);
  return {
    me: (raw.me as string[]).map((s) => s.trim()),
    channels: Object.fromEntries(Object.entries(channels!).map(([t, c]) => [t, { group: (c as ChannelEntry).group, playbook: (c as ChannelEntry).playbook }])),
    rules: (list as Record<string, unknown>[]).map((r) => ({
      name: r.name as string, reason: (r.reason as string).trim(), verdict: r.verdict as Verdict,
      ...(r.label !== undefined && { label: r.label as Label }),
      ...(r.route !== undefined && { route: r.route as string }),
      ...(r.channels !== undefined && { channels: r.channels as string[] }),
      ...(r.authors !== undefined && { authors: (r.authors as string[]).map((a) => a.trim().toLowerCase()) }),
      ...(r.match !== undefined && { match: new RegExp(r.match as string, (r.flags as string | undefined) ?? '') }),
      ...(r.reply !== undefined && { reply: r.reply as boolean }),
      ...(r.self !== undefined && { self: r.self as boolean }),
    })),
    baseDir,
  };
}

/** Reads a rules file; a relative playbook in it is resolved against the file's folder. */
export const loadRules = (file: string): TriageRules => parseRules(readFileSync(file, 'utf8'), dirname(resolve(file)));

const RANK: Record<Verdict, number> = { drop: 0, model: 1, surface: 2, escalate: 3 };
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BROADCAST = /(^|\s)@(here|channel|everyone)\b/i;

/** How a message addresses the user: an @-mention, the bare name, or not at all. Matched on whole words, case-insensitive. */
export function addressed(text: string, me: readonly string[]): 'mention' | 'name' | null {
  const alt = me.map(escape).join('|');
  if (!alt) return null;
  if (new RegExp(`@(?:${alt})(?![\\p{L}\\p{N}])`, 'iu').test(text)) return 'mention';
  return new RegExp(`(?<![\\p{L}\\p{N}@])(?:${alt})(?![\\p{L}\\p{N}])`, 'iu').test(text) ? 'name' : null;
}

const isMe = (name: string, me: readonly string[]): boolean => me.some((n) => n.toLowerCase() === name.trim().toLowerCase());

const applies = (r: TriageRule, m: SlackMessage, tag: string, own: boolean): boolean =>
  Boolean(r.self) === own
  && (!r.channels || r.channels.includes(tag))
  && (!r.authors || r.authors.includes(m.author.toLowerCase()))
  && (r.reply === undefined || r.reply === m.reply)
  && (!r.match || r.match.test(m.text));

/** The decision for one message of conversation `tag`: the table's first match (or a built-in fallback), then the two enforced floors. */
export function decide(m: SlackMessage, tag: string, rules: TriageRules): Decision {
  const own = isMe(m.author, rules.me);
  const channel = Object.hasOwn(rules.channels, tag) ? rules.channels[tag] : undefined;
  if (m.unparsed) return { tag, group: channel?.group ?? '', playbook: channel ? resolve(rules.baseDir, channel.playbook) : '', line: m.line, at: `${m.date} ?`, author: '', reply: false, verdict: 'escalate', rule: 'unparsed', reason: 'a dated line the message format did not match; read it, and fix the parser if the format changed' };
  const hit = rules.rules.find((r) => applies(r, m, tag, own));
  const base: Pick<Decision, 'verdict' | 'label' | 'route' | 'rule' | 'reason'> = hit
    ? { verdict: hit.verdict, label: hit.label, route: hit.route, rule: hit.name, reason: hit.reason }
    : own ? { verdict: 'drop', rule: 'own-post', reason: 'the user\'s own post' }
      : { verdict: 'model', rule: 'no-rule', reason: 'no rule covers this message' };
  let { verdict, label } = base;
  let { rule, reason } = base;
  const addressing = own ? null : addressed(m.text, rules.me) ?? (m.parent && isMe(m.parent, rules.me) ? 'name' : null);
  if (addressing === 'mention' && RANK[verdict] < RANK.surface) { verdict = 'surface'; label = label ?? 'ask'; rule = `${rule}+mention`; reason = `${reason}; it @-mentions the user`; }
  else if ((addressing === 'name' || (!own && BROADCAST.test(m.text))) && verdict === 'drop') { verdict = 'model'; rule = `${rule}+addressed`; reason = `${reason}; it names the user, replies to the user or broadcasts, so it is never dropped unread`; }
  if (!channel && verdict === 'model') { verdict = 'escalate'; rule = `${rule}+no-playbook`; reason = `${reason}; no playbook covers this conversation`; }
  return {
    tag, group: channel?.group ?? '', playbook: channel ? resolve(rules.baseDir, channel.playbook) : '',
    line: m.line, at: `${m.date} ${m.time} ET`, author: m.author, reply: m.reply, verdict,
    ...(label && { label }), ...(base.route && { route: base.route }), rule, reason,
  };
}

/** Decisions for every message in one new-messages file's text. */
export const triageText = (text: string, file: string, rules: TriageRules, tag = tagOf(text, file)): Decision[] =>
  parseMessages(text).map((m) => decide(m, tag, rules));

/** Verdict counts, for the cost line a runner reports (how much reached each model). */
export function countVerdicts(ds: readonly Decision[]): Record<Verdict, number> {
  const out = { drop: 0, model: 0, surface: 0, escalate: 0 };
  for (const d of ds) out[d.verdict] += 1;
  return out;
}
