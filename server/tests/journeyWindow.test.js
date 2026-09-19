import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAdvice, buildCandidateTimes, describeRoute, normaliseFlexibility } from '../lib/journeyWindow.js';
import { CallBudgetExceeded, runWithCallBudget, spendUpstreamCall } from '../lib/callBudget.js';

const MIN = 60000;
const sg = (hhmm) => Date.parse(`2026-09-19T${hhmm}:00+08:00`);
const iso = (hhmm) => new Date(sg(hhmm)).toISOString();

/* ---------------------------- candidate times ---------------------------- */

test('a 60 minute window plans the usual time plus four 15-minute steps', () => {
  const { status, times } = buildCandidateTimes({ usualMs: sg('08:00'), flexibilityMinutes: 60, nowMs: sg('07:00') });
  assert.equal(status, 'ok');
  assert.deepEqual(times.map((t) => new Date(t.ms).toISOString()), ['08:00', '08:15', '08:30', '08:45', '09:00'].map(iso));
  assert.equal(times[0].isUsual, true);
  assert.equal(times[0].isNow, false);
  assert.ok(times.slice(1).every((t) => !t.isUsual));
});

test('no flexibility means only the usual time, and the count is capped at 5', () => {
  assert.equal(buildCandidateTimes({ usualMs: sg('08:00'), flexibilityMinutes: 0, nowMs: sg('07:00') }).times.length, 1);
  // The endpoint clamps to 60, but even an unclamped value can never exceed 5 plans.
  assert.equal(buildCandidateTimes({ usualMs: sg('08:00'), flexibilityMinutes: 600, nowMs: sg('07:00') }).times.length, 5);
});

test('flexibility is clamped to 0-60 minutes', () => {
  assert.equal(normaliseFlexibility(600), 60);
  assert.equal(normaliseFlexibility(-5), 0);
  assert.equal(normaliseFlexibility('abc'), 0);
  assert.equal(normaliseFlexibility(30), 30);
});

test('a usual time that has passed becomes "leave now" and only future steps are kept', () => {
  const { status, times } = buildCandidateTimes({ usualMs: sg('08:00'), flexibilityMinutes: 60, nowMs: sg('08:20') });
  assert.equal(status, 'ok');
  assert.equal(times[0].isNow, true);
  assert.equal(times[0].ms, sg('08:20'));
  assert.deepEqual(times.slice(1).map((t) => t.ms), [sg('08:30'), sg('08:45'), sg('09:00')]);
});

test('a later step within 5 minutes of "now" is dropped as a near-duplicate', () => {
  const { times } = buildCandidateTimes({ usualMs: sg('08:00'), flexibilityMinutes: 30, nowMs: sg('08:12') });
  // now = 08:12; the 08:15 step is only 3 minutes later, so it adds nothing.
  assert.deepEqual(times.map((t) => t.ms), [sg('08:12'), sg('08:30')]);
});

test('once the whole window is over there is nothing to plan', () => {
  const result = buildCandidateTimes({ usualMs: sg('08:00'), flexibilityMinutes: 30, nowMs: sg('10:00') });
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.times, []);
});

/* --------------------------------- advice -------------------------------- */

const band = {
  seats: { key: 'seats', label: 'Seats available', short: 'Seats' },
  standing: { key: 'standing', label: 'Standing available', short: 'Standing' },
  limited: { key: 'limited', label: 'Limited standing', short: 'Limited' },
  unknown: { key: 'unknown', label: 'No live data', short: 'Unknown' },
};

function candidate(hhmm, { load = 'seats', minutes = 50, isUsual = false, isNow = false, ...rest } = {}) {
  return {
    departAt: iso(hhmm),
    isUsual,
    isNow,
    usedForecast: true,
    available: true,
    routeId: `route-${hhmm}`,
    signature: `sig-${hhmm}`,
    routeLabel: 'NEL + CCL',
    durationMinutes: minutes,
    durationRange: { minMinutes: minutes - 3, maxMinutes: minutes + 4, typicalMinutes: minutes },
    arriveAt: new Date(sg(hhmm) + minutes * MIN).toISOString(),
    load: band[load],
    disrupted: false,
    rerouted: false,
    freeTransferNote: null,
    disruption: { active: false, simulated: false, affectsTrip: false, lines: [] },
    baseline: null,
    deltaVsUsualMinutes: null,
    ...rest,
  };
}

