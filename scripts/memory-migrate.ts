#!/usr/bin/env node
/**
 * MEMORY MIGRATE: dry run by default. Lists, for each project-fact memory file, what the move to the library needs next.
 *
 *   node scripts/memory-migrate.ts --memory-dir <dir> --vault <root> [--approved <file>] [--hints <file.json>] [--apply]
 *
 * Steps: `wait-for-page` (the composer has not written the page), `wait-for-approval` (the page exists, the user has not approved
 * the file), `point` (both hold). `--approved` is a text file with one memory name per line. Only with `--apply` does a `point`
 * file become a one-line pointer (frontmatter kept); nothing else is ever edited, deleted or created, and the library pages are
 * never written here. `--apply` without `--approved` is refused. Exit 0 on success, 2 on a usage or read error.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { apply, plan } from './lib/memory-migrate.ts';
import { readHints, sortDir } from './memory-sort.ts';

const USAGE = 'Usage: memory-migrate.ts --memory-dir <dir> --vault <root> [--approved <file>] [--hints <file.json>] [--apply]';

type Opts = { memoryDir: string; vault: string; approved?: string; hints?: string; apply: boolean };

export function parseOptions(argv: string[]): Opts | string {
    const v = new Map<string, string>();
    let doApply = false;
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--apply') doApply = true;
        else if (a === '--memory-dir' || a === '--vault' || a === '--approved' || a === '--hints') {
            const val = argv[i + 1];
            if (val === undefined || val.startsWith('--')) return `${a} needs a value`;
            v.set(a, val);
            i += 1;
        } else return `unknown argument ${a}`;
    }
    const memoryDir = v.get('--memory-dir');
    const vault = v.get('--vault');
    if (!memoryDir || !vault) return '--memory-dir and --vault are required';
    if (doApply && !v.get('--approved')) return '--apply needs --approved <file>: nothing moves without the user\'s answer';
    return { memoryDir, vault, approved: v.get('--approved'), hints: v.get('--hints'), apply: doApply };
}

function main(argv: string[]): number {
    const o = parseOptions(argv);
    if (typeof o === 'string') { console.error(`${o}\n${USAGE}`); return 2; }
    for (const p of [o.memoryDir, o.vault, ...(o.approved ? [o.approved] : []), ...(o.hints ? [o.hints] : [])]) if (!existsSync(p)) { console.error(`no such path: ${p}`); return 2; }
    const approved = new Set(o.approved ? readFileSync(o.approved, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean) : []);
    let hints: ReturnType<typeof readHints> = [];
    try { hints = o.hints ? readHints(o.hints) : []; } catch (e) { console.error(`hints: ${e instanceof Error ? e.message : String(e)}`); return 2; }
    const planned = plan(sortDir(o.memoryDir, hints), o.vault, approved);
    for (const p of planned) console.log(`${p.step.padEnd(17)}  ${p.name}  ->  ${p.page}  (${p.why})`);
    if (!o.apply) { console.log(`${planned.length} project facts. Dry run: nothing was changed.`); return 0; }
    const done = apply(planned, o.memoryDir);
    console.log(`${done.length} memory files replaced by a pointer.`);
    return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exit(main(process.argv.slice(2)));
