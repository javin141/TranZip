import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearUsualTrip,
  loadNotifyPreference,
  loadUsualTrip,
  normaliseTrip,
  saveNotifyPreference,
  saveUsualTrip,
  usualDepartureToday,
} from './usualTrip.js';

function installStorage({ blocked = false } = {}) {
  const data = new Map();
  globalThis.localStorage = {
    getItem: (key) => {
      if (blocked) throw new Error('storage blocked');
      return data.has(key) ? data.get(key) : null;
    },
    setItem: (key, value) => {
      if (blocked) throw new Error('storage blocked');
      data.set(key, String(value));
    },
    removeItem: (key) => {
      if (blocked) throw new Error('storage blocked');
      data.delete(key);
    },
  };
  return data;
}

const trip = {
  origin: { name: 'Punggol MRT', latitude: 1.4053, longitude: 103.9023 },
  destination: { name: 'one-north MRT', latitude: 1.2999, longitude: 103.7873 },
  departTime: '08:00',
  flexibilityMinutes: 60,
};

beforeEach(() => installStorage());

test('a saved trip round-trips through localStorage', () => {
  assert.equal(saveUsualTrip(trip), true);
  assert.deepEqual(loadUsualTrip(), trip);
});

test('only the fields planning needs are stored (no address or other place data)', () => {
  const data = installStorage();
  saveUsualTrip(normaliseTrip({
    ...trip,
    origin: { ...trip.origin, address: '1 Some Road', postal: '123456', extra: 'x' },
  }));
  const stored = JSON.parse(data.get('tranzip:usualTrip'));
  assert.deepEqual(Object.keys(stored.origin).sort(), ['latitude', 'longitude', 'name']);
});

test('clearing removes the trip', () => {
  saveUsualTrip(trip);
  clearUsualTrip();
  assert.equal(loadUsualTrip(), null);
});

test('rejects trips with a bad time, missing place or non-numeric coordinates', () => {
  assert.equal(normaliseTrip({ ...trip, departTime: '8:00' }), null);
  assert.equal(normaliseTrip({ ...trip, departTime: '25:00' }), null);
  assert.equal(normaliseTrip({ ...trip, origin: null }), null);
  assert.equal(normaliseTrip({ ...trip, destination: { name: 'x', latitude: 'abc', longitude: 1 } }), null);
  assert.equal(normaliseTrip(null), null);
});

test('an unknown flexibility falls back to none instead of being trusted', () => {
  assert.equal(normaliseTrip({ ...trip, flexibilityMinutes: 999 }).flexibilityMinutes, 0);
  assert.equal(normaliseTrip({ ...trip, flexibilityMinutes: 30 }).flexibilityMinutes, 30);
});

test('corrupt stored data is ignored rather than crashing the app', () => {
  const data = installStorage();
  data.set('tranzip:usualTrip', '{not json');
  assert.equal(loadUsualTrip(), null);
  data.set('tranzip:usualTrip', JSON.stringify({ origin: 1 }));
  assert.equal(loadUsualTrip(), null);
});

test('blocked storage never throws: saving reports false, loading gives null', () => {
  installStorage({ blocked: true });
  assert.equal(saveUsualTrip(trip), false);
  assert.equal(loadUsualTrip(), null);
  assert.doesNotThrow(() => clearUsualTrip());
  assert.equal(loadNotifyPreference(), false);
  assert.doesNotThrow(() => saveNotifyPreference(true));
});

test('the notification preference is stored separately and defaults to off', () => {
  assert.equal(loadNotifyPreference(), false);
  saveNotifyPreference(true);
  assert.equal(loadNotifyPreference(), true);
  saveNotifyPreference(false);
  assert.equal(loadNotifyPreference(), false);
});

test('usualDepartureToday is today at the saved HH:MM in local time', () => {
  const now = new Date(2026, 8, 19, 22, 47, 13, 500);
  const at = usualDepartureToday('08:05', now);
  assert.equal(at.getFullYear(), 2026);
  assert.equal(at.getMonth(), 8);
  assert.equal(at.getDate(), 19);
  assert.equal(at.getHours(), 8);
  assert.equal(at.getMinutes(), 5);
  assert.equal(at.getSeconds(), 0);
});
