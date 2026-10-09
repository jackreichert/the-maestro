// Shard 1 of 4 of the pr-open cases (see lib/shard.ts): node --test scripts/pr-open.shard-1.test.ts
import { setShard } from './lib/shard.ts';

setShard(1, 4);
await import('./pr-open.cases.ts');
