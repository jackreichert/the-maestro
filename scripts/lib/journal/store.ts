import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { parseLedger, readRegistry } from '../ledger-core.ts';
import type { LedgerRow, Registry } from '../ledger-core.ts';

/**
 * The ledger and stream-registry store for one run: paths, reads, appends and the registry cache.
 * One instance per process, so a registry saved mid-run is the one later writes see.
 */
/** `warn` receives the store's own diagnostics (malformed ledger lines, a bad registry); it defaults to stderr, and a server passes a quiet one. */
export interface StoreOptions { vault: string; project: string; dryRun: boolean; warn?: (message: string) => void }
export interface Store {
    dir: string;
    ledgerPath: string;
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

export function openStore({ vault, project, dryRun, warn = (m) => console.error(m) }: StoreOptions): Store {
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

    function append<E>(entry: E): E {
        ensureDir();
        if (dryRun) { console.log('[dry-run]', JSON.stringify(entry)); return entry; }
        appendFileSync(ledgerPath, JSON.stringify(entry) + '\n');
        return entry;
    }

    /** Append several rows in one write, so a batch is either all there or (on a crash) a prefix of whole lines. */
    function appendMany<E>(entries: E[]): E[] {
        ensureDir();
        if (dryRun) { entries.forEach((e) => console.log('[dry-run]', JSON.stringify(e))); return entries; }
        if (entries.length) appendFileSync(ledgerPath, entries.map((e) => JSON.stringify(e) + '\n').join(''));
        return entries;
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

    return { dir, ledgerPath, registryPath, rollPoint, ensureDir, readLedger, append, appendMany, loadRegistry, saveRegistry, newId };
}
