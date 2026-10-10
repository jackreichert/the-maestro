// Run: node --test scripts/lib/window-id.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanWindowId, resolveWindow, resolveWindowId, windowEnv, windowNotice } from './window-id.ts';

test('the explicit window beats the session, the environment and the pid', () => {
    assert.equal(resolveWindowId({ window: 'w-one', session: 'abcd1234-ffff', env: 'envid', ppid: 7 }), 'w-one');
});

test('a session id gives its first characters, so a uuid is short on a row', () => {
    assert.equal(resolveWindowId({ session: '3f2a9c10-5b7e-4a11-9d00-aaaaaaaaaaaa', ppid: 7 }), '3f2a9c10-5b7');
});

test('the environment variable is used when there is no flag or session', () => {
    assert.equal(resolveWindowId({ env: 'hookid', ppid: 7 }), 'hookid');
});

test('the pid fallback names the parent process, so two windows differ', () => {
    assert.equal(resolveWindowId({ ppid: 4242 }), 'p4242');
    assert.notEqual(resolveWindowId({ ppid: 1 }), resolveWindowId({ ppid: 2 }));
});

test('free text is stripped and an id that is empty after stripping falls through', () => {
    assert.equal(cleanWindowId('a b/c\n"d"'), 'abcd');
    assert.equal(resolveWindowId({ window: '!!! ', session: '', env: '../..', ppid: 9 }), 'p9');
});

test('Claude Code\'s own variables come after MAESTRO_WINDOW and before the pid: session id, then the Claude process, then the shell', () => {
    const all = { env: 'hookid', claudeSession: '3f2a9c10-5b7e-4a11', claudePid: '777', ppid: 7 };
    assert.deepEqual(resolveWindow(all), { id: 'hookid', source: 'env', stable: true });
    assert.deepEqual(resolveWindow({ ...all, env: '' }), { id: '3f2a9c10-5b7', source: 'claude-session', stable: true });
    assert.deepEqual(resolveWindow({ ...all, env: '', claudeSession: '' }), { id: 'c777', source: 'claude-pid', stable: true });
    assert.deepEqual(resolveWindow({ ...all, env: '', claudeSession: '', claudePid: 'not-a-pid' }), { id: 'p7', source: 'ppid', stable: false });
});

test('windowEnv reads the three variables and nothing else', () => {
    assert.deepEqual(windowEnv({ MAESTRO_WINDOW: 'a', CLAUDE_CODE_SESSION_ID: 'b', CLAUDE_PID: '3', HOME: '/h' }), { env: 'a', claudeSession: 'b', claudePid: '3' });
});

test('only the per-shell pid fallback is called unstable, and it says what to do', () => {
    assert.equal(windowNotice(resolveWindow({ claudePid: '5' })), '');
    assert.match(windowNotice(resolveWindow({ ppid: 9 })), /^Window id p9 is UNSTABLE: .*MAESTRO_WINDOW/);
});
