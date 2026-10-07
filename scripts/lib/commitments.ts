/**
 * Commitments sweep, the pure parts: which transcript lines are the human's own typed messages, which sentences read like a
 * commitment, and which ledger or standing item (if any) already carries one. No file or ledger access happens here.
 *
 * Nothing the user typed is ever printed: a candidate is reported by its turn number, its cue class and the id of the item that
 * carries it. The sentence is used for matching only, so no output path can show a password or any other typed text.
 *
 * Matching is by shared keywords only. It says "something on the board mentions these words", not "this was captured";
 * a model or the user judges every UNMATCHED and CHECK candidate (and may doubt a MATCHED one).
 */

/** `line` is the 1-based line of the transcript file; `uuid` and `ts` are the transcript's own generated id and time, when they have the expected shape. */
export interface Locator { line: number; uuid: string | null; ts: string | null }
export interface Turn extends Locator { turn: number; text: string }
export interface Candidate extends Locator { turn: number; sentence: string; cue: string }
export interface Known { kind: 'ledger' | 'standing'; id: string; text: string }
/** `coverage` is the share of the candidate's content words the matched item also has (0 to 1). */
export interface Match { kind: Known['kind']; id: string; coverage: number }
/** MATCHED: an open item covers the sentence well. CHECK: an item shares words but covers too little, so a person judges whether it means the same. UNMATCHED: nothing open comes close. */
export interface Verdict extends Candidate { verdict: 'MATCHED' | 'CHECK' | 'UNMATCHED'; match: Match | null }
/** The share of a candidate's content words a matched item must hold for the match to be high-confidence. */
export const HIGH_CONFIDENCE = 0.6;

export const KEYWORD_NOTE = 'Matching is by shared keywords only. A model or the user judges the UNMATCHED and CHECK candidates, and may doubt a MATCHED one.';

