import type { ModelPrice } from '../local-config.ts';

/** The model families that have their own price row; any other family takes the optional `other` row. */
export const FAMILIES = ['opus', 'sonnet', 'haiku'];

/** Per-turn tokens: uncached input, cache writes (total, and the 5m/1h split when usage gives one), cache reads, output. */
export interface Usage { fresh: number; write: number; write5m: number; write1h: number; read: number; out: number }

/** Tokens by price kind: fresh input, 5m and 1h cache writes, cache reads, output. */
export interface Kinds { fresh: number; w5: number; w1: number; read: number; out: number }

/** Dollars in the four report categories, and their total. */
export interface Dollars { read: number; write: number; output: number; input: number; total: number }

/** A turn's tokens by price kind. A write is 5m unless usage split it into 5m and 1h. */
export function kindsOf(t: Usage): Kinds {
    const split = t.write5m + t.write1h > 0;
    return { fresh: t.fresh, w5: split ? t.write5m : t.write, w1: split ? t.write1h : 0, read: t.read, out: t.out };
}

/** Prices apply to opus, sonnet and haiku by name; any other family (fable included) takes the optional `other` row. */
export const priceKey = (f: string): string => (FAMILIES.includes(f) ? f : 'other');
/** Dollars for `k` tokens at `p` (dollars per MTok), split into the four report categories. */
export function dollars(k: Kinds, p: ModelPrice): Dollars {
    const d = { read: (k.read * p.cache_read) / 1e6, write: (k.w5 * p.cache_write_5m + k.w1 * p.cache_write_1h) / 1e6, output: (k.out * p.output) / 1e6, input: (k.fresh * p.input) / 1e6 };
    return { ...d, total: d.read + d.write + d.output + d.input };
}
