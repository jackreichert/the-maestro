// Worker for lease-race.test.ts: one "window" trying to lease every item in a shared scratch ledger at the same instant.
// Args: <vault> <window> <startAtMs> <items>. Prints one JSON line: the items this window was told it holds.
import { openStore } from './store.ts';
import { acquireLease } from './leases.ts';

const [vault, window, startAt, items] = process.argv.slice(2) as [string, string, string, string];
const store = openStore({ vault, project: 'race', dryRun: false, window });
store.ensureDir();
const ctx = { readLedger: store.readLedger, append: (row: object) => store.append(row), window, now: () => new Date().toISOString(), dryRun: false };
const won: string[] = [];
// Every item has its own start slot, so all workers reach its read and its write together instead of one running ahead.
for (let i = 0; i < Number(items); i++) {
    while (Date.now() < Number(startAt) + i * 40) { /* spin */ }
    if (acquireLease(ctx, `it${i}`, { ttlMinutes: 30 }).ok) won.push(`it${i}`);
}
console.log(JSON.stringify({ window, won }));
