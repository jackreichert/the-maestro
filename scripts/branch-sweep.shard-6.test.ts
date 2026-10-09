// Shard 6 of 6 of the branch-sweep cases (see lib/shard.ts): node --test scripts/branch-sweep.shard-6.test.ts
import { setShard } from './lib/shard.ts';

setShard(6, 6);
await import('./branch-sweep.cases.ts');
