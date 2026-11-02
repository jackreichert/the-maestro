// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/budget.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgetOn, crossed, dedupe, evaluate, isBudgetDay, parseBudget, periodOf, spendText } from './lib/budget.ts';
import type { BudgetConfig, BudgetRaw } from './lib/budget.ts';
import { parseCcusage, spendFooter, spendSince } from './lib/spend.ts';
import * as spendWatch from './event-types/spend-watch.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const UNSET: BudgetRaw = { monthly: '', startDay: '', days: '', warn: '', hard: '' };
const WEEKDAYS: BudgetConfig = { monthlyUsd: 500, startDay: 5, days: 'weekdays', warnFraction: 0.8, hardFraction: 1, costMultiplier: 1, weekendWeight: 0 };
const ALL: BudgetConfig = { ...WEEKDAYS, days: 'all' };

test('config: everything unset is off, with the documented defaults', () => {
  const c = parseBudget(UNSET);
  assert.equal(budgetOn(c), false);
  assert.deepEqual(c, { monthlyUsd: 0, startDay: 1, days: 'all', warnFraction: 0.8, hardFraction: 1, costMultiplier: 1, weekendWeight: 0 });
});

test('config: valid values parse, invalid ones fall back, hard never sits below warn', () => {
  assert.deepEqual(parseBudget({ monthly: '500', startDay: '5', days: 'Weekdays', warn: '0.7', hard: '0.9' }), { monthlyUsd: 500, startDay: 5, days: 'weekdays', warnFraction: 0.7, hardFraction: 0.9, costMultiplier: 1, weekendWeight: 0 });
  assert.deepEqual(parseBudget({ monthly: 'lots', startDay: '31', days: 'sometimes', warn: '-1', hard: 'x' }), { monthlyUsd: 0, startDay: 1, days: 'all', warnFraction: 0.8, hardFraction: 1, costMultiplier: 1, weekendWeight: 0 });
  assert.equal(parseBudget({ ...UNSET, warn: '0.9', hard: '0.5' }).hardFraction, 0.9);
});

test('period runs from the start day to the day before the next, across a month and a year boundary', () => {
  assert.deepEqual(periodOf('2026-11-05', 5), { start: '2026-11-05', end: '2026-12-04' });
  assert.deepEqual(periodOf('2026-11-04', 5), { start: '2026-10-05', end: '2026-11-04' });
  assert.deepEqual(periodOf('2027-01-02', 5), { start: '2026-12-05', end: '2027-01-04' });
  assert.deepEqual(periodOf('2026-03-01', 1), { start: '2026-03-01', end: '2026-03-31' });
});

test('weekdays: the Nov 5 period has 22 budget days, so the allowance is 500/22 a day', () => {
  // 2026-11-05 is a Thursday; Nov 5 to Dec 4 holds 22 weekdays.
  assert.equal(isBudgetDay('2026-11-05', 'weekdays'), true);
  assert.equal(isBudgetDay('2026-11-07', 'weekdays'), false);
  const v = evaluate(WEEKDAYS, '2026-11-05', {});
  assert.equal(v.budgetDays, 22);
  assert.ok(Math.abs(v.dailyAllowance - 500 / 22) < 1e-9);
  assert.equal(v.elapsed, 1);
});

test('weekdays period spanning a month boundary: pace counts only budget days elapsed, today included', () => {
  // Thu Nov 26 .. Mon Nov 30 .. Tue Dec 1: elapsed budget days from Nov 5 through Dec 1.
  const daily = { '2026-11-05': 20, '2026-11-30': 20, '2026-12-01': 10 };
  const v = evaluate(WEEKDAYS, '2026-12-01', daily);
  assert.equal(v.elapsed, 19);
  assert.ok(Math.abs(v.paceAllowance - (500 / 22) * 19) < 1e-9);
  assert.equal(v.periodSpend, 50);
  assert.equal(v.todaySpend, 10);
  assert.equal(v.overPace, false);
});

