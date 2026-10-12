#!/usr/bin/env node
/**
 * MEMORY SORT: read-only report of which memory files are project facts (library candidates) and which are rules about working
 * with the user (they stay in memory).
 *
 *   node scripts/memory-sort.ts --memory-dir <dir> [--hints <file.json>] [--json]
 *
 * Prints one row per file: name, verdict, target library page and the reason, then the counts. It never writes, edits or deletes
 * anything and prints no file body. `--hints` is a JSON array of ["regex", "project"] pairs, tried before the built-in hints, that map
 * a memory file to the library project that should hold it (see readHints). Exit 0 on a report, 2 on a usage or read error.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { printJson } from './lib/json-out.ts';
import { DEFAULT_HINTS, sortAll } from './lib/memory-sort.ts';
import type { RepoHint, Sorted } from './lib/memory-sort.ts';

const USAGE = 'Usage: memory-sort.ts --memory-dir <dir> [--hints <file.json>] [--json]';

export function parseOptions(argv: string[]): { memoryDir: string; hints: string; json: boolean } | string {
    let memoryDir = '';
    let hints = '';
    let json = false;
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--json') json = true;
        else if (a === '--memory-dir') {
            const v = argv[i + 1];
            if (v === undefined || v.startsWith('--')) return '--memory-dir needs a value';
            memoryDir = v;
            i += 1;
        } else if (a === '--hints') {
            const v = argv[i + 1];
            if (v === undefined || v.startsWith('--')) return '--hints needs a value';
            hints = v;
            i += 1;
        } else return `unknown argument ${a}`;
    }
    return memoryDir ? { memoryDir, hints, json } : '--memory-dir is required';
}

/** Read a hints file: a JSON array of ["regex", "project"] pairs. Throws a plain message on any other shape, so a typo never silently sorts nothing. */
export function readHints(file: string): RepoHint[] {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(raw)) throw new Error('hints file must be a JSON array of ["regex", "project"] pairs');
    return raw.map((p: unknown) => {
        if (!Array.isArray(p) || p.length !== 2 || typeof p[0] !== 'string' || typeof p[1] !== 'string' || p[1] === '') throw new Error('each hint must be ["regex", "project"]');
        return [new RegExp(p[0], 'i'), p[1]] as RepoHint;
    });
}

/** Sort every memory file in a directory (the MEMORY.md index is skipped). Extra hints are tried before the defaults. */
export function sortDir(dir: string, extra: RepoHint[] = []): Sorted[] {
    const names = readdirSync(dir).filter((f) => f.endsWith('.md'));
    return sortAll(names.map((f) => ({ name: f.replace(/\.md$/, ''), text: readFileSync(join(dir, f), 'utf8') })), [...extra, ...DEFAULT_HINTS]);
}

function main(argv: string[]): number {
    const opts = parseOptions(argv);
    if (typeof opts === 'string') { console.error(`${opts}\n${USAGE}`); return 2; }
    if (!existsSync(opts.memoryDir)) { console.error(`no memory directory at ${opts.memoryDir}`); return 2; }
    let extra: RepoHint[] = [];
    try { extra = opts.hints ? readHints(opts.hints) : []; } catch (e) { console.error(`hints: ${e instanceof Error ? e.message : String(e)}`); return 2; }
    const rows = sortDir(opts.memoryDir, extra);
    const count = (k: string) => rows.filter((r) => r.kind === k).length;
    if (opts.json) { printJson(rows); return 0; }
    for (const r of rows) console.log(`${r.kind.padEnd(14)}  ${r.name}  ->  ${r.page ?? '-'}  (${r.why})`);
    console.log(`${rows.length} files: ${count('project-fact')} project-fact, ${count('behaviour-rule')} behaviour-rule, ${count('decision-or-status')} decision-or-status, ${count('unsure')} unsure.`);
    return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exit(main(process.argv.slice(2)));
