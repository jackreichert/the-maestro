// Worker for tandem-fuzz.test.ts: one "window" writing handoffs and ledger rows into a shared scratch root as fast as it can.
// Args: <vault> <window> <startAtMs> <handoffs> <rows>. Prints one JSON line: the handoff names it created.
import { openStore } from './store.ts';
import { writeHandoffSeries } from './handoff.ts';

const [vault, window, startAt, handoffs, rows] = process.argv.slice(2) as [string, string, string, string, string];
const store = openStore({ vault, project: 'fuzz', dryRun: false, window });
store.ensureDir();
while (Date.now() < Number(startAt)) { /* spin until every worker is up, so the writes collide */ }
const created: string[] = [];
for (let i = 0; i < Math.max(Number(handoffs), Number(rows)); i++) {
    if (i < Number(rows)) store.append({ id: `${window}-${i}`, ts: new Date().toISOString(), kind: 'wip', text: `row ${i} from ${window}` });
    if (i < Number(handoffs)) {
        const got = writeHandoffSeries(store.dir, '2026-10-03', 'all', 'HANDOFF-2026-10-03-all.md', `from ${window} #${i}\n`);
        if (got) created.push(got.name);
    }
}
console.log(JSON.stringify({ window, created }));
