#!/usr/bin/env node
/**
 * RULE AUDIT: a read-only list of rule files missing an enforced-by value, plus
 * promotion and prune candidates from dates the caller supplies. It writes nothing
 * and deletes nothing.
 *
 *   node scripts/rule-audit.ts <directory> [--records <file.json>] [--now YYYY-MM-DD]
 *
 * A rule file is a markdown file in that directory (subfolders included). A file is
 * missing enforced-by when no line's value is `hook`, `script`, `convention`, or
 * `script:` followed by a path. Those paths are printed.
 *
 * --records is a JSON array of { path, cited, lastReference }. Dates are YYYY-MM-DD.
 * `last-reference` is accepted as an alias. Candidates come only from that set:
 * a convention-only rule cited within 30 days (inclusive) is a promotion candidate;
 * a rule with no last-reference, or one older than 60 days, is a prune candidate.
 * A reference exactly 60 days old is still in the window. Nothing is deleted.
 * --delete is refused.
 *
 * Exit 0 when it prints a report. Exit 2 when the directory argument is missing,
 * or when a flag or a date cannot be read.
 */
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROMOTION_DAYS = 30;
const PRUNE_DAYS = 60;
const USAGE = 'Usage: rule-audit.ts <directory> [--records <file.json>] [--now YYYY-MM-DD]';

type Kind = 'hook' | 'script' | 'convention';

interface Options {
    dir: string;
    records?: string;
    now: string;
    refuseDelete: boolean;
}

interface ReferenceRecord {
    path: string;
    cited?: string;
    lastReference?: string;
}

export interface Report {
    missing: string[];
    promotion: string[];
    prune: string[];
}

export function main(argv: string[]): number {
    const parsed = parseArgs(argv);
    if (typeof parsed === 'string') {
        console.error(`rule-audit: ${parsed}`);
        console.error(USAGE);
        return 2;
    }
    if (!isDirectory(parsed.dir)) {
        console.error('rule-audit: not a directory');
        console.error(USAGE);
        return 2;
    }
    if (parseDay(parsed.now) === null) {
        console.error('rule-audit: --now must be YYYY-MM-DD');
        return 2;
    }
    let records: ReferenceRecord[];
    try {
        records = parsed.records === undefined ? [] : loadRecords(parsed.records);
    } catch (err) {
        console.error(`rule-audit: ${err instanceof Error ? err.message : String(err)}`);
        return 2;
    }
    console.log(render(audit(parsed.dir, records, parsed.now), parsed.refuseDelete));
    return 0;
}

/** Missing enforced-by paths, plus promotion and prune candidates from the supplied records. */
export function audit(dir: string, records: ReferenceRecord[], now: string): Report {
    const files = listMarkdown(dir);
    const kinds = new Map(files.map((rel) => [normalize(rel), enforcedKind(readFileSync(join(dir, rel), 'utf8'))]));
    const byPath = new Map(records.map((row) => [normalize(row.path), row]));
    const missing = files.filter((rel) => kinds.get(normalize(rel)) === null).sort();
    const promotion: string[] = [];
    const prune: string[] = [];
    for (const rel of files) {
        const row = byPath.get(normalize(rel));
        if (row === undefined) continue;
        if (kinds.get(normalize(rel)) === 'convention' && citedWithin(now, row.cited)) promotion.push(rel);
        if (unrefreshed(now, row.lastReference)) prune.push(rel);
    }
    return { missing, promotion: promotion.sort(), prune: prune.sort() };
}

export function render(report: Report, refuseDelete: boolean): string {
    const lines = [
        section('missing enforced-by', report.missing),
        section('promotion candidates', report.promotion),
        section('prune candidates', report.prune),
        'deleted: none',
    ];
    if (refuseDelete) lines.push('refused to delete');
    return lines.join('\n');
}

export function parseArgs(argv: string[]): Options | string {
    const positional: string[] = [];
    let records: string | undefined;
    let now: string | undefined;
    let refuseDelete = false;
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--delete') {
            refuseDelete = true;
            continue;
        }
        if (arg === '--records' || arg === '--now') {
            const value = argv[i + 1];
            if (value === undefined || value.startsWith('--')) return `${arg} needs a value`;
            if (arg === '--records') records = value;
            else now = value;
            i += 1;
            continue;
        }
        if (arg === undefined || arg.startsWith('--')) return `unknown argument ${arg ?? ''}`;
        positional.push(arg);
    }
    if (positional.length === 0) return 'directory argument is missing';
    if (positional.length > 1) return 'too many arguments';
    const dir = positional[0];
    if (dir === undefined) return 'directory argument is missing';
    return { dir, records, now: now ?? todayUtc(), refuseDelete };
}

