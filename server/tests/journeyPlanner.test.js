import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupeRoutesBySignature, rankRoutes } from '../lib/journeyPlanner.js';

const mkRoute = (id, durationMinutes, { disrupted = false, score = null, walkMinutes = 0, transfers = 0 } = {}) => ({
  id,
  durationMinutes,
  walkMinutes,
  transfers,
  disrupted,
  legs: disrupted ? [{ type: 'mrt', line: 'NSL', affected: true }] : [],
  load: { score, band: { label: 'Standing available', short: 'Standing' } },
});

test('a route within the tolerance boundary (exactly 10% slower) still counts; just past it does not', () => {
  const inside = rankRoutes([mkRoute('busy-fast', 20, { score: 0.9 }), mkRoute('quiet-edge', 22, { score: 0.2 })], { tolerance: 0.1 });
  assert.equal(inside.recommendation.routeId, 'quiet-edge');
  const outside = rankRoutes([mkRoute('busy-fast', 20, { score: 0.9 }), mkRoute('quiet-late', 23, { score: 0.2 })], { tolerance: 0.1 });
  assert.equal(outside.recommendation.routeId, 'busy-fast');
});

test('a tolerance of 0 recommends only among routes as fast as the fastest', () => {
  const { recommendation } = rankRoutes([mkRoute('fast', 20, { score: 0.9 }), mkRoute('quiet', 21, { score: 0.1 })], { tolerance: 0 });
  assert.equal(recommendation.routeId, 'fast');
  assert.equal(recommendation.candidateCount, 1);
});

test('a route with no load data is neutral (0.5): it loses to a known-quiet route and beats a known-busy one', () => {
  const routes = [
    mkRoute('busy', 20, { score: 0.9 }),
    mkRoute('unknown', 20, { score: null }),
    mkRoute('quiet', 20, { score: 0.2 }),
  ];
  const { routes: ranked, recommendation } = rankRoutes(routes, { tolerance: 0.1 });
  assert.equal(recommendation.routeId, 'quiet');
  assert.deepEqual(ranked.map((route) => route.id), ['quiet', 'unknown', 'busy']);
});

test('loads within 0.05 of each other are a tie broken by travel time, then by fewer transfers', () => {
  const byTime = rankRoutes([mkRoute('slower', 21, { score: 0.3 }), mkRoute('faster', 20, { score: 0.32 })], { tolerance: 0.1 });
  assert.equal(byTime.recommendation.routeId, 'faster');

  const byTransfers = rankRoutes([
    mkRoute('two-changes', 20, { score: 0.3, transfers: 2 }),
    mkRoute('direct', 20, { score: 0.3, transfers: 0 }),
  ], { tolerance: 0.1 });
  assert.equal(byTransfers.recommendation.routeId, 'direct');
});

test('the recommended route is first, comparable routes next, and routes outside the tolerance last', () => {
  const routes = [
    mkRoute('far-too-slow', 40, { score: 0.1 }),
    mkRoute('comparable', 21, { score: 0.5 }),
    mkRoute('best', 20, { score: 0.2 }),
  ];
  const { routes: ranked } = rankRoutes(routes, { tolerance: 0.1 });
  assert.deepEqual(ranked.map((route) => route.id), ['best', 'comparable', 'far-too-slow']);
  assert.deepEqual(ranked.map((route) => route.recommended), [true, false, false]);
  assert.match(ranked[2].recommendationReason, /more than 10% slower/);
});

test('the tolerance is measured from the fastest UNAFFECTED route, not from a faster disrupted one', () => {
  const routes = [
    mkRoute('fast-disrupted', 10, { disrupted: true, score: 0.1 }),
    mkRoute('clean-fast', 20, { score: 0.9 }),
    mkRoute('clean-quiet', 22, { score: 0.2 }),
  ];
  const { recommendation } = rankRoutes(routes, { tolerance: 0.1 });
  assert.equal(recommendation.fastestRouteId, 'clean-fast');
  assert.equal(recommendation.routeId, 'clean-quiet'); // 22 is within 10% of 20, though 120% of the disrupted 10
});

test('rankRoutes of nothing recommends nothing', () => {
  assert.deepEqual(rankRoutes([]), { routes: [], recommendation: null });
});

