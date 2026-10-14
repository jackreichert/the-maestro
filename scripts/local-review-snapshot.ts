// Producer for the Podium's local review queue: scans the container's repos and writes the result to one JSON file.
// Run: node scripts/local-review-snapshot.ts --container <dir> --out <file> [--budget-ms 60000]
// The web server starts this in the background and only reads the file, so a slow scan never blocks a request.
import { scanLocalReview } from './lib/web/local-review.ts';
import { classCacheFile, readClassCache, writeClassCache, writeSnapshot } from './lib/web/local-review-cache.ts';

const arg = (flag: string): string => { const i = process.argv.indexOf(flag); return i >= 0 ? (process.argv[i + 1] ?? '') : ''; };
const container = arg('--container');
const out = arg('--out');
if (!container || !out) { console.error('usage: node scripts/local-review-snapshot.ts --container <dir> --out <file> [--budget-ms N]'); process.exit(2); }
const budgetMs = Number.parseInt(arg('--budget-ms'), 10);
const classCache = readClassCache(classCacheFile(out));
const review = scanLocalReview({ containerRoot: container, vault: '', now: new Date(), classCache, ...(Number.isFinite(budgetMs) ? { budgetMs } : {}) });
writeClassCache(classCacheFile(out), classCache);
writeSnapshot(out, review);
