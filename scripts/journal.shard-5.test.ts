// Shard 5 of 10 of the journal cases (see lib/shard.ts): node --test scripts/journal.shard-5.test.ts
import { setShard } from './lib/shard.ts';

setShard(5, 10);
await import('./journal.cases.ts');
