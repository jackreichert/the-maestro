/**
 * The `shared` ledger entry: a document the user handed over (a local file or a link), recorded the moment it is shared
 * so the project's tab can list it. Only a pointer is stored (a title, where the document is, an optional reason); the
 * document's contents never enter the ledger or the Podium.
 *
 * The rules run where the row is written (`parseShared`) and again where it is audited (`sharedProblems`, called by
 * `verify`), and the Podium reader (`sharedDocs`) drops any row that fails them, so a hand-edited row cannot put a
 * secret-shaped name or an unsafe link on the page.
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { describeFindings, scanFields } from '../secret-scan.ts';
import { hasSecretSegment } from '../vault/secret-names.ts';
import { isSafeUrl } from '../../web/client/src/url.ts';

export const SHARED_TITLE_MAX = 120;
export const SHARED_WHY_MAX = 200;
const TARGET_MAX = 500;
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const WEB = /^https?:\/\//i;

/** Where a local document sits: under the notes vault or under the container of repos. */
export type SharedRoot = 'vault' | 'container';
export interface SharedRoots { vault?: string; container?: string }

/** The fields stored on a `shared` row (`text` is the title). `target` is a URL, or a path relative to `root`. */
export interface SharedFields { text: string; target: string; sharedKind: 'path' | 'url'; root?: SharedRoot; why?: string; by: string; sharedProject: string }

export interface RawShared { target: string; title: string | null; why: string | null; by: string | null; project: string }
export type SharedParse = { fields: SharedFields; errors?: undefined } | { fields?: undefined; errors: string[] };

const oneLine = (s: string | null | undefined): string | undefined => (s == null ? undefined : s.replace(/\s+/g, ' ').trim());

/** A local path as `{ root, rel }` when it is an existing regular file under a configured root; else the reason it is refused. No message echoes the path. */
export function resolveSharedPath(target: string, roots: SharedRoots): { root: SharedRoot; rel: string } | { error: string } {
    if (hasSecretSegment(target)) return { error: 'the path names a file that can hold secrets (an env file, key, state or credentials file); share a link or a copy without secrets.' };
    const abs = resolve(target);
    if (!existsSync(abs)) return { error: 'the path does not exist.' };
    let real: string;
    try { real = realpathSync(abs); } catch { return { error: 'the path cannot be resolved.' }; }
    if (!statSync(real).isFile()) return { error: 'the path is not a regular file.' };
    if (hasSecretSegment(real)) return { error: 'the path resolves to a file that can hold secrets; refused.' };
    for (const [root, base] of [['vault', roots.vault], ['container', roots.container]] as const) {
        if (!base) continue;
        let realBase: string;
        try { realBase = realpathSync(base); } catch { continue; }
        const rel = relative(realBase, real);
        if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return { root, rel: rel.split(sep).join('/') };
    }
    return { error: roots.vault || roots.container ? 'the path is outside the notes vault and the container root.' : 'no vault_root or container_root is configured, so no local path can be shared; share a link instead.' };
}

