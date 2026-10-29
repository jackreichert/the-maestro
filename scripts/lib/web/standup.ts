/** The standup widget's data for `GET /api/standup?days=N`: the paste-ready text over the N whole days before today, read from the ledger on every call. */
import { openStore } from '../journal/store.ts';
import { boardContextFor } from '../journal/board-context.ts';
import { groups } from '../journal/board.ts';
import { MAX_DAYS, MIN_DAYS, defaultDays, parseDays, standupRange } from '../journal/standup-range.ts';
import type { StandupRange } from '../journal/standup-range.ts';
import { ledgerDay } from '../day-basis.ts';
import { localDate } from '../status-page/priorities.ts';
import type { WebConfig } from './api.ts';

/** A request the server refuses with 400: the route threw it, the server answers it. */
export class BadRequest extends Error {}

/** The standup text. `days` is read from the query as given: absent means the default window for today; present but not a whole number in range is a BadRequest, never clamped. */
export function buildStandup(cfg: WebConfig, query: URLSearchParams, now: Date): StandupRange {
  const given = query.getAll('days');
  if (given.length > 1) throw new BadRequest('days given more than once');
  const today = localDate(now, cfg.page.tz);
  const days = given.length === 0 ? defaultDays(today) : parseDays(given[0]);
  if (days === null) throw new BadRequest(`days must be a whole number from ${MIN_DAYS} to ${MAX_DAYS}`);
  const store = openStore({ vault: cfg.vault, project: cfg.project, dryRun: false, warn: cfg.warn ?? (() => {}) });
  const ctx = boardContextFor(store, { has: () => false, today: () => ledgerDay(now), deferDay: () => today, dryRun: false });
  return standupRange(groups(ctx), { today, days, tz: cfg.page.tz });
}
