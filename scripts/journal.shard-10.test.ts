// Shard 10 of 10 of the journal cases (see lib/shard.ts): node --test scripts/journal.shard-10.test.ts
import { setShard } from './lib/shard.ts';

setShard(10, 10);
await import('./journal.cases.ts');
