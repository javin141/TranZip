import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStationCode, lineForStationCode, lineMeta } from '../lib/railLines.js';

test('lineForStationCode maps a station code prefix to its line', () => {
  assert.equal(lineForStationCode('NS17'), 'NSL');
  assert.equal(lineForStationCode('ew24'), 'EWL'); // case-insensitive
  assert.equal(lineForStationCode('CG1'), 'CGL');
  assert.equal(lineForStationCode('SE1'), 'SLRT');
  assert.equal(lineForStationCode('SW8'), 'SLRT'); // Sengkang west loop shares the line
  assert.equal(lineForStationCode('PW3'), 'PLRT');
});

test('lineForStationCode returns null for anything that is not a station code', () => {
  assert.equal(lineForStationCode('83139'), null); // bus stop code
  assert.equal(lineForStationCode(''), null);
  assert.equal(lineForStationCode(undefined), null);
  assert.equal(lineForStationCode('ABCDE'), null); // no trailing digits
});

test('isStationCode is true only for recognised station code prefixes', () => {
  assert.equal(isStationCode('NS1'), true);
  assert.equal(isStationCode('83139'), false);
  assert.equal(isStationCode('ZZ1'), false); // well-formed but unknown prefix
});

test('lineMeta returns the official colour/name for every line code', () => {
  assert.equal(lineMeta('NSL').colour, '#d42e12');
  assert.equal(lineMeta('nel').name, 'North East Line'); // case-insensitive
  assert.equal(lineMeta('NOPE'), null);
});
