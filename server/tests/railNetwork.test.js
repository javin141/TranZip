import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findRailPath } from '../lib/railNetwork.js';

test('findRailPath finds a real multi-line path with interchanges', async () => {
  const path = await findRailPath('NS1', 'NS17'); // Jurong East -> Bishan
  assert.ok(path, 'expected a path to be found');
  assert.equal(path.stations[0].code, 'NS1');
  assert.equal(path.stations.at(-1).code, 'NS17');
  assert.ok(path.transfers >= 1, 'this trip is not a single-line ride');
});

test('findRailPath is a same-station, zero-minute trip when start === goal', async () => {
  const path = await findRailPath('NS17', 'NS17');
  assert.deepEqual(path, { stations: [{ code: 'NS17', line: 'NSL' }], minutes: 0, transfers: 0 });
});

test('findRailPath returns null between two codes that are not real stations', async () => {
  assert.equal(await findRailPath('ZZ99', 'NS17'), null);
});

test('findRailPath reroutes around a blocked station instead of ignoring it', async () => {
  const baseline = await findRailPath('NS1', 'NS17');
  const blockedStation = baseline.stations[Math.floor(baseline.stations.length / 2)].code;

  const detour = await findRailPath('NS1', 'NS17', { avoidStations: new Set([blockedStation]) });
  assert.ok(detour, 'expected an alternative path to still exist');
  assert.ok(
    !detour.stations.some((station) => station.code === blockedStation),
    'the detour must not pass through the blocked station',
  );
});

test('findRailPath refuses a trip that starts or ends at a blocked station', async () => {
  assert.equal(await findRailPath('NS1', 'NS17', { avoidStations: new Set(['NS17']) }), null);
  assert.equal(await findRailPath('NS1', 'NS17', { avoidStations: new Set(['NS1']) }), null);
});
