import type { LedgerRow, Registry } from '../ledger-core.ts';
import { askBits } from './ask-fields.ts';

/** A row, or a folded item: the closing row is there once something closed it. */
type Item = LedgerRow & { closedBy?: LedgerRow | null };

export function editDistance(a: string, b: string): number {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
    }
    return d[a.length][b.length];
}

/** Nearest registered name or alias, as its canonical stream; null when nothing is close. */
export function didYouMean(reg: Pick<Registry, 'streams'>, name: string): string | null {
    const k = name.trim().toLowerCase();
    let best: { canon: string; dist: number } | null = null;
    for (const [canon, meta] of Object.entries(reg.streams)) {
        for (const cand of [canon, ...(meta?.aliases || [])]) {
            const c = String(cand).toLowerCase();
            const dist = c.includes(k) || k.includes(c) ? 1 : editDistance(k, c);
            if (dist <= Math.max(2, Math.floor(k.length / 3)) && (!best || dist < best.dist)) best = { canon, dist };
        }
    }
    return best?.canon ?? null;
}

export function formatUsed(used: unknown): string | null {
    if (!used) return null;
    return Array.isArray(used) ? used.join(', ') : String(used);
}

export function usageSuffix(i: Item): string {
    const model = i.model || 'unrecorded';
    const used = formatUsed(i.used) || 'unrecorded';
    const bits = [`model: ${model}`, `used: ${used}`];
    if (i.closedBy?.model && i.closedBy.model !== i.model) {
        bits[0] = `model: ${model} → ${i.closedBy.model}`;
    }
    if (i.harness) bits.push(`harness: ${i.harness}`);
    if (i.tokens) bits.push(`tokens: ${i.tokens}`);
    return bits.join(' · ');
}

export function fmt(i: Item, { showId = true, showUsage = true } = {}): string {
    const bits: (string | undefined)[] = [];
    if (showId) bits.push(`\`${i.id}\``);
    bits.push(i.text);
    const tail: string[] = [];
    if (i.repo) tail.push(i.repo);
    if (i.ticket) tail.push(`[[${i.ticket}]]`);
    if (i.paste) tail.push(`block: ${i.paste}`);
    if (i.gate) tail.push(`gate: ${i.gate}`);
    if ((i.kind === 'question' || i.kind === 'decision') && !i.paste) tail.push(...askBits(i));
    if (showUsage) tail.push(usageSuffix(i));
    if (tail.length) bits.push(`— ${tail.join(' · ')}`);
    return bits.join(' ');
}

export const slug = (s: string): string => s.trim().replace(/[\s/\\]+/g, '-');
export const cell = (v: unknown): string => String(v ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
export const clip = (v: unknown, n = 140): string => { const t = String(v ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

export const itemText = (i: { text?: string; closedBy?: { text?: string } | null }): string => [i.text, i.closedBy && i.closedBy.text !== i.text ? i.closedBy.text : ''].filter(Boolean).join(' — ');
