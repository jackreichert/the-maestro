// Shard 3 of 10 of the journal cases (see lib/shard.ts): node --test scripts/journal.shard-3.test.ts
import { setShard } from './lib/shard.ts';

setShard(3, 10);
await import('./journal.cases.ts');
