// A child process for claim-same-window.test.ts: claims events as one window, holding at the point between read and mark until its rival is also there.
import { existsSync, writeFileSync } from 'node:fs';
import { claimFor } from './event-loop.ts';

const [dir, window, me, rival] = process.argv.slice(2);
const barrier = (): void => {
  writeFileSync(me, '');
  const end = Date.now() + 5000;
  while (!existsSync(rival) && Date.now() < end) { /* spin: both children must have read the inbox before either marks it */ }
};
console.log(claimFor(dir, window, barrier).length);
