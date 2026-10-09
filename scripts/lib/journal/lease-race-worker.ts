// Worker for lease-race.test.ts: one "window" trying to lease every item in a shared scratch ledger at the same instant.
// Args: <vault> <window> <startAtMs> <items> [steal]; with `steal` it takes each item with --steal (the test seeds a holder first). Prints one JSON line: the items this window was told it holds.
import { openStore } from './store.ts';
import { acquireLease } from './leases.ts';

const [vault, window, startAt, items, mode] = process.argv.slice(2) as [string, string, string, string, string | undefined];
const store = openStore({ vault, project: 'race', dryRun: false, window });
store.ensureDir();
// Steal mode uses wide slots and holds each append back 150 ms into its slot (a loaded machine delays a process by far less), so every stealer has read the ledger and seen the same holder
// before any steal row lands. (A stealer that reads after another's row is a legitimate second steal, not a race.)
const SLOT = mode === 'steal' ? 400 : 40;
const HOLD = 150 + 40 * Number(window.replace(/\D+/g, '') || 0);   // each stealer lands 40 ms after the one before, so its re-read comes before the next steal row
let slot = 0;
const delayed = (row: object) => { if (mode === 'steal') while (Date.now() < Number(startAt) + slot * SLOT + HOLD) { /* spin */ } return store.append(row); };
const ctx = { readLedger: store.readLedger, append: delayed, window, now: () => new Date().toISOString(), dryRun: false };
const won: string[] = [];
// Every item has its own start slot, so all workers reach its read and its write together instead of one running ahead.
for (let i = 0; i < Number(items); i++) {
    slot = i;
    while (Date.now() < Number(startAt) + i * SLOT) { /* spin */ }
    if (acquireLease(ctx, `it${i}`, { ttlMinutes: 30, steal: mode === 'steal' }).ok) won.push(`it${i}`);
}
console.log(JSON.stringify({ window, won }));
