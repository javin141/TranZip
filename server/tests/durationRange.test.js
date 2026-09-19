import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDurationRange, liveBusWaits } from '../lib/durationRange.js';

const T0 = Date.parse('2026-09-19T08:00:00.000Z');
const at = (minutes) => new Date(T0 + minutes * 60000).toISOString();

function walkLeg({ from = 0, minutes = 10 } = {}) {
  return { type: 'walk', durationMinutes: minutes, waitMinutes: 0, departure: at(from), arrival: at(from + minutes), load: null };
}

function busLeg({ from, minutes, wait = 0, arrivals = null }) {
  return {
    type: 'bus',
    durationMinutes: minutes,
    waitMinutes: wait,
    departure: at(from),
    arrival: at(from + wait + minutes),
    load: arrivals ? { upcoming: arrivals.map((m) => ({ estimatedArrival: at(m) })) } : null,
  };
}

function railLeg({ from, minutes, wait = 0, crowd = null }) {
  return {
    type: 'mrt',
    durationMinutes: minutes,
    waitMinutes: wait,
    departure: at(from),
    arrival: at(from + wait + minutes),
    load: { stations: [{ crowdLevel: crowd }] },
  };
}

const routeOf = (legs, durationMinutes) => ({ legs, durationMinutes });

test('walk leg is +/-10%, and the top end grows a further 15% when raining', () => {
  const dry = routeOf([walkLeg({ minutes: 20 })], 20);
  applyDurationRange(dry, {});
  assert.deepEqual(
    { min: dry.legs[0].durationRange.minMinutes, typ: dry.legs[0].durationRange.typicalMinutes, max: dry.legs[0].durationRange.maxMinutes },
    { min: 18, typ: 20, max: 22 },
  );

  const wet = routeOf([walkLeg({ minutes: 20 })], 20);
  applyDurationRange(wet, { raining: true });
  assert.equal(wet.legs[0].durationRange.minMinutes, 18);
  assert.equal(wet.legs[0].durationRange.typicalMinutes, 20);
  assert.equal(wet.legs[0].durationRange.maxMinutes, 25);
});

test('a short walk collapses to a single value instead of inventing a range', () => {
  const route = routeOf([walkLeg({ minutes: 3 })], 3);
  applyDurationRange(route, {});
  const { minMinutes, maxMinutes, typicalMinutes } = route.legs[0].durationRange;
  assert.deepEqual([minMinutes, typicalMinutes, maxMinutes], [3, 3, 3]);
});

test('rain widening is labelled [SIMULATED] only when the weather itself is simulated', () => {
  const real = routeOf([walkLeg({ minutes: 20 })], 20);
  applyDurationRange(real, { raining: true, rainSimulated: false });
  assert.equal(real.legs[0].durationRange.simulated, false);
  assert.ok(!real.legs[0].durationRange.basis.includes('[SIMULATED]'));
  assert.equal(real.durationRange.simulated, false);

  const fake = routeOf([walkLeg({ minutes: 20 })], 20);
  applyDurationRange(fake, { raining: true, rainSimulated: true });
  assert.equal(fake.legs[0].durationRange.simulated, true);
  assert.ok(fake.legs[0].durationRange.basis.startsWith('[SIMULATED]'));
  assert.equal(fake.durationRange.simulated, true);

  const fakeButDry = routeOf([walkLeg({ minutes: 20 })], 20);
  applyDurationRange(fakeButDry, { raining: false, rainSimulated: true });
  assert.equal(fakeButDry.durationRange.simulated, false);
});

test('bus wait range spans the soonest to latest of the next 3 catchable arrivals', () => {
  // Reaches the stop at +5; arrivals at +6, +11, +19 -> waits 1, 6, 14. Ride 20.
  const route = routeOf([walkLeg({ minutes: 5 }), busLeg({ from: 5, minutes: 20, arrivals: [6, 11, 19] })], 30);
  applyDurationRange(route, {});
  const bus = route.legs[1].durationRange;
  assert.equal(bus.typicalMinutes, 21); // ride 20 + soonest wait 1
  assert.equal(bus.minMinutes, 19); // ride -10% (18) + 1
  assert.equal(bus.maxMinutes, 36); // ride +10% (22) + 14
});

test('bus arrivals the passenger would already have missed are ignored', () => {
  const route = routeOf([walkLeg({ minutes: 10 }), busLeg({ from: 10, minutes: 10, arrivals: [3, 8, 12, 20] })], 25);
  // Reaches the stop at +10. +3 and +8 are gone; only the first 3 slots are
  // ever considered, so the +12 and (excluded) +20 don't both count.
  assert.deepEqual(liveBusWaits(route, 1), [2]);
});

test('leg times given as epoch milliseconds (OneMap) work the same as ISO strings', () => {
  const route = routeOf([walkLeg({ minutes: 5 }), busLeg({ from: 5, minutes: 20, arrivals: [6, 11, 19] })], 30);
  for (const leg of route.legs) {
    leg.departure = Date.parse(leg.departure);
    leg.arrival = Date.parse(leg.arrival);
  }
  applyDurationRange(route, {});
  const bus = route.legs[1].durationRange;
  assert.deepEqual([bus.minMinutes, bus.typicalMinutes, bus.maxMinutes], [19, 21, 36]);
});

