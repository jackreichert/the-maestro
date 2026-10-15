#!/usr/bin/env node
/**
 * RULE HYGIENE: read-only list of memory rules that do not say what enforces them, and which of those the user had to repeat.
 *
 *   node scripts/rule-hygiene.ts --memory-dir <dir> [--audit <file.md>] [--json]
 *
 * Every memory file (MEMORY.md, the index, is skipped) should carry `enforced-by: hook | script: <path> | check | none` in its
 * frontmatter. The report lists files with no value or an invalid one. With --audit, memory names cited in the audit's
 * repeated-instruction table are cross-referenced: a rule the user repeated that is enforced by `none` or by nothing is a promotion
 * candidate (make it a hook, script or check). It never writes, edits or deletes anything and prints no rule text.
 * Exit codes: 0 when every rule is tagged and no repeated rule is unenforced; 1 otherwise; 2 on a usage or read error.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { printJson } from './lib/json-out.ts';
import { readEnforcedBy, repeatViolations } from './lib/rule-hygiene.ts';
import type { RuleStatus } from './lib/rule-hygiene.ts';

const USAGE = 'Usage: rule-hygiene.ts --memory-dir <dir> [--audit <file.md>] [--json]';

/** The options from argv, or the reason they are unusable. */
export function parseOptions(argv: string[]): { memoryDir: string; audit?: string; json: boolean } | string {
    const values = new Map<string, string>();
    let json = false;
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--json') json = true;
        else if (a === '--memory-dir' || a === '--audit') {
            const v = argv[i + 1];
            if (v === undefined || v.startsWith('--')) return `${a} needs a value`;
            values.set(a, v);
            i += 1;
        } else return `unknown argument ${a}`;
    }
    const memoryDir = values.get('--memory-dir');
    if (!memoryDir) return '--memory-dir is required';
    return { memoryDir, audit: values.get('--audit'), json };
}

function main(argv: string[]): number {
    const opts = parseOptions(argv);
    if (typeof opts === 'string') { console.error(`${opts}\n${USAGE}`); return 2; }
    if (!existsSync(opts.memoryDir)) { console.error(`no memory directory at ${opts.memoryDir}`); return 2; }
    if (opts.audit && !existsSync(opts.audit)) { console.error(`no audit file at ${opts.audit}`); return 2; }
    const names = readdirSync(opts.memoryDir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md').sort();
    const rules: RuleStatus[] = names.map((f) => readEnforcedBy({ name: f.replace(/\.md$/, ''), text: readFileSync(join(opts.memoryDir, f), 'utf8') }));
    const byName = new Map(rules.map((r) => [r.name, r]));
    const repeats = opts.audit ? repeatViolations(readFileSync(opts.audit, 'utf8'), new Set(byName.keys())) : [];
    const promote = repeats.filter((r) => byName.get(r.rule)?.enforcedBy === null || byName.get(r.rule)?.enforcedBy === 'none');
    const untagged = rules.filter((r) => r.problem);
    if (opts.json) {
        printJson({ total: rules.length, untagged: untagged.map((r) => ({ rule: r.name, problem: r.problem })), repeats, promote: promote.map((r) => r.rule) });
    } else {
        console.log(`${rules.length} rules, ${rules.length - untagged.length} tagged enforced-by, ${untagged.length} not.`);
        for (const r of untagged) console.log(`  ${r.problem === 'invalid' ? 'INVALID' : 'MISSING'}  ${r.name}`);
        if (opts.audit) {
            console.log(`Repeat violations in the audit (${repeats.length} rules cited):`);
            for (const r of repeats) console.log(`  ${promote.includes(r) ? 'PROMOTE' : 'ok     '}  ${r.rule}  rows=${r.rows} enforced-by=${byName.get(r.rule)?.enforcedBy ?? 'unset'}`);
        }
    }
    return untagged.length > 0 || promote.length > 0 ? 1 : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exit(main(process.argv.slice(2)));
