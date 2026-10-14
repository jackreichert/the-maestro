// Run: node --test scripts/web/client/test/series.test.ts
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { configureSeries, seriesClass } from '../src/series.ts';

afterEach(() => configureSeries(undefined));

test('the tool\'s own streams have fixed colours and an unknown stream hashes to a stable palette class', () => {
  assert.equal(seriesClass('Maestro'), 's5');
  assert.equal(seriesClass('other'), 'so');
  assert.equal(seriesClass('Alpha'), seriesClass('Alpha'));
  assert.match(seriesClass('Alpha'), /^s[1-8]$/);
});

test('configured streams get their colour; a payload with an unknown class or the wrong shape adds nothing', () => {
  configureSeries({ Alpha: 's2', Beta: 'evil" onclick="x', Gamma: 7 });
  assert.equal(seriesClass('Alpha'), 's2');
  assert.notEqual(seriesClass('Beta'), 'evil" onclick="x');
  assert.match(seriesClass('Gamma'), /^s[1-8]$/);
  configureSeries('nope');
  assert.equal(seriesClass('Maestro'), 's5');
});

test('a stream named like an object property is hashed, not looked up on the prototype', () => {
  assert.match(seriesClass('constructor'), /^s[1-8]$/);
  assert.match(seriesClass('__proto__'), /^s[1-8]$/);
});
