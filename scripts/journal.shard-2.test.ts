// Shard 2 of 10 of the journal cases (see lib/shard.ts): node --test scripts/journal.shard-2.test.ts
import { setShard } from './lib/shard.ts';

setShard(2, 10);
await import('./journal.cases.ts');
