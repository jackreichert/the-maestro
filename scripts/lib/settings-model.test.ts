// Run: node --test scripts/lib/settings-model.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBudget } from './budget.ts';
import { buildSettingsData, groupOf, shown, sourceLabel } from './settings-model.ts';
import type { SettingsInputs } from './settings-model.ts';

const budget = (o: Partial<Record<string, string>> = {}) => parseBudget({ monthly: '500', startDay: '5', days: 'weekdays', warn: '', hard: '', weekendWeight: '0.333', ...o });
const base = (o: Partial<SettingsInputs> = {}): SettingsInputs => ({
  settings: [], budget: budget(), cache: null, today: '2026-11-09', now: new Date('2026-11-09T15:00:00Z'), userFile: '/h/config.md', overlayFile: '/o/config.md', ...o,
});
const row = (key: string, value: string, source = 'default') => ({ key, envName: '', value, source });

test('groups: cost, watches, gates, paths, and the rest', () => {
  assert.equal(groupOf('mode'), 'Mode & cost');
  assert.equal(groupOf('budget_weekend_weight'), 'Mode & cost');
  assert.equal(groupOf('watch_quiet_hours'), 'Watches & notifications');
  assert.equal(groupOf('notify_command'), 'Watches & notifications');
  assert.equal(groupOf('pr_max_code_lines'), 'PR gates');
  assert.equal(groupOf('vault_root'), 'Paths');
  assert.equal(groupOf('gh_org'), 'Other');
});

test('secret-named keys and commands are masked; an empty one stays empty', () => {
  assert.deepEqual(shown('api_token', 'abc123'), { value: '(hidden)', masked: true });
  assert.deepEqual(shown('Some_Password', 'x'), { value: '(hidden)', masked: true });
  assert.deepEqual(shown('notify_command', 'curl https://u:p@h'), { value: '(set)', masked: true });
  assert.deepEqual(shown('notify_command', ''), { value: '', masked: true });
  assert.deepEqual(shown('mode', 'slim'), { value: 'slim', masked: false });
});

test('the page data never carries a masked value', () => {
  const d = buildSettingsData(base({ settings: [row('slack_token', 'xoxb-123'), row('inbox_command', 'secret-cli --pw hunter2')] }));
  assert.ok(!JSON.stringify(d).includes('xoxb-123'));
  assert.ok(!JSON.stringify(d).includes('hunter2'));
});

test('source labels name env, file and default', () => {
  assert.equal(sourceLabel('env MAESTRO_MODE', '/h/config.md', ''), 'env MAESTRO_MODE');
  assert.equal(sourceLabel('/h/config.md', '/h/config.md', '/o/config.md'), 'config.md (config.md)');
  assert.equal(sourceLabel('/o/config.md', '/h/config.md', '/o/config.md'), 'overlay (config.md)');
  assert.equal(sourceLabel('default', '/h/config.md', ''), 'default');
});

test('no cached spend: spend figures are null, never zero or estimated', () => {
  const d = buildSettingsData(base({ settings: [row('budget_monthly_usd', '500')] }));
  assert.equal(d.spend.todaySpend, null);
  assert.equal(d.spend.periodSpend, null);
  assert.equal(d.spend.projection, null);
  assert.ok((d.spend.perWeekday ?? 0) > 0);   // the allowance needs no spend
});

test('cached spend: today against allowance, and the month projection from the pace', () => {
  const cache = { at: Date.parse('2026-11-09T14:00:00Z'), since: '2026-11-05', daily: { '2026-11-05': 10, '2026-11-06': 10, '2026-11-09': 10 } };
  const d = buildSettingsData(base({ cache }));
  assert.equal(d.spend.todaySpend, 10);
  assert.equal(d.spend.periodSpend, 30);
  // Period 2026-11-05..2026-12-04: weekdays 22 + weekend days 8 x 0.333; elapsed through Mon 9th is 3 weekdays + 2 weekend days at 0.333.
  const days = 22 + 8 * 0.333;
  const elapsed = 3 + 2 * 0.333;
  assert.ok(Math.abs((d.spend.projection ?? 0) - (30 / elapsed) * days) < 1e-6);
  assert.ok(Math.abs(d.spend.todayAllowance - 500 / days) < 1e-6);
  assert.equal(d.spend.readAt, '2026-11-09T14:00:00.000Z');
});

test('budget off: no allowance claims, and only the budget key carries $/weekday', () => {
  const off = buildSettingsData(base({ budget: budget({ monthly: '' }), settings: [row('budget_monthly_usd', ''), row('mode', 'slim')] }));
  assert.equal(off.spend.on, false);
  assert.equal(off.spend.perWeekday, null);
  const on = buildSettingsData(base({ settings: [row('budget_monthly_usd', '500'), row('mode', 'slim')] }));
  const rows = on.groups.flatMap((g) => g.rows);
  assert.ok((rows.find((r) => r.key === 'budget_monthly_usd')?.perWeekday ?? 0) > 0);
  assert.equal(rows.find((r) => r.key === 'mode')?.perWeekday, null);
});