test('a normal day: usual time looks fine and is not prominent', () => {
  const advice = buildAdvice({ candidates: [candidate('08:00', { isUsual: true }), candidate('08:15')], flexibilityMinutes: 15 });
  assert.equal(advice.kind, 'fine');
  assert.equal(advice.prominent, false);
  assert.equal(advice.headline, 'Your usual 08:00 looks fine: seats likely.');
  assert.ok(advice.reason.includes('Checked 2 departure times (08:00–08:15).'));
});

test('crowded: suggests the quieter later time with the trip-time difference', () => {
  const advice = buildAdvice({
    candidates: [
      candidate('08:00', { isUsual: true, load: 'standing', minutes: 50 }),
      candidate('08:15', { load: 'standing', minutes: 50 }),
      candidate('08:30', { load: 'seats', minutes: 52 }),
    ],
    flexibilityMinutes: 30,
  });
  assert.equal(advice.kind, 'crowded');
  assert.equal(advice.prominent, true);
  assert.equal(advice.headline, 'Leave 08:30 instead: quieter (standing → seats), +2 min.');
  assert.equal(advice.departAt, iso('08:30'));
  assert.equal(advice.signature, 'sig-08:30');
  assert.ok(advice.reason.includes('arriving about 09:22 instead of 08:50'));
});

test('crowded: picks the quietest band, and the earliest time among equals', () => {
  const advice = buildAdvice({
    candidates: [
      candidate('08:00', { isUsual: true, load: 'limited' }),
      candidate('08:15', { load: 'standing' }),
      candidate('08:30', { load: 'seats' }),
      candidate('08:45', { load: 'seats' }),
    ],
    flexibilityMinutes: 45,
  });
  assert.equal(advice.departAt, iso('08:30'));
  assert.ok(advice.headline.includes('limited standing → seats'));
});

test('crowded: never suggests a later time that runs through a disruption', () => {
  const advice = buildAdvice({
    candidates: [
      candidate('08:00', { isUsual: true, load: 'standing' }),
      candidate('08:15', { load: 'seats', disrupted: true }),
    ],
    flexibilityMinutes: 15,
  });
  assert.equal(advice.kind, 'fine');
});

test('busy with nothing better is honest but not prominent', () => {
  const advice = buildAdvice({
    candidates: [candidate('08:00', { isUsual: true, load: 'limited' }), candidate('08:15', { load: 'limited' })],
    flexibilityMinutes: 15,
  });
  assert.equal(advice.kind, 'busy');
  assert.equal(advice.prominent, false);
  assert.ok(advice.headline.includes('Nothing quieter is forecast within your window'));

  const noFlex = buildAdvice({ candidates: [candidate('08:00', { isUsual: true, load: 'limited' })], flexibilityMinutes: 0 });
  assert.ok(noFlex.headline.includes('no quieter time to suggest'));
});

test('unknown crowding makes no crowding claim', () => {
  const advice = buildAdvice({
    candidates: [candidate('08:00', { isUsual: true, load: 'unknown' }), candidate('08:15', { load: 'seats' })],
    flexibilityMinutes: 15,
  });
  assert.equal(advice.kind, 'unknown');
  assert.equal(advice.prominent, false);
});

const disruption = (overrides = {}) => ({
  active: true, simulated: false, affectsTrip: true, lines: ['NEL'], ...overrides,
});

test('disruption: names the line, the alternative, and the extra time', () => {
  const usual = candidate('08:00', {
    isUsual: true,
    isNow: true,
    routeLabel: 'Bus 666 + EWL + CCL',
    minutes: 61,
    disruption: disruption(),
    baseline: { routeLabel: 'NEL + CCL', durationMinutes: 50, disrupted: true },
    deltaVsUsualMinutes: 11,
  });
  const advice = buildAdvice({ candidates: [usual], flexibilityMinutes: 0 });
  assert.equal(advice.kind, 'disruption');
  assert.equal(advice.prominent, true);
  assert.equal(advice.headline, 'NEL disrupted. Take Bus 666 + EWL + CCL now, +11 min.');
  assert.ok(advice.reason.includes('NEL + CCL, 50 min'));
});

