/**
 * Turns an approved project-fact file into a pointer to its library page; the default is a dry run.
 * The plan never writes. A file becomes a pointer only when the user approved it by name AND its library page already exists with a
 * `verified-at` (the composer writes the page first; this never writes one).
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Sorted } from './memory-sort.ts';

export type Step = 'point' | 'wait-for-page' | 'wait-for-approval';

export interface Planned { name: string; page: string; step: Step; why: string }

function pageVerified(vault: string, page: string): boolean {
    const path = join(vault, page);
    if (!existsSync(path)) return false;
    return /^verified-at:\s*\S+/m.test(readFileSync(path, 'utf8').split(/\n---\n/)[0] ?? '');
}

/** One step per project fact. Facts only: rules, decisions and unsure files are not planned. */
export function plan(sorted: Sorted[], vault: string, approved: Set<string>): Planned[] {
    return sorted.filter((s) => s.kind === 'project-fact' && s.page).map((s) => {
        const page = s.page as string;
        if (!pageVerified(vault, page)) return { name: s.name, page, step: 'wait-for-page', why: 'no library page with verified-at yet: the composer writes it first' };
        if (!approved.has(s.name)) return { name: s.name, page, step: 'wait-for-approval', why: 'page exists; the user has not approved this file' };
        return { name: s.name, page, step: 'point', why: 'approved and the page is verified' };
    });
}

/** Replace the body of each `point` step's memory file with a one-line pointer, keeping its frontmatter. Returns the names changed. */
export function apply(planned: Planned[], memoryDir: string): string[] {
    const done: string[] = [];
    for (const p of planned.filter((x) => x.step === 'point')) {
        const path = join(memoryDir, `${p.name}.md`);
        const text = readFileSync(path, 'utf8');
        const m = /^(---\n[\s\S]*?\n---\n)/.exec(text);
        if (!m) continue;
        const pointer = `${m[1]}Moved to the library: [[${p.page.replace(/\.md$/, '')}]]\n`;
        if (pointer === text) continue;
        writeFileSync(`${path}.tmp`, pointer);
        renameSync(`${path}.tmp`, path);
        done.push(p.name);
    }
    return done;
}
