// Shard 1 of 6 of the branch-sweep cases (see lib/shard.ts): node --test scripts/branch-sweep.shard-1.test.ts
import { setShard } from './lib/shard.ts';

setShard(1, 6);
await import('./branch-sweep.cases.ts');
