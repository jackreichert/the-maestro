/** The numbers behind the status footer's Session line; `unavailable` is why there are none. `advice` is `roll soon`, `roll now` or empty. */
export type SessionStatus =
    | { available: true; /** First 8 characters of the transcript's session id; absent on a status that did not read one. */ session?: string; /** True when no session was named, so the numbers are the newest transcript's, which may belong to another window. */ newest?: true; turns: number; /** Turns before the last compaction; absent when the session never compacted. */ turnsBefore?: number; ctxK: number; triggerK: number; pct: number; readK: number; advice: '' | 'roll soon' | 'roll now' }
    | { available: false; unavailable: string };

/** The Session line text for a `SessionStatus`. Pure, so the status page formats it the same way the footer does. */
export const sessionText = (s: SessionStatus): string =>
    (s.available ? `**Session:** ${s.session ? `${s.session}${s.newest ? ' (newest transcript)' : ''} · ` : ''}${s.turns} turns${s.turnsBefore ? ` since compact (${s.turnsBefore} before)` : ''} · ctx ${s.ctxK}k of ~${s.triggerK}k (${s.pct}%) · ${s.readK}k read/turn${s.advice ? ` · ${s.advice}` : ''}` : `**Session:** unavailable (${s.unavailable})`);
