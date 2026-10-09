// Run: node --test scripts/lib/window-id.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanWindowId, resolveWindowId } from './window-id.ts';

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
