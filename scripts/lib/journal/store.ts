import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { parseLedger, readRegistry } from '../ledger-core.ts';
import type { LedgerRow, Registry } from '../ledger-core.ts';
import { normaliseUsed } from '../ledger-tags.ts';
import { dryRunJson } from '../json-out.ts';
import { describeFindings, scanFields } from '../secret-scan.ts';

/** A row refused because a field has the shape of a credential or of patient data. The message names fields and rules, never the text. */
export class LedgerScanError extends Error {}

/**
 * Fields the program itself generates (ids, times, the row kind, hashes). `model`, `window`, `used` and `tokens` are NOT here: they come from
 * flags and the environment, so a secret passed in one would otherwise ride into the ledger unscanned.
 */
const MACHINE_FIELDS = new Set(['id', 'ts', 'date', 'kind', 'pageSha', 'sha256', 'verifiedAt']);

/**
 * Every reason to refuse `row`: each prose field (strings, and lists of strings joined) goes through the shared secret and PHI scanner.
 * The ledger is durable and shared, so a pasted credential or a date of birth is refused at the one door every writer uses, `append` and `appendMany`,
 * not left to each command to remember. A refusal prints the field and the rule, never the value: the value that failed may be the secret.
 */
export function rowScanProblems(row: unknown): string[] {
    if (typeof row !== 'object' || row === null) return [];
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
        if (MACHINE_FIELDS.has(k)) continue;
        if (typeof v === 'string') fields[k] = v;
        else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) fields[k] = v.join(' ');
    }
    return describeFindings(scanFields(fields));
}

/**
 * The ledger and stream-registry store for one run: paths, reads, appends and the registry cache.
 * One instance per process, so a registry saved mid-run is the one later writes see.
 */
/** `warn` receives the store's own diagnostics (malformed ledger lines, a bad registry); it defaults to stderr, and a server passes a quiet one. */
/** `window` is the id of the orchestrator window writing (see lib/window-id.ts); every row appended without its own `window` field carries it. */
export interface StoreOptions { vault: string; project: string; dryRun: boolean; warn?: (message: string) => void; window?: string }
export interface Store {
    dir: string;
    ledgerPath: string;
    window: string | undefined;
    registryPath: string;
    rollPoint(entries: LedgerRow[], d: string | undefined): string | null | undefined;
    ensureDir(): void;
    readLedger(): LedgerRow[];
    append<E>(entry: E): E;
    appendMany<E>(entries: E[]): E[];
    loadRegistry(): Registry | null;
    saveRegistry(reg: Registry): void;
    newId(existing: { id?: string }[]): string;
}

export function openStore({ vault, project, dryRun, warn = (m) => console.error(m), window }: StoreOptions): Store {
    const dir = join(vault, 'Projects', project, 'Journal');
    const ledgerPath = join(dir, 'ledger.jsonl');

    /**
     * A roll is recorded in the ledger with a timestamp, not inferred from the
     * archive file existing. Work finished AFTER a roll still shows in CURRENT.md,
     * so rolling at 5pm does not hide the evening's work.
     */
    function rollPoint(entries: LedgerRow[], d: string | undefined): string | null | undefined {
        const marks = entries.filter((e) => e.kind === 'rolled' && e.date === d);
        return marks.length ? marks[marks.length - 1].ts : null;
    }

    function ensureDir(): void {
        if (!dryRun) mkdirSync(dir, { recursive: true });
    }

    function readLedger(): LedgerRow[] {
        if (!existsSync(ledgerPath)) return [];
        return parseLedger(readFileSync(ledgerPath, 'utf8'), (n) => warn(`  skipped malformed line ${n}`));
    }

    /**
     * The row as it is written: this run's window id added (a row that already names a window keeps it; a store with no window
     * adds none) and its `used` tool marks in canonical form (lib/ledger-tags.ts), so every writer, not only the CLI, tags one tool one way.
     */
    function stamped<E>(entry: E): E {
        if (typeof entry !== 'object' || entry === null) return entry;
        const row: Record<string, unknown> = { ...(entry as Record<string, unknown>) };
        if (window && !('window' in row)) row.window = window;
        if (row.used !== undefined) row.used = normaliseUsed(row.used);
        return row as E;
    }

    /** Throws LedgerScanError, naming every field and rule, when any of `rows` carries a secret or PHI shape; nothing is written. */
    function refuseShapes(rows: unknown[]): void {
        const problems = rows.flatMap(rowScanProblems);
        if (problems.length) throw new LedgerScanError(`refused: the ledger is durable and shared, and a field looks like it holds a secret or PHI. Nothing was written.\n${[...new Set(problems)].map((p) => `  ${p}`).join('\n')}\nUse a placeholder such as <redacted>, or name the system or id instead.`);
    }

    function append<E>(entry: E): E {
        ensureDir();
        const row = stamped(entry);
        refuseShapes([row]);
        if (dryRun) { console.log('[dry-run]', dryRunJson(row)); return row; }
        appendFileSync(ledgerPath, JSON.stringify(row) + '\n');
        return row;
    }

    /** Append several rows in one write, so a batch is either all there or (on a crash) a prefix of whole lines. */
    function appendMany<E>(entries: E[]): E[] {
        ensureDir();
        const rows = entries.map(stamped);
        refuseShapes(rows);
        if (dryRun) { rows.forEach((e) => console.log('[dry-run]', dryRunJson(e))); return rows; }
        if (rows.length) appendFileSync(ledgerPath, rows.map((e) => JSON.stringify(e) + '\n').join(''));
        return rows;
    }

    const registryPath = join(vault, 'Projects', project, 'streams.json');
    let registryCache: Registry | null | undefined;

    /** The stream registry (see readRegistry in lib/ledger-core.ts), read once per run. */
    function loadRegistry(): Registry | null {
        if (registryCache === undefined) registryCache = readRegistry(registryPath, () => warn('  streams.json is malformed; ignoring the registry'));
        return registryCache ?? null;
    }

    function saveRegistry(reg: Registry): void {
        mkdirSync(dirname(registryPath), { recursive: true });
        const tmp = `${registryPath}.tmp-${process.pid}`;
        const out: Record<string, unknown> = {};
        if (reg.hasStreams || Object.keys(reg.streams).length) out.streams = reg.streams;
        if (reg.models) out.models = reg.models;
        writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n');
        renameSync(tmp, registryPath);
        registryCache = reg;
    }

    /** Short, collision-checked, human-typeable id. */
    function newId(existing: { id?: string }[]): string {
        const taken = new Set(existing.map((e) => e.id));
        for (let n = 0; ; n++) {
            const id = Math.random().toString(36).slice(2, 6);
            if (!taken.has(id) && !/^\d+$/.test(id)) return id;
            if (n > 500) return `${Date.now()}`.slice(-6);
        }
    }

    return { dir, ledgerPath, window, registryPath, rollPoint, ensureDir, readLedger, append, appendMany, loadRegistry, saveRegistry, newId };
}
