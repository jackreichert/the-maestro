/** The numbers behind the status footer's Session line; `unavailable` is why there are none. `advice` is `roll soon`, `roll now` or empty. */
export type SessionStatus =
    | { available: true; turns: number; ctxK: number; triggerK: number; pct: number; readK: number; advice: '' | 'roll soon' | 'roll now' }
    | { available: false; unavailable: string };

/** The Session line text for a `SessionStatus`. Pure, so the status page formats it the same way the footer does. */
export const sessionText = (s: SessionStatus): string =>
    (s.available ? `**Session:** ${s.turns} turns · ctx ${s.ctxK}k of ~${s.triggerK}k (${s.pct}%) · ${s.readK}k read/turn${s.advice ? ` · ${s.advice}` : ''}` : `**Session:** unavailable (${s.unavailable})`);