test('disruption: uses the departure time instead of "now" when leaving later, and outranks crowding', () => {
  const usual = candidate('08:00', {
    isUsual: true,
    load: 'limited',
    routeLabel: 'Bus 666 + EWL',
    disruption: disruption(),
    deltaVsUsualMinutes: 5,
  });
  const advice = buildAdvice({ candidates: [usual, candidate('08:15', { load: 'seats' })], flexibilityMinutes: 15 });
  assert.equal(advice.kind, 'disruption');
  assert.equal(advice.headline, 'NEL disrupted. Take Bus 666 + EWL at 08:00, +5 min.');
});

test('a simulated disruption is labelled [SIMULATED] in the headline and flagged', () => {
  const usual = candidate('08:00', {
    isUsual: true, isNow: true, routeLabel: 'Bus 666', disruption: disruption({ simulated: true }), deltaVsUsualMinutes: 11,
  });
  const advice = buildAdvice({ candidates: [usual], flexibilityMinutes: 0 });
  assert.ok(advice.headline.startsWith('[SIMULATED] NEL disrupted.'));
  assert.equal(advice.simulated, true);
});

test('a disruption elsewhere on the network does not change advice for this trip', () => {
  const usual = candidate('08:00', { isUsual: true, disruption: disruption({ affectsTrip: false }) });
  const advice = buildAdvice({ candidates: [usual], flexibilityMinutes: 0 });
  assert.equal(advice.kind, 'fine');
  assert.equal(advice.prominent, false);
});

test('when every route runs through the disruption it says so instead of promising an alternative', () => {
  const usual = candidate('08:00', { isUsual: true, disrupted: true, disruption: disruption() });
  const advice = buildAdvice({ candidates: [usual], flexibilityMinutes: 0 });
  assert.equal(advice.kind, 'disruption');
  assert.ok(advice.headline.includes('Every route to your destination runs through it'));
});

test('joins several affected lines and reports an unplannable trip as unavailable', () => {
  const usual = candidate('08:00', {
    isUsual: true, isNow: true, routeLabel: 'Bus 1', disruption: disruption({ lines: ['NEL', 'CCL', 'DTL'] }), deltaVsUsualMinutes: 3,
  });
  assert.ok(buildAdvice({ candidates: [usual], flexibilityMinutes: 0 }).headline.startsWith('NEL, CCL and DTL disrupted.'));

  const failed = buildAdvice({ candidates: [{ departAt: iso('08:00'), available: false }], flexibilityMinutes: 0 });
  assert.equal(failed.kind, 'unavailable');
  assert.equal(failed.prominent, false);
});

test('describeRoute lists bus services and rail lines once each', () => {
  const route = {
    legs: [
      { type: 'walk' },
      { type: 'bus', serviceNo: '666' },
      { type: 'mrt', line: 'EWL' },
      { type: 'mrt', line: 'EWL' },
      { type: 'walk' },
    ],
  };
  assert.equal(describeRoute(route), 'Bus 666 + EWL');
  assert.equal(describeRoute({ legs: [{ type: 'walk' }] }), 'Walk');
});

/* ----------------------------- upstream budget ---------------------------- */

test('spending outside a budget is a no-op', () => {
  assert.doesNotThrow(() => { for (let i = 0; i < 100; i += 1) spendUpstreamCall(); });
});

test('a budget counts calls, then refuses the next one and reports exhaustion', async () => {
  const result = await runWithCallBudget(3, async () => {
    spendUpstreamCall();
    spendUpstreamCall();
    spendUpstreamCall();
    assert.throws(() => spendUpstreamCall(), CallBudgetExceeded);
    return 'done';
  });
  assert.equal(result.value, 'done');
  assert.equal(result.used, 3);
  assert.equal(result.max, 3);
  assert.equal(result.exhausted, true);
});

test('budgets follow async work and stay isolated between concurrent requests', async () => {
  const work = (calls) => runWithCallBudget(10, async () => {
    for (let i = 0; i < calls; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      spendUpstreamCall();
    }
  });
  const [a, b] = await Promise.all([work(2), work(5)]);
  assert.equal(a.used, 2);
  assert.equal(b.used, 5);
  assert.equal(a.exhausted, false);
});
