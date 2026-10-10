// Worker for library-write.test.ts: one composer process trying to `begin` at an agreed instant.
// Args: <vault> <startAtMs>. Prints one JSON line: whether it won, and its holder id.
import { openStore } from './lib/journal/store.ts';
import { begin } from './lib/library/write.ts';

const [vault, startAt] = process.argv.slice(2) as [string, string];
const store = openStore({ vault, project: 'race', dryRun: false });
store.ensureDir();
while (Date.now() < Number(startAt)) { /* spin so every racer reads and writes together */ }
const res = begin({ vault, readLedger: store.readLedger, append: store.append, newId: store.newId, now: () => new Date().toISOString() });
console.log(JSON.stringify({ won: res.ok, holder: res.ok ? res.holder : null }));
