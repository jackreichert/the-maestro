/**
 * The `learned` ledger entry: one fact someone established, written when it is learned. Pure: the CLI hands in the
 * raw flags and what the run knows (the repos that exist, the learned ids already on the ledger).
 *
 * The rules run where the row is written (`parseLearned`) and again where it is audited (`learnedProblems`, which
 * `verify` calls on every stored row), so a hand-edited row cannot carry what the write refused. Both paths share
 * one rule table and the shared secret and PHI scanner.
 */
import { scanFields, describeFindings } from '../secret-scan.ts';
import type { ScanOptions } from '../secret-scan.ts';

export const LEARNED_KINDS = ['how-to', 'how-it-works', 'gotcha', 'decision', 'tool'] as const;
export const CONFIDENCES = ['observed', 'told-by-jack', 'inferred'] as const;
export const ENVS = ['local', 'dev', 'stg02', 'staging', 'prod'] as const;
export type LearnedKind = (typeof LEARNED_KINDS)[number];
export type Confidence = (typeof CONFIDENCES)[number];

/** The fields as stored on a row (`text` is the claim). */
export interface LearnedFields {
    text: string; learnedKind: LearnedKind; appliesTo: string; evidence: string; verifiedAt: string; confidence: Confidence; supersedes?: string;
}

/** The part of a stored row these helpers read; anything may be there, so each field is checked before it is trusted. */
export type LearnedRow = Partial<Record<'text' | 'learnedKind' | 'appliesTo' | 'evidence' | 'verifiedAt' | 'confidence' | 'supersedes' | 'date' | 'repo' | 'stream' | 'model' | 'used' | 'tokens' | 'harness' | 'agent', unknown>>;

/** The other free text a row carries (usage marks, repo, stream, date). Not part of the fact, but written to the same row, so it is scanned too. */
export type LearnedExtras = Partial<Record<'date' | 'repo' | 'stream' | 'model' | 'used' | 'tokens' | 'harness' | 'agent', string>>;

/** The flags as the command line gave them (null when absent or valueless). */
export interface RawLearned { claim: string; kind: string | null; appliesTo: string | null; evidence: string | null; verifiedAt: string | null; confidence: string | null; supersedes: string | null; extras?: LearnedExtras }

/** What the run knows. `repos` is undefined when no container is configured: then only the shape of applies-to is checked. */
export interface LearnedContext extends ScanOptions { repos?: ReadonlySet<string>; learnedIds: ReadonlySet<string> }

export const CLAIM_MAX = 400;
export const FIELD_MAX = 300;
/** No field is scanned past this; a longer one is refused outright. */
const SCAN_MAX = 2000;
const SLUG = /^[a-z0-9][a-z0-9._-]*$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA = /^[0-9a-f]{7,40}$/;
const DATE_WITH_HOW = /^(\d{4}-\d{2}-\d{2})\s+\S.*$/;
const ROW_ID = /^[a-z0-9]{4}$/;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isRealDate = (s: string): boolean => { const t = Date.parse(`${s}T00:00:00Z`); return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s; };
const oneOf = (list: readonly string[], v: unknown): boolean => typeof v === 'string' && list.includes(v);

/** Splits `repo:component[:env]`; null unless it has two or three slug parts and an env, when present, is a known one. */
export function parseAppliesTo(s: string): { repo: string; component: string; env?: string } | null {
    const parts = s.split(':');
    if (parts.length < 2 || parts.length > 3 || !parts.every((p) => SLUG.test(p))) return null;
    const [repo = '', component = '', env] = parts;
    return env !== undefined && !oneOf(ENVS, env) ? null : { repo, component, ...(env !== undefined ? { env } : {}) };
}

/** What the rules look at: each field as a value that may be missing or malformed, plus the run's context. */
interface Check { v: Record<keyof LearnedFields | keyof LearnedExtras, unknown>; ctx: LearnedContext }
/** A rule refuses (returns the message) or passes (null). Every refusal is reported. No message echoes a flag's value: an input that failed may be the secret. */
interface Rule { name: string; refuse: (c: Check) => string | null }

const required = (field: keyof LearnedFields, flag: string, hint: string): Rule => ({ name: `${flag}-required`, refuse: (c) => (isText(c.v[field]) ? null : `${flag} is required: ${hint}`) });
const tooLong = (field: keyof LearnedFields, flag: string, max: number): Rule => ({
    name: `${flag}-plain`,
    refuse: (c) => { const s = c.v[field]; return !isText(s) ? null : CONTROL.test(s) ? `${flag} has a control character: plain text only.` : s.trim().length > max ? `${flag} is over ${max} characters: say it shorter.` : null; },
});

