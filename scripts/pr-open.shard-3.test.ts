// Shard 3 of 4 of the pr-open cases (see lib/shard.ts): node --test scripts/pr-open.shard-3.test.ts
import { setShard } from './lib/shard.ts';

setShard(3, 4);
await import('./pr-open.cases.ts');