test('with no live bus arrivals the planner wait is kept and not widened', () => {
  const route = routeOf([busLeg({ from: 0, minutes: 20, wait: 6, arrivals: null })], 26);
  applyDurationRange(route, {});
  const bus = route.legs[0].durationRange;
  assert.equal(bus.typicalMinutes, 26);
  assert.equal(bus.minMinutes, 24); // 18 + 6
  assert.equal(bus.maxMinutes, 28); // 22 + 6
});

test('a departure more than 15 minutes out ignores live bus arrivals (they will not have happened yet)', () => {
  const route = routeOf([busLeg({ from: 0, minutes: 20, wait: 6, arrivals: [1, 5, 9] })], 26);
  applyDurationRange(route, { useForecast: true });
  assert.equal(route.legs[0].durationRange.typicalMinutes, 26);
  assert.equal(route.legs[0].durationRange.maxMinutes, 28);
});

test('crowded (h) boarding platform adds +0 to +3 minutes; otherwise ride +/-5%', () => {
  const crowded = routeOf([railLeg({ from: 0, minutes: 20, wait: 3, crowd: 'h' })], 23);
  applyDurationRange(crowded, {});
  let r = crowded.legs[0].durationRange;
  assert.deepEqual([r.minMinutes, r.typicalMinutes, r.maxMinutes], [23, 23, 26]);

  const calm = routeOf([railLeg({ from: 0, minutes: 20, wait: 3, crowd: 'l' })], 23);
  applyDurationRange(calm, {});
  r = calm.legs[0].durationRange;
  assert.deepEqual([r.minMinutes, r.typicalMinutes, r.maxMinutes], [22, 23, 24]);

  const unknown = routeOf([railLeg({ from: 0, minutes: 20, wait: 3, crowd: null })], 23);
  applyDurationRange(unknown, {});
  r = unknown.legs[0].durationRange;
  assert.deepEqual([r.minMinutes, r.typicalMinutes, r.maxMinutes], [22, 23, 24]);
});

test('route range is the sum of leg ranges; typical equals the planner total when nothing live applies', () => {
  const route = routeOf([
    walkLeg({ from: 0, minutes: 10 }),
    railLeg({ from: 10, minutes: 20, wait: 3, crowd: 'm' }),
    walkLeg({ from: 33, minutes: 5 }),
  ], 38);
  applyDurationRange(route, {});
  const { minMinutes, typicalMinutes, maxMinutes, estimate } = route.durationRange;
  assert.equal(typicalMinutes, 38);
  assert.equal(estimate, true);
  // min: 9 + (19 + 3) + 4.5 = 35.5 -> 36 ; max: 11 + (21 + 3) + 5.5 = 40.5 -> 41 (round half up)
  assert.equal(minMinutes, 36);
  assert.equal(maxMinutes, 41);
});

test('waiting the routing source did not attribute to a leg stays in the route total', () => {
  // OneMap/Google style: legs carry no waitMinutes, and the route total is
  // longer than the legs by an unattributed wait.
  const legs = [
    { type: 'bus', durationMinutes: 20, departure: at(0), arrival: at(20), load: null },
  ];
  const route = routeOf(legs, 26);
  applyDurationRange(route, {});
  assert.equal(route.durationRange.typicalMinutes, 26);
  assert.ok(route.durationRange.minMinutes <= 26 && route.durationRange.maxMinutes >= 26);
});

test('with no live data the route typical equals the planner total, even when the source legs overshoot it', () => {
  const route = routeOf([
    walkLeg({ from: 0, minutes: 3 }),
    railLeg({ from: 3, minutes: 33, wait: 0, crowd: 'l' }),
    railLeg({ from: 36, minutes: 12, wait: 3, crowd: 'l' }),
  ], 50); // legs + waits add to 51
  applyDurationRange(route, {});
  assert.equal(route.durationRange.typicalMinutes, 50);
  assert.ok(route.durationRange.minMinutes <= 50 && route.durationRange.maxMinutes >= 50);
});

test('Google-style legs with no clock times still get ranges, and the route keeps the source total', () => {
  // Google returns walk legs (and sometimes others) with no departure/arrival at all.
  const route = routeOf([
    { type: 'walk', durationMinutes: 1, load: null },
    { type: 'mrt', durationMinutes: 41, load: { stations: [{ crowdLevel: 'l' }] } },
    { type: 'mrt', durationMinutes: 17, load: { stations: [{ crowdLevel: 'h' }] } },
  ], 71); // legs sum to 59; the other 12 minutes are transfer waiting inside Google's total
  applyDurationRange(route, {});
  assert.equal(route.durationRange.typicalMinutes, 71);
  assert.ok(route.durationRange.minMinutes < 71 && route.durationRange.maxMinutes > 71);
  const [, calm, crowded] = route.legs.map((leg) => leg.durationRange);
  assert.equal(calm.minMinutes, 39); // 41 -5%
  assert.equal(crowded.minMinutes, 17); // crowded platform: never faster than planned
  assert.equal(crowded.maxMinutes, 20); // +0..+3 for a missed train
});

test('every leg and route always satisfies min <= typical <= max and min >= 1', () => {
  const route = routeOf([
    walkLeg({ minutes: 1 }),
    busLeg({ from: 1, minutes: 1, arrivals: [1] }),
    railLeg({ from: 3, minutes: 1, crowd: 'h' }),
  ], 3);
  applyDurationRange(route, { raining: true });
  for (const range of [...route.legs.map((leg) => leg.durationRange), route.durationRange]) {
    assert.ok(range.minMinutes >= 1);
    assert.ok(range.minMinutes <= range.typicalMinutes);
    assert.ok(range.typicalMinutes <= range.maxMinutes);
  }
});