const RULES: Rule[] = [
    required('text', 'the claim', 'one sentence, true or false on its own.'),
    tooLong('text', 'the claim', CLAIM_MAX),
    { name: 'claim-one-line', refuse: (c) => (isText(c.v.text) && /\n/.test(c.v.text.trim()) ? 'the claim must be one line.' : null) },
    { name: 'kind', refuse: (c) => (oneOf(LEARNED_KINDS, c.v.learnedKind) ? null : `--kind is required and must be one of: ${LEARNED_KINDS.join(', ')}.`) },
    required('appliesTo', '--applies-to', 'repo:component[:env], for example my-repo:interim-db:staging.'),
    {
        name: 'applies-to-shape',
        refuse: (c) => {
            const a = c.v.appliesTo;
            if (!isText(a)) return null;
            const p = parseAppliesTo(a.trim());
            if (!p) return `--applies-to must be repo:component[:env], with env one of ${ENVS.join(', ')}.`;
            return c.ctx.repos && !c.ctx.repos.has(p.repo) ? '--applies-to names a repo that is not a known repo here.' : null;
        },
    },
    required('evidence', '--evidence', 'a file:line, PR, note path, or the command and the count it printed. Never a secret value.'),
    tooLong('evidence', '--evidence', FIELD_MAX),
    required('verifiedAt', '--verified-at', 'a repo sha, or a date plus how it was checked (2026-10-08 ran the query).'),
    {
        name: 'verified-at-shape',
        refuse: (c) => {
            const v = c.v.verifiedAt;
            if (!isText(v)) return null;
            const s = v.trim();
            const date = DATE_WITH_HOW.exec(s)?.[1];
            return SHA.test(s) || (date !== undefined && isRealDate(date)) ? null : '--verified-at must be a 7 to 40 character hex sha, or YYYY-MM-DD followed by how it was checked.';
        },
    },
    { name: 'confidence', refuse: (c) => (oneOf(CONFIDENCES, c.v.confidence) ? null : `--confidence is required and must be one of: ${CONFIDENCES.join(', ')}.`) },
    {
        name: 'supersedes',
        refuse: (c) => {
            const s = c.v.supersedes;
            if (s === undefined) return null;
            if (!isText(s)) return '--supersedes needs a value: an earlier learned id or a page path.';
            const t = s.trim();
            if (ROW_ID.test(t)) return c.ctx.learnedIds.has(t) ? null : '--supersedes is not a learned row on this ledger.';
            return /\/|\.md$/.test(t) && t.length <= FIELD_MAX && !CONTROL.test(t) ? null : '--supersedes must be an earlier learned id or a page path.';
        },
    },
    { name: 'date', refuse: (c) => (c.v.date === undefined || (typeof c.v.date === 'string' && DATE.test(c.v.date) && isRealDate(c.v.date)) ? null : '--date must be a real YYYY-MM-DD.') },
    {
        name: 'scanner',
        refuse: (c) => {
            const text = (k: keyof Check['v']): string | undefined => (typeof c.v[k] === 'string' ? (c.v[k] as string) : Array.isArray(c.v[k]) ? (c.v[k] as unknown[]).map(String).join(' ') : undefined);
            const fields = {
                claim: text('text'), 'applies-to': text('appliesTo'), evidence: text('evidence'), 'verified-at': text('verifiedAt'), supersedes: text('supersedes'),
                repo: text('repo'), stream: text('stream'), model: text('model'), used: text('used'), tokens: text('tokens'), harness: text('harness'), agent: text('agent'),
            };
            // A field this long is refused by its own rule or by this one; scanning it would only burn time.
            const long = Object.entries(fields).filter(([, v]) => (v?.length ?? 0) > SCAN_MAX).map(([k]) => k);
            if (long.length) return `${long.join(', ')} is over ${SCAN_MAX} characters: say it shorter.`;
            const findings = scanFields(fields, c.ctx);
            return findings.length ? `refused, nothing written (${describeFindings(findings).join('; ')}). Record names and locations, never values; claims are about systems, ids and counts only.` : null;
        },
    },
];

const refusals = (v: Check['v'], ctx: LearnedContext): string[] => RULES.map((r) => r.refuse({ v, ctx })).filter((m): m is string => m !== null);
const trimmed = (s: string | null): string | undefined => (s === null ? undefined : s.replace(/\s+/g, ' ').trim());

/** What `learned` does with its flags: the fields to store when every rule passes, else the refusals (and no fields). */
export type LearnedParse = { fields: LearnedFields; errors: [] } | { fields?: undefined; errors: string[] };

export function parseLearned(raw: RawLearned, ctx: LearnedContext): LearnedParse {
    const v: Check['v'] = {
        text: trimmed(raw.claim), learnedKind: raw.kind ?? undefined, appliesTo: trimmed(raw.appliesTo), evidence: trimmed(raw.evidence),
        verifiedAt: trimmed(raw.verifiedAt), confidence: raw.confidence ?? undefined, supersedes: trimmed(raw.supersedes),
        ...raw.extras,
    };
    const errors = refusals(v, ctx);
    if (errors.length) return { errors };
    const fields: LearnedFields = {
        text: v.text as string, learnedKind: v.learnedKind as LearnedKind, appliesTo: v.appliesTo as string, evidence: v.evidence as string,
        verifiedAt: v.verifiedAt as string, confidence: v.confidence as Confidence, ...(v.supersedes !== undefined ? { supersedes: v.supersedes as string } : {}),
    };
    return { fields, errors: [] };
}

/** Problems with one stored `learned` row, for `verify`: whatever the write-time rules would refuse. The repo list is not re-checked (a repo may be renamed later). */
export function learnedProblems(row: LearnedRow, learnedIds: ReadonlySet<string>, opts: ScanOptions = {}): string[] {
    return refusals({ text: row.text, learnedKind: row.learnedKind, appliesTo: row.appliesTo, evidence: row.evidence, verifiedAt: row.verifiedAt, confidence: row.confidence, supersedes: row.supersedes, date: row.date, repo: row.repo, stream: row.stream, model: row.model, used: row.used, tokens: row.tokens, harness: row.harness, agent: row.agent }, { ...opts, learnedIds });
}

export const LEARNED_USAGE = [
    'journal.ts learned "<claim>" --kind how-to|how-it-works|gotcha|decision|tool --applies-to <repo:component[:env]>',
    '    --evidence "<file:line, PR, note path, or command and the count it printed>" --verified-at "<sha | YYYY-MM-DD how checked>"',
    '    --confidence observed|told-by-jack|inferred [--supersedes <learned id | page path>] --model "<name>" --used "skill:x,tool:y"',
    '    Every field above is required except --supersedes. The claim is one sentence about a system, in the present tense; ids and counts only.',
    '    A claim, evidence or location that looks like a secret or PHI is refused and nothing is written.',
];
