import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkBehind, checkDuplicateInstalls, checkHookLocation, checkRegistered, checkSkillLocation, expectedHookFiles, hookCommands, maestroHookScript, render,
} from './doctor.ts';

const entry = (command: string, matcher = '') => ({ matcher, hooks: [{ type: 'command', command }] });
const settings = (...commands: string[]) => ({ env: { SOME_TOKEN: 'sk-not-a-real-secret' }, hooks: { PreToolUse: commands.map((c) => entry(c, 'Bash')) } });
const same = (p: string): string => p;

test('hookCommands reads only the hooks key and tolerates junk', () => {
  assert.deepEqual(hookCommands(settings('node /a/scripts/hooks/git-guard.ts')), [{ event: 'PreToolUse', matcher: 'Bash', command: 'node /a/scripts/hooks/git-guard.ts' }]);
  for (const junk of [null, 5, {}, { hooks: 3 }, { hooks: { Stop: 'x' } }, { hooks: { Stop: [{ hooks: [{ command: 9 }] }] } }]) assert.deepEqual(hookCommands(junk), []);
});

test('maestroHookScript finds a quoted or bare hook path and ignores other commands', () => {
  assert.deepEqual(maestroHookScript(`node '/xy/scripts/hooks/agent-return.ts' --project p`)?.file, 'agent-return.ts');
  assert.equal(maestroHookScript('node /x/scripts/hooks/git-guard.ts')?.path, '/x/scripts/hooks/git-guard.ts');
  assert.equal(maestroHookScript('node ~/.claude/hooks/secret-file-guard.mjs'), undefined);
});

test('maestroHookScript never captures other text from a quoted command, so an inline secret cannot reach the output', () => {
  const r = maestroHookScript(`'TOKEN=sk-not-a-real-secret /x/scripts/hooks/a.ts'`);
  assert.ok(!r || !r.path.includes('sk-not-a-real-secret'));
  const detail = checkHookLocation(hookCommands(settings(`node 'TOKEN=sk-not-a-real-secret /x/scripts/hooks/a.ts'`)), '/rt', same).detail;
  assert.doesNotMatch(detail, /sk-not-a-real-secret/);
});

test('expectedHookFiles is derived from the snippet shape, deduplicated and sorted', () => {
  assert.deepEqual(expectedHookFiles(settings('node /a/scripts/hooks/b.ts', 'node /a/scripts/hooks/a.ts', 'node /a/scripts/hooks/a.ts --x')), ['a.ts', 'b.ts']);
});

test('checkRegistered warns, naming each missing hook, and never prints settings content', () => {
  const have = hookCommands(settings('node /a/scripts/hooks/git-guard.ts'));
  const r = checkRegistered(['agent-dispatch.ts', 'git-guard.ts'], have, ['s.json']);
  assert.equal(r.status, 'warn');
  assert.match(r.detail, /agent-dispatch\.ts/);
  assert.doesNotMatch(r.detail, /git-guard\.ts[,.]? Print|sk-not/);
  assert.equal(checkRegistered(['git-guard.ts'], have, ['s.json']).status, 'ok');
  assert.equal(checkRegistered(['git-guard.ts'], [], []).status, 'skip');
});

test('checkHookLocation flags a hook outside the runtime worktree and skips when it is unknown', () => {
  const inside = hookCommands(settings('node /rt/scripts/hooks/git-guard.ts'));
  const outside = hookCommands(settings('node /rt/scripts/hooks/git-guard.ts', 'node /dev/scripts/hooks/agent-return.ts'));
  assert.equal(checkHookLocation(inside, '/rt', same).status, 'ok');
  const r = checkHookLocation(outside, '/rt', same);
  assert.equal(r.status, 'warn');
  assert.match(r.detail, /1 of 2.*\/dev\/scripts\/hooks\/agent-return\.ts/);
  assert.equal(checkHookLocation(outside, undefined, same).status, 'skip');
  assert.equal(checkHookLocation([], '/rt', same).status, 'skip');
  // A sibling folder that shares a prefix is not inside.
  assert.equal(checkHookLocation(hookCommands(settings('node /rt2/scripts/hooks/git-guard.ts')), '/rt', same).status, 'warn');
});

test('checkSkillLocation compares the resolved skill path with the runtime worktree', () => {
  assert.equal(checkSkillLocation('/rt', '/rt', same).status, 'ok');
  assert.equal(checkSkillLocation('/dev/the-maestro', '/rt', same).status, 'warn');
  assert.equal(checkSkillLocation(undefined, '/rt', same).status, 'skip');
});

test('checkBehind separates behind, current, unreadable and not configured', () => {
  assert.equal(checkBehind('n', '/w', { behind: 3 }).status, 'warn');
  assert.match(checkBehind('n', '/w', { behind: 1 }).detail, /1 commit behind/);
  assert.equal(checkBehind('n', '/w', null).status, 'ok');
  assert.equal(checkBehind('n', '/w', undefined).status, 'skip');
  assert.equal(checkBehind('n', undefined, null).status, 'skip');
});

test('checkDuplicateInstalls flags a plugin that is also loose files and a nested clone', () => {
  const dup = checkDuplicateInstalls({ plugins: ['mithril', 'xenophon'], loose: ['mithril-review', 'mithril.md', 'other'], nestedClones: ['mithril/ inside /r'] });
  assert.equal(dup.status, 'warn');
  assert.match(dup.detail, /mithril \(plugin, plus 2 loose/);
  assert.match(dup.detail, /nested clone/);
  assert.equal(checkDuplicateInstalls({ plugins: ['mithril'], loose: ['mithrilish'], nestedClones: [] }).status, 'ok');
});

test('render ends with a verdict that says nothing was changed when there are problems', () => {
  const out = render([{ name: 'a', status: 'warn', detail: 'x' }, { name: 'b', status: 'ok', detail: 'y' }]);
  assert.match(out, /^WARN {2}a: x\nok {4}b: y\ndoctor: 1 problem found\. Nothing was changed\.$/);
  assert.match(render([{ name: 'b', status: 'ok', detail: 'y' }]), /no problems found/);
});
