import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { getDemoDisruptionActive, isDemoModeAvailable, normaliseSegment, setDemoDisruptionActive } from '../lib/disruptions.js';
import { demoDisruptionFixture } from '../data/test-overrides.js';

// Whichever way DEMO_MODE happens to be set in this environment's .env (this
// suite doesn't control that, and both are legitimate - a contributor's own
// .env may well have it on), leave the runtime toggle as it was found.
after(() => {
  setDemoDisruptionActive(false);
});

test('normaliseSegment parses station-code free-bus and free-shuttle fields', () => {
  const segment = normaliseSegment({
    Line: 'NEL',
    Direction: 'Towards HarbourFront',
    Stations: 'NE14,NE15,NE16',
    FreePublicBus: 'NE14,NE16',
    FreeMRTShuttle: 'NE15',
    MRTShuttleDirection: 'Between Hougang and Sengkang',
  });
  assert.deepEqual(segment.freeBusStations, ['NE14', 'NE16']);
  assert.equal(segment.freeBusIslandWide, false);
  assert.deepEqual(segment.shuttleStations, ['NE15']);
  assert.equal(segment.shuttleIslandWide, false);
  assert.equal(segment.shuttleDirection, 'Between Hougang and Sengkang');
});

test('normaliseSegment recognises "island wide" free bus instead of a station list', () => {
  const segment = normaliseSegment({
    Line: 'NSL',
    Stations: 'NS22',
    FreePublicBus: 'Free bus service island wide',
    FreeMRTShuttle: '',
  });
  assert.deepEqual(segment.freeBusStations, []);
  assert.equal(segment.freeBusIslandWide, true);
  assert.deepEqual(segment.shuttleStations, []);
  assert.equal(segment.shuttleIslandWide, false);
});

test('normaliseSegment drops non-station codes and handles empty/missing fields', () => {
  const segment = normaliseSegment({
    Line: 'NSL',
    Stations: 'NS22,NOT-A-CODE,NS24',
  });
  assert.deepEqual(segment.stations, ['NS22', 'NS24']);
  assert.deepEqual(segment.freeBusStations, []);
  assert.equal(segment.freeBusIslandWide, false);
  assert.equal(segment.shuttleDirection, null);
});

test('normaliseSegment returns a null line for a segment with no Line', () => {
  assert.equal(normaliseSegment({ Stations: 'NS22' }).line, null);
});

test('normaliseSegment tolerates lower case, stray spaces and trailing commas in station lists', () => {
  const segment = normaliseSegment({
    Line: 'nel',
    Stations: ' ne14 , NE15,, ne16, ',
    FreePublicBus: 'ne14 ,',
    FreeMRTShuttle: ' ne15',
  });
  assert.equal(segment.line, 'NEL');
  assert.deepEqual(segment.stations, ['NE14', 'NE15', 'NE16']);
  assert.deepEqual(segment.freeBusStations, ['NE14']);
  assert.deepEqual(segment.shuttleStations, ['NE15']);
});

test('normaliseSegment recognises "island wide" for the free MRT shuttle too, in any case', () => {
  const segment = normaliseSegment({ Line: 'EWL', Stations: 'EW1', FreeMRTShuttle: 'FREE MRT SHUTTLE ISLAND WIDE' });
  assert.equal(segment.shuttleIslandWide, true);
  assert.deepEqual(segment.shuttleStations, []);
  assert.equal(segment.freeBusIslandWide, false);
});

test('normaliseSegment does not mistake the old "Yes" flag for a station list', () => {
  const segment = normaliseSegment({ Line: 'NSL', Stations: 'NS22', FreePublicBus: 'Yes', FreeMRTShuttle: 'No' });
  assert.deepEqual(segment.freeBusStations, []);
  assert.deepEqual(segment.shuttleStations, []);
  assert.equal(segment.freeBusIslandWide, false);
});

test('normaliseSegment keeps the direction and a human line name', () => {
  const segment = normaliseSegment({ Line: 'NEL', Direction: 'Towards HarbourFront', Stations: 'NE14' });
  assert.equal(segment.direction, 'Towards HarbourFront');
  assert.ok(segment.lineName && segment.lineName !== '');
});

test('the shipped demo fixture normalises into the NEL stretch the README describes', () => {
  const [raw] = demoDisruptionFixture.segments;
  const segment = normaliseSegment(raw);
  assert.equal(segment.line, 'NEL');
  assert.deepEqual(segment.stations, ['NE14', 'NE15', 'NE16']);
  assert.deepEqual(segment.freeBusStations, ['NE14']);
  assert.ok(demoDisruptionFixture.messages.length > 0);
});

test('the demo disruption toggle only ever activates when DEMO_MODE is set (config.demoMode)', () => {
  // Whatever this environment's DEMO_MODE happens to be, the toggle's
  // behaviour must track it exactly: activate when available, stay refused
  // (always false) when it isn't - never the other way around.
  const available = isDemoModeAvailable();
  const result = setDemoDisruptionActive(true);
  assert.equal(result, available);
  assert.equal(getDemoDisruptionActive(), available);
});

test('setDemoDisruptionActive(false) always turns the toggle off, regardless of DEMO_MODE', () => {
  setDemoDisruptionActive(true);
  setDemoDisruptionActive(false);
  assert.equal(getDemoDisruptionActive(), false);
});
