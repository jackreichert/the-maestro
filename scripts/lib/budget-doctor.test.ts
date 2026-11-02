import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgetChecks, checkAutocompact, checkHooksInstalled, checkModeProfile, checkNoScheduledLaunches, checkNotifications, checkPlugins, checkSpendCache, launchesClaude } from './budget-doctor.ts';
import type { BudgetFacts } from './budget-doctor.ts';

const NOW = Date.parse('2026-11-06T12:00:00Z');
const good = (): BudgetFacts => ({
  today: '2026-11-06', now: NOW, mode: 'slim', costProfile: 'lean',
  settings: { env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '30', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000', OTHER_TOKEN: 'sk-not-real' }, enabledPlugins: { a: true, b: false, c: true } },
  wakeLaunchCommand: [], notifyCommand: [], crontab: '# nothing\n0 * * * * node /x/loop.ts\n', plists: [],
  expectedHooks: ['git-guard.ts'], registeredHooks: [{ event: 'PreToolUse', matcher: 'Bash', command: "node '/r/scripts/hooks/git-guard.ts'" }], settingsFile: '/s.json',
  spendCache: { at: NOW - 60_000 },
});
const status = (f: BudgetFacts, fn: (f: BudgetFacts) => { status: string }) => fn(f).status;

test('mode: slim passes; full warns on and after the budget start but passes before it', () => {
  assert.equal(status(good(), checkModeProfile), 'ok');
  assert.equal(status({ ...good(), mode: 'full' }, checkModeProfile), 'warn');
  assert.equal(status({ ...good(), mode: 'full', today: '2026-11-05' }, checkModeProfile), 'warn');
  assert.equal(status({ ...good(), mode: 'full', today: '2026-11-04' }, checkModeProfile), 'ok');
  assert.match(checkModeProfile(good()).detail, /cost_profile lean/);
});

test('autocompact: 500000 at 30 percent passes (150000); at 31 percent fails; a missing or bad value fails', () => {
  assert.equal(status(good(), checkAutocompact), 'ok');
  const g = good();
  g.settings!.env!.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = '31';
  assert.equal(status(g, checkAutocompact), 'fail');
  g.settings!.env = { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '30' };
  assert.equal(status(g, checkAutocompact), 'fail');
  g.settings!.env = { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: 'abc', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1' };
  assert.equal(status(g, checkAutocompact), 'fail');
  assert.equal(status({ ...good(), settings: null }, checkAutocompact), 'fail');
});

test('scheduled launches: wake command, a claude crontab line and a claude plist fail; the node supervisor under ~/.claude passes', () => {
  assert.equal(status(good(), checkNoScheduledLaunches), 'ok');
  assert.equal(status({ ...good(), wakeLaunchCommand: ['node', 'w.ts'] }, checkNoScheduledLaunches), 'fail');
  assert.equal(status({ ...good(), crontab: '0 9 * * * /usr/local/bin/claude -p "go"\n' }, checkNoScheduledLaunches), 'fail');
  assert.equal(status({ ...good(), crontab: '# 0 9 * * * claude -p go\n' }, checkNoScheduledLaunches), 'ok');
  const plist = (args: string[]) => `<dict><key>ProgramArguments</key><array>${args.map((a) => `<string>${a}</string>`).join('')}</array></dict>`;
  const node = { file: '/L/com.maestro.loop.plist', text: plist(['/usr/bin/node', '/Users/x/.claude/skills/the-maestro/scripts/loop.ts']) };
  assert.equal(status({ ...good(), plists: [node] }, checkNoScheduledLaunches), 'ok');
  const llm = { file: '/L/com.x.plist', text: plist(['/opt/homebrew/bin/claude', '-p', 'hi']) };
  assert.equal(status({ ...good(), plists: [node, llm] }, checkNoScheduledLaunches), 'fail');
  assert.equal(launchesClaude('sh -c "cd x && claude -p y"'), true);
  assert.equal(launchesClaude('node /Users/x/.claude/skills/y.ts'), false);
});

test('notifications: empty passes, set warns', () => {
  assert.equal(status(good(), checkNotifications), 'ok');
  assert.equal(status({ ...good(), notifyCommand: ['imsg'] }, checkNotifications), 'warn');
});

test('hooks installed: present passes, missing fails and names the hook, unreadable settings fails', () => {
  assert.equal(status(good(), checkHooksInstalled), 'ok');
  const missing = { ...good(), expectedHooks: ['git-guard.ts', 'agent-dispatch.ts'] };
  assert.equal(status(missing, checkHooksInstalled), 'fail');
  assert.match(checkHooksInstalled(missing).detail, /agent-dispatch\.ts/);
  assert.equal(status({ ...good(), settings: null }, checkHooksInstalled), 'fail');
});

test('spend cache: fresh passes; stale, absent, untimestamped and errored warn', () => {
  assert.equal(status(good(), checkSpendCache), 'ok');
  assert.equal(status({ ...good(), spendCache: { at: NOW - 4 * 3_600_000 } }, checkSpendCache), 'warn');
  assert.equal(status({ ...good(), spendCache: null }, checkSpendCache), 'warn');
  assert.equal(status({ ...good(), spendCache: {} }, checkSpendCache), 'warn');
  assert.equal(status({ ...good(), spendCache: { at: NOW, error: 'x' } }, checkSpendCache), 'warn');
});

test('plugins: counts only enabled ones', () => {
  assert.match(checkPlugins(good()).detail, /^2 enabled/);
});

test('no result echoes an env value other than the two autocompact ones', () => {
  const all = budgetChecks(good());
  assert.equal(all.length, 7);
  assert.ok(all.every((c) => c.name.startsWith('budget: ')));
  assert.doesNotMatch(JSON.stringify(all), /sk-not-real|OTHER_TOKEN/);
});
