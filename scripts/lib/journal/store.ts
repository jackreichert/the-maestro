import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { readRegistry } from '../ledger-core.ts';

/**
 * The ledger and stream-registry store for one run: paths, reads, appends and the registry cache.
 * One instance per process, so a registry saved mid-run is the one later writes see.
 */
export function openStore({ vault, project, dryRun }) {
    const dir = join(vault, 'Projects', project, 'Journal');
    const ledgerPath = join(dir, 'ledger.jsonl');

    /**
     * A roll is recorded in the ledger with a timestamp, not inferred from the
     * archive file existing. Work finished AFTER a roll still shows in CURRENT.md,
     * so rolling at 5pm does not hide the evening's work.
     */
    function rollPoint(entries, d) {
        const marks = entries.filter((e) => e.kind === 'rolled' && e.date === d);
        return marks.length ? marks[marks.length - 1].ts : null;
    }

    function ensureDir() {
        if (!dryRun) mkdirSync(dir, { recursive: true });
    }

    function readLedger() {
        if (!existsSync(ledgerPath)) return [];
        return readFileSync(ledgerPath, 'utf8')
            .split('\n')
            .filter((l) => l.trim())
            .map((l, i) => {
                try { return JSON.parse(l); } catch { console.error(`  skipped malformed line ${i + 1}`); return null; }
            })
            .filter(Boolean);
    }

    function append(entry) {
        ensureDir();
        if (dryRun) { console.log('[dry-run]', JSON.stringify(entry)); return entry; }
        appendFileSync(ledgerPath, JSON.stringify(entry) + '\n');
        return entry;
    }

    /** Append several rows in one write, so a batch is either all there or (on a crash) a prefix of whole lines. */
    function appendMany(entries) {
        ensureDir();
        if (dryRun) { entries.forEach((e) => console.log('[dry-run]', JSON.stringify(e))); return entries; }
        if (entries.length) appendFileSync(ledgerPath, entries.map((e) => JSON.stringify(e) + '\n').join(''));
        return entries;
    }

    const registryPath = join(vault, 'Projects', project, 'streams.json');
    let registryCache;

    /** The stream registry (see readRegistry in lib/ledger-core.ts), read once per run. */
    function loadRegistry() {
        if (registryCache === undefined) registryCache = readRegistry(registryPath, () => console.error('  streams.json is malformed; ignoring the registry'));
        return registryCache;
    }

    function saveRegistry(reg) {
        mkdirSync(dirname(registryPath), { recursive: true });
        const tmp = `${registryPath}.tmp-${process.pid}`;
        const out = {};
        if (reg.hasStreams || Object.keys(reg.streams).length) out.streams = reg.streams;
        if (reg.models) out.models = reg.models;
        writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n');
        renameSync(tmp, registryPath);
        registryCache = reg;
    }

    /** Short, collision-checked, human-typeable id. */
    function newId(existing) {
        const taken = new Set(existing.map((e) => e.id));
        for (let n = 0; ; n++) {
            const id = Math.random().toString(36).slice(2, 6);
            if (!taken.has(id) && !/^\d+$/.test(id)) return id;
            if (n > 500) return `${Date.now()}`.slice(-6);
        }
    }

    return { dir, ledgerPath, registryPath, rollPoint, ensureDir, readLedger, append, appendMany, loadRegistry, saveRegistry, newId };
}