/** The refusals for one set of fields, shared by the write and the audit. Never echoes a value: an input that failed may be the secret. */
function refusals(f: Partial<Record<keyof SharedFields, unknown>>): string[] {
    const out: string[] = [];
    const str = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
    if (!str(f.text)) out.push('--title is required: say what the document is, in one line.');
    else if (CONTROL.test(f.text)) out.push('--title has a control character: plain text only.');
    else if (f.text.trim().length > SHARED_TITLE_MAX) out.push(`--title is over ${SHARED_TITLE_MAX} characters: say it shorter.`);
    if (f.why !== undefined && (!str(f.why) || CONTROL.test(f.why) || f.why.trim().length > SHARED_WHY_MAX)) out.push(`--why must be one plain line of at most ${SHARED_WHY_MAX} characters.`);
    if (!str(f.sharedProject) || !PROJECT.test(f.sharedProject)) out.push('--project must be a project folder name.');
    if (!str(f.by) || CONTROL.test(f.by) || f.by.length > 40) out.push('--by must be a short plain name.');
    if (!str(f.target) || f.target.length > TARGET_MAX || CONTROL.test(f.target)) out.push('the document path or link must be one plain line.');
    else if (f.sharedKind === 'url') {
        if (!isSafeUrl(f.target)) out.push('the link must be http(s), or obsidian://open with only vault and file.');
        if (WEB.test(f.target) && /^https?:\/\/[^/?#]*@/i.test(f.target)) out.push('the link carries credentials; refused.');
    } else if (f.sharedKind === 'path') {
        if (f.root !== 'vault' && f.root !== 'container') out.push('a path row names where it sits (vault or container).');
        else if (f.target.startsWith('/') || f.target.split('/').includes('..')) out.push('a stored path is relative to its root, with no "..".');
        if (hasSecretSegment(f.target)) out.push('the path names a file that can hold secrets; refused.');
    } else out.push('a row is a path or a url.');
    const fields = { title: str(f.text) ? f.text : undefined, why: str(f.why) ? f.why : undefined, target: str(f.target) ? f.target : undefined };
    const findings = scanFields(fields);
    if (findings.length) out.push(`refused, nothing written (${describeFindings(findings).join('; ')}). Record a title and a place, never a value.`);
    return out;
}

/** What `shared` does with its arguments: the fields to store when every rule passes, else the refusals. */
export function parseShared(raw: RawShared, roots: SharedRoots): SharedParse {
    const target = raw.target.trim();
    const isUrl = WEB.test(target) || /^obsidian:\/\//i.test(target);
    const base = { text: oneLine(raw.title) ?? '', sharedKind: isUrl ? 'url' as const : 'path' as const, why: oneLine(raw.why), by: oneLine(raw.by) ?? 'user', sharedProject: raw.project.trim() };
    const errors: string[] = [];
    let placed: { target: string; root?: SharedRoot } = { target };
    if (!isUrl) {
        const r = target ? resolveSharedPath(target, roots) : { error: 'a document path or link is required.' };
        if ('error' in r) errors.push(r.error); else placed = { target: r.rel, root: r.root };
    }
    const fields: SharedFields = { ...base, ...placed, why: base.why };
    if (fields.why === undefined) delete fields.why;
    errors.push(...refusals(fields));
    return errors.length ? { errors } : { fields };
}

/** The fields a stored `shared` row may carry: its own, the usage marks, and the row's bookkeeping. */
const SHARED_ROW_FIELDS = new Set(['id', 'ts', 'date', 'kind', 'text', 'target', 'sharedKind', 'root', 'why', 'by', 'sharedProject', 'stream', 'repo', 'model', 'used', 'tokens', 'harness', 'agent', 'window']);

/** Problems with one stored `shared` row, for `verify`: whatever the write rules would refuse, plus fields the command does not write. */
export function sharedProblems(row: Record<string, unknown>): string[] {
    const unknown = Object.keys(row).filter((k) => !SHARED_ROW_FIELDS.has(k)).map((k) => (k.length > 24 ? `${k.slice(0, 24)}...` : k));
    const extra = unknown.length ? [`unknown field${unknown.length > 1 ? 's' : ''} (${unknown.join(', ')}): \`shared\` writes only its named fields, so this row was edited by hand.`] : [];
    return [...extra, ...refusals({ text: row.text, target: row.target, sharedKind: row.sharedKind, root: row.root, why: row.why, by: row.by, sharedProject: row.sharedProject })];
}

/** One shared document as the Podium shows it. `path` is relative to `root`; never absolute. */
export interface SharedDoc { title: string; target: string; kind: 'path' | 'url'; root?: SharedRoot; why?: string; by: string; project: string; date: string }

/** The documents shared for `project`, newest first, one per target (the newest row wins). A row that fails the write rules is skipped. */
export function sharedDocs(rows: readonly Record<string, unknown>[], project: string): SharedDoc[] {
    const docs = new Map<string, SharedDoc>();
    for (const r of rows) {
        if (r.kind !== 'shared' || r.sharedProject !== project || sharedProblems(r).length) continue;
        const date = typeof r.date === 'string' ? r.date : '';
        const doc: SharedDoc = { title: r.text as string, target: r.target as string, kind: r.sharedKind as 'path' | 'url', ...(r.root ? { root: r.root as SharedRoot } : {}), ...(r.why ? { why: r.why as string } : {}), by: r.by as string, project, date };
        const key = `${doc.kind}:${doc.root ?? ''}:${doc.target}`;
        const prev = docs.get(key);
        if (!prev || date >= prev.date) docs.set(key, doc);
    }
    return [...docs.values()].sort((a, b) => b.date.localeCompare(a.date));
}

/** Whether `rows` already hold this exact share (same project, target and title); an exact repeat is reported, not written. */
export function alreadyShared(rows: readonly Record<string, unknown>[], f: SharedFields): string | undefined {
    const hit = rows.find((r) => r.kind === 'shared' && r.sharedProject === f.sharedProject && r.target === f.target && r.text === f.text && r.root === f.root);
    return typeof hit?.id === 'string' ? hit.id : undefined;
}

export const SHARED_USAGE = [
    'journal.ts shared <path-or-url> --project <project> --title "<what it is>" [--why "<one line>"] [--by <name>] --model "<name>" --used "skill:x,tool:y"',
    '    Records a document the user handed over, so its project tab lists it. Only the title, the place and the reason are stored, never the contents.',
    '    A path must be an existing file under the notes vault (vault_root) or the container root; a link must be http(s) or obsidian://open.',
    '    A file name that can hold secrets (env files, keys, state, credentials) and a title, reason or link that looks like a secret or PHI are refused.',
    '    An exact repeat is reported, not written twice.',
];
