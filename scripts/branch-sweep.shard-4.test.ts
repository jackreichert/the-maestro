// Shard 4 of 6 of the branch-sweep cases (see lib/shard.ts): node --test scripts/branch-sweep.shard-4.test.ts
import { setShard } from './lib/shard.ts';

setShard(4, 6);
await import('./branch-sweep.cases.ts');