test('a weekend day with spend has no allowance, counts toward the period, and raises offday', () => {
  const v = evaluate(WEEKDAYS, '2026-11-07', { '2026-11-05': 1, '2026-11-06': 1, '2026-11-07': 4 });
  assert.equal(v.todayIsBudgetDay, false);
  assert.equal(v.todayAllowance, 0);
  assert.equal(v.periodSpend, 6);
  assert.deepEqual(crossed(WEEKDAYS, v).map((a) => a.key), ['offday']);
  assert.match(spendText(WEEKDAYS, v), /not a budget day, \$0 allowed/);
  const clean = evaluate(WEEKDAYS, '2026-11-07', { '2026-11-05': 1 });
  assert.deepEqual(crossed(WEEKDAYS, clean), []);
});

test('weekend spend past the pace flags the period as over', () => {
  const v = evaluate(WEEKDAYS, '2026-11-08', { '2026-11-05': 40, '2026-11-08': 8 });
  assert.equal(v.overPace, true);
  assert.deepEqual(crossed(WEEKDAYS, v).map((a) => a.key), ['offday', 'pace']);
});

test('all mode: every day is a budget day and the allowance divides by the period length', () => {
  const v = evaluate(ALL, '2026-11-07', { '2026-11-07': 17 });
  assert.equal(v.budgetDays, 30);
  assert.equal(v.todayIsBudgetDay, true);
  assert.ok(Math.abs(v.dailyAllowance - 500 / 30) < 1e-9);
  assert.equal(v.elapsed, 3);
  assert.deepEqual(crossed(ALL, v).map((a) => a.key), ['hard']);
});

test('warn at 80%, hard at 100% of the daily allowance; below warn is quiet', () => {
  const a = 500 / 22;
  const at = (spend: number) => crossed(WEEKDAYS, evaluate(WEEKDAYS, '2026-11-05', { '2026-11-05': spend })).map((x) => x.key);
  assert.deepEqual(at(a * 0.79), []);
  assert.deepEqual(at(a * 0.8), ['warn']);
  assert.deepEqual(at(a), ['hard']);
});

test('the footer text reads like the spec', () => {
  const v = evaluate(WEEKDAYS, '2026-11-05', { '2026-11-05': 14.2 });
  assert.equal(spendText(WEEKDAYS, v), 'Spend: $14.20 today of $22.73 · period $14 of $500 (on pace) · this machine');
});

test('dedupe: each threshold once a day, a new day resets, hard silences a later warn', () => {
  const warn = [{ key: 'warn' as const, text: 'w' }];
  const first = dedupe('2026-11-05', warn, null);
  assert.equal(first.fresh.length, 1);
  assert.equal(dedupe('2026-11-05', warn, first.next).fresh.length, 0);
  const both = dedupe('2026-11-05', [...warn, { key: 'pace' as const, text: 'p' }], first.next);
  assert.deepEqual(both.fresh.map((a) => a.key), ['pace']);
  assert.equal(dedupe('2026-11-06', warn, both.next).fresh.length, 1);
  const hard = dedupe('2026-11-05', [{ key: 'hard' as const, text: 'h' }], first.next);
  assert.equal(hard.fresh.length, 1);
  assert.equal(dedupe('2026-11-05', warn, hard.next).fresh.length, 0);
});

test('ccusage output: the daily list is summed by date; junk throws', () => {
  assert.deepEqual(parseCcusage('{"daily":[{"date":"2026-11-05","totalCost":1.5},{"date":"2026-11-05","totalCost":0.5},{"date":"x"}]}'), { '2026-11-05': 2 });
  assert.throws(() => parseCcusage('{"nope":1}'));
});

