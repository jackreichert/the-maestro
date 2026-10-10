// Shard 9 of 10 of the journal cases (see lib/shard.ts): node --test scripts/journal.shard-9.test.ts
import { setShard } from './lib/shard.ts';

setShard(9, 10);
await import('./journal.cases.ts');
