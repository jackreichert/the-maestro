// Shard 4 of 4 of the pr-open cases (see lib/shard.ts): node --test scripts/pr-open.shard-4.test.ts
import { setShard } from './lib/shard.ts';

setShard(4, 4);
await import('./pr-open.cases.ts');