test('spend cache: ccusage runs once within 15 minutes, a failure is cached and keeps the last good figures', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'spend-')), 'c.json');
  let calls = 0;
  let out = { status: 0, stdout: '{"daily":[{"date":"2026-11-05","totalCost":3}]}', stderr: '' };
  const run = () => { calls++; return out; };
  const t0 = Date.parse('2026-11-05T15:00:00Z');
  assert.deepEqual(spendSince(file, run, '2026-11-05', 'UTC', t0).daily, { '2026-11-05': 3 });
  spendSince(file, run, '2026-11-05', 'UTC', t0 + 14 * 60_000);
  assert.equal(calls, 1);
  out = { status: 1, stdout: '', stderr: 'boom' };
  const bad = spendSince(file, run, '2026-11-05', 'UTC', t0 + 16 * 60_000);
  assert.equal(calls, 2);
  assert.match(bad.error ?? '', /ccusage exit 1: boom/);
  assert.deepEqual(bad.daily, { '2026-11-05': 3 });
  spendSince(file, run, '2026-11-05', 'UTC', t0 + 18 * 60_000);
  assert.equal(calls, 2);
});

test('spend-watch: off without a budget; on, it alerts once per threshold per day and says nothing on quiet ticks', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'spend-')), 'c.json');
  const money = (d: number) => ({ status: 0, stdout: JSON.stringify({ daily: [{ date: '2026-11-05', totalCost: d }] }), stderr: '' });
  const noRun = () => { throw new Error('ccusage must not run'); };
  const off = spendWatch.check('x', { now: 1, prev: null, run: noRun }, parseBudget(UNSET), 'UTC', file);
  assert.deepEqual(spendWatch.diff(null, off), []);
  const t0 = Date.parse('2026-11-05T15:00:00Z');
  const s1 = spendWatch.check('x', { now: t0, prev: null, run: () => money(20) }, WEEKDAYS, 'UTC', file);
  assert.equal(spendWatch.diff(null, s1).length, 1);
  assert.match(spendWatch.diff(null, s1)[0].summary, /WARN/);
  assert.equal(spendWatch.diff(null, s1)[0].actionable, true);
  const s2 = spendWatch.check('x', { now: t0 + 20 * 60_000, prev: s1, run: () => money(21) }, WEEKDAYS, 'UTC', file);
  assert.deepEqual(spendWatch.diff(s1, s2), []);
  const s3 = spendWatch.check('x', { now: t0 + 40 * 60_000, prev: s2, run: () => money(30) }, WEEKDAYS, 'UTC', file);
  assert.match(spendWatch.diff(s2, s3)[0].summary, /HARD/);
});

test('multiplier: scales ccusage before every comparison, shows as an estimate, and flags context over 200k', () => {
  const cfg = { ...WEEKDAYS, costMultiplier: 1.5 };
  assert.equal(parseBudget({ ...UNSET, multiplier: '1.47' }).costMultiplier, 1.47);
  assert.equal(parseBudget({ ...UNSET, multiplier: 'x' }).costMultiplier, 1);
  const v = evaluate(cfg, '2026-11-05', { '2026-11-05': 14 });
  assert.equal(v.todaySpend, 21);
  assert.deepEqual(crossed(cfg, v).map((a) => a.key), ['warn']);
  assert.equal(crossed(WEEKDAYS, evaluate(WEEKDAYS, '2026-11-05', { '2026-11-05': 14 })).length, 0);
  assert.equal(spendText(cfg, v), 'Spend: ~$21.00 today of $22.73 · period ~$21 of $500 (on pace) · this machine · x1.5 est.');
  assert.match(spendText(WEEKDAYS, v, 250), /this machine · ctx >200k: premium pricing$/);
  assert.doesNotMatch(spendText(WEEKDAYS, v, 150), /premium/);
});

test('spendFooter: empty with no budget, never runs ccusage; with one it reads the cache-backed figures', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'spend-')), 'c.json');
  const noRun = () => { throw new Error('ccusage must not run'); };
  assert.equal(spendFooter(parseBudget(UNSET), file, noRun, 'UTC', 1), '');
  const run = () => ({ status: 0, stdout: '{"daily":[{"date":"2026-11-05","totalCost":14.2}]}', stderr: '' });
  assert.match(spendFooter(WEEKDAYS, file, run, 'UTC', Date.parse('2026-11-05T15:00:00Z')), /^Spend: \$14\.20 today of \$22\.73/);
  const bad = () => ({ status: 1, stdout: '', stderr: 'no npx' });
  assert.match(spendFooter(WEEKDAYS, join(tmpdir(), 'nope-spend', 'x.json'), bad, 'UTC', Date.parse('2026-11-05T15:00:00Z')), /^Spend: unavailable \(ccusage exit 1: no npx\)/);
});