function section(title: string, paths: string[]): string {
    return `${title}:\n${paths.length === 0 ? '(none)' : paths.join('\n')}`;
}

function listMarkdown(dir: string): string[] {
    const found: string[] = [];
    const walk = (rel: string): void => {
        const abs = rel === '' ? dir : join(dir, rel);
        for (const entry of readdirSync(abs, { withFileTypes: true })) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
            if (entry.isSymbolicLink()) continue;
            const child = rel === '' ? entry.name : join(rel, entry.name);
            if (entry.isDirectory()) walk(child);
            else if (entry.isFile() && entry.name.endsWith('.md')) found.push(child);
        }
    };
    walk('');
    return found.sort();
}

function enforcedKind(text: string): Kind | null {
    for (const line of text.split(/\r?\n/)) {
        const value = fieldValue(line);
        if (value === null) continue;
        const kind = classify(value);
        if (kind !== null) return kind;
    }
    return null;
}

function fieldValue(line: string): string | null {
    const match = /^(?:[-*]\s+)?enforced-by:\s*(.*)$/.exec(line.trim());
    if (match === null) return null;
    return unquote((match[1] ?? '').trim());
}

function classify(value: string): Kind | null {
    if (value === 'hook' || value === 'convention' || value === 'script') return value;
    if (!value.startsWith('script:')) return null;
    return value.slice('script:'.length).trim().length > 0 ? 'script' : null;
}

function unquote(value: string): string {
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1).trim();
    }
    return value;
}

function loadRecords(file: string): ReferenceRecord[] {
    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        throw new Error('cannot read records');
    }
    if (!Array.isArray(raw)) throw new Error('records must be an array');
    return raw.map((row, index) => {
        if (row === null || typeof row !== 'object') throw new Error(`record ${index} is not an object`);
        const rec = row as Record<string, unknown>;
        if (typeof rec.path !== 'string' || rec.path === '') throw new Error(`record ${index} needs a path`);
        const cited = dateField(rec, ['cited', 'citation'], index);
        const lastReference = dateField(rec, ['lastReference', 'last-reference', 'last_reference'], index);
        return { path: rec.path, cited, lastReference };
    });
}

function dateField(rec: Record<string, unknown>, keys: string[], index: number): string | undefined {
    for (const key of keys) {
        if (!(key in rec) || rec[key] === undefined) continue;
        const value = rec[key];
        if (typeof value !== 'string' || parseDay(value) === null) {
            throw new Error(`record ${index} ${key} must be YYYY-MM-DD`);
        }
        return value;
    }
    return undefined;
}

function citedWithin(now: string, cited: string | undefined): boolean {
    if (cited === undefined) return false;
    const age = daysBetween(now, cited);
    return age !== null && age >= 0 && age <= PROMOTION_DAYS;
}

function unrefreshed(now: string, lastReference: string | undefined): boolean {
    if (lastReference === undefined) return true;
    const age = daysBetween(now, lastReference);
    return age === null || age > PRUNE_DAYS;
}

function daysBetween(later: string, earlier: string): number | null {
    const end = parseDay(later);
    const start = parseDay(earlier);
    if (end === null || start === null) return null;
    return Math.round((end - start) / 86_400_000);
}

function parseDay(value: string): number | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (match === null) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const stamp = Date.UTC(year, month - 1, day);
    const parsed = new Date(stamp);
    if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return null;
    return stamp;
}

function todayUtc(): string {
    const now = new Date();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const day = String(now.getUTCDate()).padStart(2, '0');
    return `${now.getUTCFullYear()}-${month}-${day}`;
}

function normalize(rel: string): string {
    return rel.replace(/\\/g, '/').replace(/^\.\//, '');
}

function isDirectory(dir: string): boolean {
    try {
        return statSync(dir).isDirectory();
    } catch {
        return false;
    }
}

const isMain = (): boolean => {
    try {
        return realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url);
    } catch {
        return false;
    }
};

if (isMain()) process.exitCode = main(process.argv.slice(2));
