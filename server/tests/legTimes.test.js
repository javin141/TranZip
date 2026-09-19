import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferLegTimes } from '../lib/legTimes.js';

const T0 = Date.parse('2026-09-19T08:00:00.000Z');
const at = (minutes) => new Date(T0 + minutes * 60000).toISOString();
const ms = (value) => Date.parse(value);

const walk = (id, minutes) => ({ id, type: 'walk', durationMinutes: minutes, departure: null, arrival: null });
const ride = (id, depMin, arrMin) => ({ id, type: 'mrt', durationMinutes: arrMin - depMin, departure: at(depMin), arrival: at(arrMin) });

test('a walk after a ride starts when the ride arrives; walks in a row chain end to end', () => {
  const route = { legs: [ride('r1', 0, 20), walk('w1', 2), walk('w2', 1), walk('w3', 3)] };
  inferLegTimes(route);
  const [, w1, w2, w3] = route.legs;
  assert.equal(ms(w1.departure), ms(at(20)));
  assert.equal(ms(w1.arrival), ms(at(22)));
  assert.equal(ms(w2.departure), ms(at(22)));
  assert.equal(ms(w2.arrival), ms(at(23)));
  assert.equal(ms(w3.departure), ms(at(23)));
  assert.equal(ms(w3.arrival), ms(at(26)));
  assert.ok([w1, w2, w3].every((leg) => leg.timesInferred === true));
});

test('a walk before a ride is worked backwards from the ride\'s departure', () => {
  const route = { legs: [walk('w1', 2), walk('w2', 3), ride('r1', 30, 50)] };
  inferLegTimes(route);
  const [w1, w2] = route.legs;
  assert.equal(ms(w2.arrival), ms(at(30)));
  assert.equal(ms(w2.departure), ms(at(27)));
  assert.equal(ms(w1.arrival), ms(at(27)));
  assert.equal(ms(w1.departure), ms(at(25)));
});

test('a walk between two rides starts at the first ride\'s arrival, leaving the gap as waiting', () => {
  const route = { legs: [ride('r1', 0, 20), walk('w1', 4), ride('r2', 30, 45)] };
  inferLegTimes(route);
  const w = route.legs[1];
  assert.equal(ms(w.departure), ms(at(20)));
  assert.equal(ms(w.arrival), ms(at(24))); // then 6 minutes on the platform before the 30' departure
});

test('a walk is never made to end after the next leg has already left', () => {
  const route = { legs: [ride('r1', 0, 20), walk('w1', 10), ride('r2', 25, 40)] };
  inferLegTimes(route);
  assert.ok(ms(route.legs[1].arrival) <= ms(at(25)));
  assert.ok(ms(route.legs[1].departure) <= ms(route.legs[1].arrival));
});

test('times the routing source supplied are never changed and are not flagged as inferred', () => {
  const route = { legs: [ride('r1', 0, 20), walk('w1', 2)] };
  const before = { departure: route.legs[0].departure, arrival: route.legs[0].arrival };
  inferLegTimes(route);
  assert.equal(route.legs[0].departure, before.departure);
  assert.equal(route.legs[0].arrival, before.arrival);
  assert.equal(route.legs[0].timesInferred, undefined);
});

test('epoch-millisecond times (OneMap) count as known, and a leg with only one time gets the other', () => {
  const route = {
    legs: [
      { id: 'a', type: 'mrt', durationMinutes: 10, departure: T0, arrival: T0 + 10 * 60000 },
      { id: 'b', type: 'walk', durationMinutes: 5, departure: T0 + 10 * 60000, arrival: null },
    ],
  };
  inferLegTimes(route);
  assert.equal(route.legs[0].timesInferred, undefined);
  assert.equal(ms(route.legs[1].arrival), T0 + 15 * 60000);
  assert.equal(route.legs[1].timesInferred, true);
});

test('a walk-only route starts at the requested departure time', () => {
  const route = { legs: [walk('w1', 6), walk('w2', 4)] };
  inferLegTimes(route, { fallbackStartMs: T0 });
  assert.equal(ms(route.legs[0].departure), T0);
  assert.equal(ms(route.legs[1].arrival), T0 + 10 * 60000);
});

test('with nothing to anchor to, the legs are left without times rather than invented', () => {
  const route = { legs: [walk('w1', 6)] };
  inferLegTimes(route);
  assert.equal(route.legs[0].departure, null);
  assert.equal(route.legs[0].timesInferred, undefined);
});

test('the route-level start and end widen to include a leading and trailing walk', () => {
  const route = { startTime: at(25), endTime: at(50), legs: [walk('w1', 5), ride('r1', 25, 50), walk('w2', 3)] };
  inferLegTimes(route);
  assert.equal(ms(route.startTime), ms(at(20)));
  assert.equal(ms(route.endTime), ms(at(53)));
});

test('a route with no legs is returned unchanged', () => {
  assert.deepEqual(inferLegTimes({ legs: [] }), { legs: [] });
});
