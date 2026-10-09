/**
 * Test support: split one big test file across several `node --test` processes.
 *
 * `node --test` runs files in parallel but the tests inside one file one after another, so a
 * 170-test file that spawns the CLI hundreds of times dominates the wall time of the whole suite.
 * The cases live in `<name>.cases.ts`, which imports `test` from here instead of `node:test`; each
 * `<name>.shard-N.test.ts` calls `setShard(N, TOTAL)` and then imports the cases, and registers
 * only every TOTAL-th test. Tests keep their names, and run as they did (each has its own fixtures).
 * Run without a shard (the cases file's default) and every test registers.
 */
import { test as nodeTest } from 'node:test';

let index = 0;
let total = 1;
let seen = 0;

/** Picks this process's slice: shard `n` of `of` (1-based). Call before importing the cases. */
export function setShard(n: number, of: number): void {
    if (!Number.isInteger(n) || !Number.isInteger(of) || n < 1 || n > of) throw new Error(`bad shard ${n}/${of}`);
    index = n - 1;
    total = of;
    seen = 0;
}

/** `node:test`'s `test`, registering only the tests that belong to this shard. */
export const test = ((...args: Parameters<typeof nodeTest>) => {
    const mine = seen % total === index;
    seen += 1;
    if (mine) return nodeTest(...args);
    return undefined;
}) as typeof nodeTest;
