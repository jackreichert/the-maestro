// Shard 7 of 10 of the journal cases (see lib/shard.ts): node --test scripts/journal.shard-7.test.ts
import { setShard } from './lib/shard.ts';

setShard(7, 10);
await import('./journal.cases.ts');