/** Cue patterns, each a phrase people use when they bind the future. */
export const CUES: { name: string; re: RegExp }[] = [
    { name: 'we decided', re: /\bwe(?:'ve| have)? decided\b/i },
    { name: 'we agreed', re: /\bwe(?:'ve| have)? agreed\b/i },
    { name: 'before prod', re: /\bbefore (?:we go )?(?:to )?prod(?:uction)?\b/i },
    { name: 'before we', re: /\bbefore we\b/i },
    { name: 'make sure', re: /\bmake sure\b/i },
    { name: 'remember to', re: /\bremember to\b/i },
    { name: "don't forget", re: /\bdon'?t forget\b/i },
    { name: 'from now on', re: /\bfrom now on\b/i },
    { name: 'always', re: /\balways\b/i },
    { name: 'never', re: /\bnever\b/i },
    { name: 'I want', re: /\bI want\b/i },
    { name: 'we need to figure out', re: /\bwe need to figure out\b/i },
    { name: 'figure out ... before', re: /\bfigure out\b[^.!?\n]*\bbefore\b/i },
];

/** Prefixes of user-role lines that are not the human typing: the harness's own wrappers and agent reports. */
const NOT_HUMAN_PREFIX = /^\s*(?:<system-reminder>|<task-notification>|<command-|<local-command|\[Subagent hand-back\]|Caveat:)/i;

/** An opening paste marker: at the start of a line, with an id attribute. A marker quoted mid-sentence is just words. */
const PASTE_OPEN = /^<pasted_content\b[^>\n]*?\bid=["']?([^"'\s>]+)["']?[^>\n]*>/m;

const joinParts = (parts: string[]): string => parts.map((p) => p.trim()).filter(Boolean).join('\n');

/**
 * The text the user typed: everything outside `<pasted_content id="x">...</pasted_content id="x">` pairs (the closing tag may omit the
 * id when there is one paste). A paste with no closing tag runs to the end of the message.
 */
export function withoutPastes(text: string): string {
    const kept: string[] = [];
    let rest = text;
    for (let open = PASTE_OPEN.exec(rest); open; open = PASTE_OPEN.exec(rest)) {
        kept.push(rest.slice(0, open.index));
        const after = rest.slice(open.index + open[0].length);
        const id = open[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const close = new RegExp(`</pasted_content(?:[^>]*\\bid=["']?${id}["']?[^>]*)?>`, 'i').exec(after);
        if (!close) return joinParts(kept);
        rest = after.slice(close.index + close[0].length);
    }
    return joinParts([...kept, rest]);
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' ? (v as Record<string, unknown>) : null);

/**
 * The text of a parsed transcript line when it is a message the human typed, else null. A tool result, a meta or sidechain line, a
 * compaction summary, a task notification, a peer or hand-back message and a harness wrapper are not the human.
 */
export function humanText(parsed: unknown): string | null {
    const o = obj(parsed);
    if (!o || o.type !== 'user' || o.isMeta === true || o.isSidechain === true || o.isCompactSummary === true) return null;
    const origin = obj(o.origin);
    if (origin && origin.kind !== 'human') return null;
    const content = obj(o.message)?.content;
    const text = typeof content === 'string' ? content
        : Array.isArray(content) ? content.map((p) => (obj(p)?.type === 'text' && typeof obj(p)?.text === 'string' ? String(obj(p)?.text) : '')).filter(Boolean).join('\n') : '';
    const typed = withoutPastes(text);
    return typed.trim() && !NOT_HUMAN_PREFIX.test(typed) ? typed : null;
}

/** The human turns of a transcript's JSONL text, numbered from 1; a line that is not JSON is skipped. */
export function humanTurns(jsonl: string): Turn[] {
    const turns: Turn[] = [];
    jsonl.split('\n').forEach((line, index) => {
        if (!line) return;
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { return; }
        const text = humanText(parsed);
        if (text !== null) turns.push({ turn: turns.length + 1, text, line: index + 1, ...locatorOf(parsed) });
    });
    return turns;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

/** The transcript's own message id and time, only when they have the generated shape, so a locator can never carry typed text. */
function locatorOf(parsed: unknown): Pick<Locator, 'uuid' | 'ts'> {
    const o = obj(parsed);
    return { uuid: typeof o?.uuid === 'string' && UUID.test(o.uuid) ? o.uuid : null, ts: typeof o?.timestamp === 'string' && ISO_TIME.test(o.timestamp) ? o.timestamp : null };
}

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Sentences of a message: code fences dropped, split on sentence ends and line breaks. */
function sentences(text: string): string[] {
    return text.replace(/```[\s\S]*?```/g, ' ').split(/(?<=[.!?])\s+|\n+/).map(squash).filter(Boolean);
}

/** Every sentence in the human turns that carries a cue, once per sentence (the first cue that matches names it). The sentence is for matching only. */
export function extractCandidates(turns: (Pick<Turn, 'turn' | 'text'> & Partial<Locator>)[]): Candidate[] {
    const out: Candidate[] = [];
    for (const { text, turn, line = 0, uuid = null, ts = null } of turns) {
        for (const s of sentences(text)) {
            const cue = CUES.find((c) => c.re.test(s));
            if (cue) out.push({ turn, line, uuid, ts, sentence: s, cue: cue.name });
        }
    }
    return out;
}

const STOP = new Set(['about', 'after', 'again', 'also', 'always', 'been', 'before', 'being', 'could', 'does', 'doing', 'done', 'down', 'from', 'have', 'into', 'just', 'like', 'make', 'much', 'must', 'need', 'never', 'only', 'other', 'over', 'please', 'remember', 'should', 'some', 'sure', 'than', 'that', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'what', 'when', 'where', 'which', 'will', 'with', 'would', 'your', 'want', 'decided', 'agreed', 'figure', 'forget', 'know', 'think', 'get']);

/** Distinct lowercase words of four letters or more, minus filler. */
export function keywords(text: string): Set<string> {
    return new Set((text.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? []).filter((w) => !STOP.has(w)));
}

/** The known item sharing the most keywords with a candidate, when the overlap is enough: three words, or two that are half the candidate's. */
export function nearest(candidate: string, known: Known[]): Match | null {
    const words = keywords(candidate);
    let best: (Match & { shared: string[] }) | null = null;
    for (const k of known) {
        const shared = [...keywords(k.text)].filter((w) => words.has(w));
        const enough = shared.length >= 3 || (shared.length >= 2 && shared.length * 2 >= words.size);
        if (enough && (!best || shared.length > best.shared.length)) best = { kind: k.kind, id: k.id, coverage: shared.length / words.size, shared };
    }
    return best ? { kind: best.kind, id: best.id, coverage: best.coverage } : null;
}

/**
 * Each candidate with its verdict against what the ledger and the standing pickups already say.
 */
export const judge = (candidates: Candidate[], known: Known[]): Verdict[] =>
    candidates.map((c) => {
        const match = nearest(c.sentence, known);
        return { ...c, verdict: !match ? 'UNMATCHED' : match.coverage >= HIGH_CONFIDENCE ? 'MATCHED' : 'CHECK', match };
    });

/** 1 when any candidate is UNMATCHED, else 3 when any needs a CHECK, else 0 (no candidates, or every one matched with high confidence). */
export const exitCodeOf = (verdicts: Verdict[]): number => (verdicts.some((v) => v.verdict === 'UNMATCHED') ? 1 : verdicts.some((v) => v.verdict === 'CHECK') ? 3 : 0);

/** A standing id made only of lowercase words and hyphens, which `standing add` now enforces; an older id with digits or punctuation could carry typed text. */
export const SAFE_STANDING_ID = /^[a-z]+(?:-[a-z]+){0,5}$/;
/** The ids `journal.ts` generates for ledger items: four base-36 characters (or six digits). A hand-edited id could carry typed text. */
export const LEDGER_ID = /^[a-z0-9]{4,6}$/;
export const ID_WITHHELD = '[id withheld]';

/** The id as it may be printed: the generated or enforced shape, else a placeholder. */
export const printableId = (kind: Known['kind'], id: string): string => ((kind === 'standing' ? SAFE_STANDING_ID : LEDGER_ID).test(id) ? id : ID_WITHHELD);

/** What the sweep prints for one candidate: no sentence, no item text, only the turn, the cue class, the verdict and the carrying id. */
export interface PublicVerdict extends Locator { turn: number; cue: string; verdict: Verdict['verdict']; match: { kind: Known['kind']; id: string; coveragePercent: number } | null }

export const publicView = (v: Verdict): PublicVerdict => ({
    turn: v.turn, line: v.line, uuid: v.uuid, ts: v.ts, cue: v.cue, verdict: v.verdict,
    match: v.match ? { kind: v.match.kind, id: printableId(v.match.kind, v.match.id), coveragePercent: Math.round(v.match.coverage * 100) } : null,
});
