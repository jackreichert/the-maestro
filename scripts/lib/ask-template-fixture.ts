/** The required template fields of an ask, for tests that raise an ask through `journal.ts ask` and are not about the template itself. */
export const ASK_TEMPLATE = [
  '--blocked', 'the fixture waits on this answer',
  '--option', 'Option A -- the cheaper path, with more risk', '--option', 'Option B -- the safer path, with more work',
  '--link', 'https://example.test/pull/1', '--recommend', 'Option A, because it is cheaper.',
];
