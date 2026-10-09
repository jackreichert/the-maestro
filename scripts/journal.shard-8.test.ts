// Shard 8 of 10 of the journal cases (see lib/shard.ts): node --test scripts/journal.shard-8.test.ts
import { setShard } from './lib/shard.ts';

setShard(8, 10);
await import('./journal.cases.ts');
