// Run: node --test scripts/lib/session-text.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionText } from './session-text.ts';

test('the Session line carries the session id when known, so a flip between two open sessions is visible', () => {
    const s = { available: true, turns: 29, ctxK: 32, triggerK: 200, pct: 16, readK: 109, advice: '' } as const;
    assert.equal(sessionText({ ...s, session: '31a43ae4' }), '**Session:** 31a43ae4 · 29 turns · ctx 32k of ~200k (16%) · 109k read/turn');
    assert.equal(sessionText(s), '**Session:** 29 turns · ctx 32k of ~200k (16%) · 109k read/turn');
});
