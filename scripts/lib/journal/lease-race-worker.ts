// Worker for lease-race.test.ts: one "window" trying to lease every item in a shared scratch ledger at the same instant.
// Args: <vault> <window> <startAtMs> <items> [steal]; with `steal` it takes each item with `--steal h` (the test seeds window h as the holder first). Prints one JSON line: the items this window was told it holds.
import { openStore } from './store.ts';
import { acquireLease } from './leases.ts';

const [vault, window, startAt, items, mode] = process.argv.slice(2) as [string, string, string, string, string | undefined];
const store = openStore({ vault, project: 'race', dryRun: false, window });
store.ensureDir();
// Steal mode names the seeded holder `h` (the window every racer observed holding the lease), so which racer wins does not depend on how
// the reads and appends interleave: the first steal row counts and every later one names a holder that is gone. The slot only lines the racers up.
const SLOT = mode === 'steal' ? 300 : 40;
const ctx = { readLedger: store.readLedger, append: store.append, window, now: () => new Date().toISOString(), dryRun: false };
const won: string[] = [];
// Every item has its own start slot, so all workers reach its read and its write together instead of one running ahead.
for (let i = 0; i < Number(items); i++) {
    while (Date.now() < Number(startAt) + i * SLOT) { /* spin */ }
    if (acquireLease(ctx, `it${i}`, { ttlMinutes: 30, steal: mode === 'steal' ? 'h' : false }).ok) won.push(`it${i}`);
}
console.log(JSON.stringify({ window, won }));
