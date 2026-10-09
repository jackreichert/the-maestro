// Shard 6 of 10 of the journal cases (see lib/shard.ts): node --test scripts/journal.shard-6.test.ts
import { setShard } from './lib/shard.ts';

setShard(6, 10);
await import('./journal.cases.ts');