test('a failed read after a good one is never shown as current: unavailable on a new day, STALE with the age on the same day, and the watch says so once', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'spend-')), 'c.json');
  const good = () => ({ status: 0, stdout: '{"daily":[{"date":"2026-11-05","totalCost":14.2}]}', stderr: '' });
  const bad = () => ({ status: 1, stdout: '', stderr: 'offline' });
  const t0 = Date.parse('2026-11-05T15:00:00Z');
  spendFooter(WEEKDAYS, file, good, 'UTC', t0);
  const same = spendFooter(WEEKDAYS, file, bad, 'UTC', t0 + 20 * 60_000);
  assert.match(same, /\$14\.20 today/);
  assert.match(same, /STALE, last good 15:00 UTC \(ccusage exit 1: offline\)/);
  const nextDay = spendFooter(WEEKDAYS, file, bad, 'UTC', t0 + 18 * 3600_000);
  assert.match(nextDay, /^Spend: unavailable \(ccusage exit 1: offline\)/);
  assert.doesNotMatch(nextDay, /\$0\.00/);
  const s1 = spendWatch.check('x', { now: t0 + 18 * 3600_000, prev: null, run: bad }, WEEKDAYS, 'UTC', file);
  assert.match(spendWatch.diff(null, s1)[0].summary, /cannot read spend/);
  const s2 = spendWatch.check('x', { now: t0 + 18 * 3600_000 + 6 * 60_000, prev: s1, run: bad }, WEEKDAYS, 'UTC', file);
  assert.deepEqual(spendWatch.diff(s1, s2), []);
});

test('weekend weight: a weekend day gets that share of a weekday allowance, and the weekday allowance shrinks to pay for it', () => {
  const cfg = { ...WEEKDAYS, weekendWeight: 1 / 3 };
  // Period Nov 5 to Dec 4 2026: 22 weekdays and 8 weekend days, so 22 + 8/3 weighted days.
  const mon = evaluate(cfg, '2026-11-09', { '2026-11-09': 5 });
  assert.ok(Math.abs(mon.budgetDays - (22 + 8 / 3)) < 1e-9);
  assert.equal(mon.dailyAllowance.toFixed(2), '20.27');
  assert.equal(mon.todayAllowance, mon.dailyAllowance);
  const sat = evaluate(cfg, '2026-11-07', { '2026-11-07': 6 });
  assert.equal(sat.todayIsBudgetDay, true);
  assert.equal(sat.todayAllowance.toFixed(2), '6.76');
  assert.deepEqual(crossed(cfg, sat).map((a) => a.key), ['warn']);
  assert.match(crossed(cfg, sat)[0]?.text ?? '', /of the \$6\.76 daily allowance/);
  assert.deepEqual(crossed(cfg, evaluate(cfg, '2026-11-07', { '2026-11-07': 7 })).map((a) => a.key), ['hard']);
  assert.match(spendText(cfg, sat), /today of \$6\.76/);
});

test('weekend weight: parsed from 0 to 1, anything else is 0; ignored in all mode', () => {
  assert.equal(parseBudget({ ...UNSET, weekendWeight: '0.333' }).weekendWeight, 0.333);
  assert.equal(parseBudget({ ...UNSET, weekendWeight: '2' }).weekendWeight, 0);
  assert.equal(parseBudget({ ...UNSET, weekendWeight: 'x' }).weekendWeight, 0);
  const all = { ...WEEKDAYS, days: 'all' as const, weekendWeight: 0.25 };
  assert.equal(evaluate(all, '2026-11-07', {}).todayAllowance, evaluate(all, '2026-11-09', {}).todayAllowance);
});
