// Shard 4 of 10 of the journal cases (see lib/shard.ts): node --test scripts/journal.shard-4.test.ts
import { setShard } from './lib/shard.ts';

setShard(4, 10);
await import('./journal.cases.ts');
