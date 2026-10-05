// Run: node --test scripts/lib/status-page/links.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { obsidianUri, statusPageFooter, statusPageUri, ticketNotePath } from './links.ts';

test('statusPageUri derives an Obsidian URI from a status dir inside the vault, and an explicit URI wins', () => {
  const base = { explicit: '', statusDir: '/v/My Vault/Projects/p/Status', vaultRoot: '/v/My Vault', vaultName: 'My Vault' };
  assert.equal(statusPageUri(base), 'obsidian://open?vault=My%20Vault&file=Projects%2Fp%2FStatus%2FThe-Podium');
  assert.equal(statusPageUri({ ...base, explicit: 'https://example.test/now' }), 'https://example.test/now');
});

test('statusPageUri is empty unless it can be built: no dir, dir outside the vault, no vault name', () => {
  const base = { explicit: '', statusDir: '/v/Vault/S', vaultRoot: '/v/Vault', vaultName: 'Vault' };
  assert.equal(statusPageUri({ ...base, statusDir: '' }), '');
  assert.equal(statusPageUri({ ...base, statusDir: '/elsewhere/S' }), '');
  assert.equal(statusPageUri({ ...base, vaultName: '' }), '');
  assert.equal(statusPageUri({ ...base, statusDir: '/v/Vault' }), '', 'the vault root itself is not a status dir');
});

test('the footer line is the bare URI after a bold label, or nothing', () => {
  assert.deepEqual(statusPageFooter(obsidianUri('V', 'a/The-Podium')), ['**Podium:** obsidian://open?vault=V&file=a%2FThe-Podium']);
  assert.deepEqual(statusPageFooter(''), []);
});

test('ticketNotePath fills {id} and {prefix}', () => {
  assert.equal(ticketNotePath('Projects/{prefix}/Tickets/{id}', 'proj-12'), 'Projects/proj/Tickets/proj-12');
  assert.equal(ticketNotePath('T/{id}', 'X-1'), 'T/X-1');
});

test('the derived link and the footer label follow the Podium file name, with no install named in the code', () => {
  const uri = statusPageUri({ explicit: '', statusDir: '/v/Projects/p/Status', vaultRoot: '/v', vaultName: 'Other' });
  assert.equal(uri, 'obsidian://open?vault=Other&file=Projects%2Fp%2FStatus%2FThe-Podium');
  assert.deepEqual(statusPageFooter(uri), [`**Podium:** ${uri}`]);
});