test('dedupeRoutesBySignature keeps the first (earliest) copy of each distinct journey', () => {
  const routes = [
    { id: 'route-0-a', signature: 'mrt:NEL:NE17->NE1|mrt:CCL:CC29->CC23' },
    { id: 'route-1-a', signature: 'mrt:NEL:NE17->NE1|mrt:CCL:CC29->CC23' },
    { id: 'route-2-b', signature: 'bus:666:65331->03241' },
    { id: 'route-3-a', signature: 'mrt:NEL:NE17->NE1|mrt:CCL:CC29->CC23' },
  ];
  assert.deepEqual(dedupeRoutesBySignature(routes).map((route) => route.id), ['route-0-a', 'route-2-b']);
});

test('dedupeRoutesBySignature falls back to the id when a route has no signature', () => {
  const routes = [{ id: 'x' }, { id: 'x' }, { id: 'y' }];
  assert.deepEqual(dedupeRoutesBySignature(routes).map((route) => route.id), ['x', 'y']);
});

test('rankRoutes recommends the lowest-load route within the time tolerance', () => {
  const routes = [
    mkRoute('quiet-slower', 21, { score: 0.2 }),
    mkRoute('busy-fastest', 20, { score: 0.9 }),
  ];
  const { recommendation } = rankRoutes(routes, { tolerance: 0.1 });
  assert.equal(recommendation.routeId, 'quiet-slower');
  assert.equal(recommendation.fastestRouteId, 'busy-fastest');
});

test('rankRoutes falls back to the fastest route once a slower one exceeds the tolerance', () => {
  const routes = [
    mkRoute('too-slow-but-quiet', 25, { score: 0.1 }), // 25% slower than fastest, outside a 10% budget
    mkRoute('fastest', 20, { score: 0.9 }),
  ];
  const { recommendation } = rankRoutes(routes, { tolerance: 0.1 });
  assert.equal(recommendation.routeId, 'fastest');
});

test('rankRoutes never recommends a disrupted route while an unaffected one exists, even if slower', () => {
  const routes = [mkRoute('fast-disrupted', 20, { disrupted: true }), mkRoute('clean-slower', 30)];
  const { recommendation, routes: ranked } = rankRoutes(routes, { tolerance: 0.1 });
  assert.equal(recommendation.routeId, 'clean-slower');
  assert.equal(recommendation.disruptionAvoided, true);
  const disruptedRoute = ranked.find((route) => route.id === 'fast-disrupted');
  assert.equal(disruptedRoute.recommended, false);
  assert.match(disruptedRoute.recommendationReason, /service alert on NSL/i);
});

test('rankRoutes falls back to normal load/time ranking when every route is disrupted', () => {
  const routes = [
    mkRoute('a', 20, { disrupted: true, score: 0.8 }),
    mkRoute('b', 21, { disrupted: true, score: 0.2 }),
  ];
  const { recommendation } = rankRoutes(routes, { tolerance: 0.1 });
  assert.equal(recommendation.routeId, 'b'); // 5% slower but much lower load
  assert.equal(recommendation.disruptionAvoided, false);
});

test('rankRoutes with weatherActive favours less time on foot over crowd load', () => {
  const routes = [
    mkRoute('walk-heavy', 30, { score: 0.2, walkMinutes: 20 }),
    mkRoute('transit-heavy', 31, { score: 0.6, walkMinutes: 3 }),
  ];
  assert.equal(rankRoutes(routes, { tolerance: 0.1, weatherActive: false }).recommendation.routeId, 'walk-heavy');
  assert.equal(rankRoutes(routes, { tolerance: 0.1, weatherActive: true }).recommendation.routeId, 'transit-heavy');
});

test('rankRoutes weather reason cites walking time, not crowd load, when weather decided it', () => {
  const routes = [
    mkRoute('walk-heavy', 30, { score: 0.2, walkMinutes: 20 }),
    mkRoute('transit-heavy', 31, { score: 0.6, walkMinutes: 3 }),
  ];
  const { routes: ranked } = rankRoutes(routes, { tolerance: 0.1, weatherActive: true });
  const winner = ranked.find((route) => route.recommended);
  assert.equal(winner.id, 'transit-heavy');
  assert.match(winner.recommendationReason, /3 min on foot instead of 20 min/);
});
