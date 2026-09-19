import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSavedJourney,
  clearSavedJourney,
  loadSavedJourney,
  planFromSavedJourney,
  saveJourney,
  slimRoute,
} from './savedJourney.js';

function installStorage({ quotaBytes = Infinity, blocked = false } = {}) {
  const data = new Map();
  globalThis.localStorage = {
    getItem: (key) => {
      if (blocked) throw new Error('blocked');
      return data.has(key) ? data.get(key) : null;
    },
    setItem: (key, value) => {
      if (blocked) throw new Error('blocked');
      if (String(value).length > quotaBytes) throw new Error('QuotaExceededError');
      data.set(key, String(value));
    },
    removeItem: (key) => data.delete(key),
  };
  return data;
}

const line = (count) => Array.from({ length: count }, (_, i) => [1.3 + i * 0.001234567, 103.8 + i * 0.001234567]);

const route = {
  id: 'route-1',
  recommended: true,
  durationMinutes: 50,
  durationRange: { minMinutes: 47, maxMinutes: 53, typicalMinutes: 50 },
  load: { band: { key: 'seats', label: 'Seats available', tone: 'good' }, score: 0.2 },
  legs: [
    { id: 'a', type: 'walk', departure: '2026-09-19T08:12:00.000Z', arrival: '2026-09-19T08:15:00.000Z', durationMinutes: 3, geometry: line(500) },
    { id: 'b', type: 'mrt', line: 'NEL', durationMinutes: 33, geometry: line(30), load: { band: { key: 'seats' }, stations: [{ code: 'NE17' }] } },
  ],
};
const plan = { departureTime: '2026-09-19T08:12:00.000Z', tolerancePercent: 10, routingSource: 'onemap', planner: 'OneMap routing (OTP)' };
const origin = { name: 'Punggol MRT', latitude: 1.4053, longitude: 103.9023, address: 'extra', postal: '820000' };
const destination = { name: 'one-north MRT', latitude: 1.2999, longitude: 103.7873 };
const savedAtMs = Date.parse('2026-09-19T00:12:30.000Z');

beforeEach(() => installStorage());

test('a saved journey keeps legs, times, ranges and the time it was saved', () => {
  const saved = buildSavedJourney({ plan, route, origin, destination, savedAtMs });
  assert.equal(saveJourney(saved), true);
  const loaded = loadSavedJourney();
  assert.equal(loaded.savedAt, '2026-09-19T00:12:30.000Z');
  assert.equal(loaded.route.legs.length, 2);
  assert.equal(loaded.route.legs[0].departure, '2026-09-19T08:12:00.000Z');
  assert.deepEqual(loaded.route.durationRange, route.durationRange);
  assert.equal(loaded.route.legs[1].load.stations[0].code, 'NE17');
  assert.equal(loaded.departureTime, plan.departureTime);
});

test('places are stored as name and coordinates only', () => {
  const saved = buildSavedJourney({ plan, route, origin, destination, savedAtMs });
  assert.deepEqual(Object.keys(saved.origin).sort(), ['latitude', 'longitude', 'name']);
});

test('long map lines are thinned but keep their first and last points', () => {
  const slim = slimRoute(route);
  assert.equal(slim.legs[0].geometry.length, 60);
  assert.deepEqual(slim.legs[0].geometry[0], [1.3, 103.8]);
  const last = route.legs[0].geometry[499];
  assert.deepEqual(slim.legs[0].geometry[59], [Math.round(last[0] * 1e5) / 1e5, Math.round(last[1] * 1e5) / 1e5]);
  assert.equal(slim.legs[1].geometry.length, 30); // short lines are left alone
  assert.equal(route.legs[0].geometry.length, 500); // the original is untouched
});

test('when storage is nearly full it retries without map lines rather than losing the journey', () => {
  const saved = buildSavedJourney({ plan, route, origin, destination, savedAtMs });
  const full = JSON.stringify(saved).length;
  installStorage({ quotaBytes: full - 100 });
  assert.equal(saveJourney(saved), true);
  const loaded = loadSavedJourney();
  assert.equal(loaded.route.legs[0].geometry.length, 0);
  assert.equal(loaded.route.legs.length, 2);
});

test('blocked storage never throws: saving reports false, loading gives null', () => {
  installStorage({ blocked: true });
  const saved = buildSavedJourney({ plan, route, origin, destination, savedAtMs });
  assert.equal(saveJourney(saved), false);
  assert.equal(loadSavedJourney(), null);
  assert.doesNotThrow(() => clearSavedJourney());
});

test('corrupt, wrong-version or empty stored data is ignored', () => {
  const data = installStorage();
  data.set('tranzip:savedJourney', '{nope');
  assert.equal(loadSavedJourney(), null);
  data.set('tranzip:savedJourney', JSON.stringify({ version: 99, savedAt: '2026-09-19T00:00:00Z', route }));
  assert.equal(loadSavedJourney(), null);
  data.set('tranzip:savedJourney', JSON.stringify({ version: 1, savedAt: 'not a date', route }));
  assert.equal(loadSavedJourney(), null);
  data.set('tranzip:savedJourney', JSON.stringify({ version: 1, savedAt: '2026-09-19T00:00:00Z', route: { legs: [] } }));
  assert.equal(loadSavedJourney(), null);
});

test('clearing removes the saved journey', () => {
  saveJourney(buildSavedJourney({ plan, route, origin, destination, savedAtMs }));
  clearSavedJourney();
  assert.equal(loadSavedJourney(), null);
});

test('planFromSavedJourney looks like a plan response and marks when the data was live', () => {
  const saved = buildSavedJourney({ plan, route, origin, destination, savedAtMs });
  const view = planFromSavedJourney(saved);
  assert.equal(view.offlineSnapshot, true);
  assert.equal(view.routes.length, 1);
  assert.equal(view.receivedAt, savedAtMs);
  assert.equal(view.routeCount, 1);
  assert.deepEqual(view.warnings, []);
  assert.equal(view.departureTime, plan.departureTime);
});
