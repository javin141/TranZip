import assert from 'node:assert/strict';
import { hasGoogleRoutesKey, summarizeGoogleRoute } from '../server/lib/googleRoutesClient.js';
import { planJourneyRoutes } from '../server/lib/journeyPlanner.js';
import { enrichRoute } from '../server/lib/journeyPlanner.js';
import { rankRoutes } from '../server/lib/journeyPlanner.js';

console.log('--- Test 1: Verifying hasGoogleRoutesKey with placeholder ---');
// With YOUR_API_KEY in .env, hasGoogleRoutesKey should be false
const hasKey = hasGoogleRoutesKey();
console.log('hasGoogleRoutesKey():', hasKey);
assert.strictEqual(hasKey, false, 'hasGoogleRoutesKey should be false when set to placeholder YOUR_API_KEY');

console.log('\n--- Test 2: Verifying no simulation mode when API key is missing/placeholder ---');
try {
  await planJourneyRoutes({
    origin: { latitude: 1.35089, longitude: 103.83905, name: 'Bishan MRT Station' },
    destination: { latitude: 1.27643, longitude: 103.85148, name: 'Marina Bay MRT Station' },
  });
  assert.fail('planJourneyRoutes should have thrown an error when API key is missing');
} catch (error) {
  console.log('Correctly threw error without simulating routes:');
  console.log('Error message:', error.message);
  console.log('Kind:', error.kind);
  assert.strictEqual(error.kind, 'not_configured');
  assert.ok(error.message.includes('Google Maps API key is not configured'));
}

console.log('\n--- Test 3: Verifying Google Routes normalization and stop resolution ---');
// Sample response mimicking Google Directions v2 computeRoutes for Singapore
const sampleGoogleRoute = {
  duration: '1800s',
  distanceMeters: 10500,
  polyline: { encodedPolyline: '_ibkFk_zxR' },
  legs: [
    {
      duration: '1800s',
      distanceMeters: 10500,
      steps: [
        {
          travelMode: 'WALK',
          staticDuration: '120s',
          distanceMeters: 100,
          polyline: { encodedPolyline: '_ibkFk_zxR' },
          startLocation: { latLng: { latitude: 1.35089, longitude: 103.83905 } },
          endLocation: { latLng: { latitude: 1.35100, longitude: 103.83920 } },
          navigationInstruction: { instructions: 'Walk to Bishan Station' },
        },
        {
          travelMode: 'TRANSIT',
          staticDuration: '1380s',
          distanceMeters: 9800,
          polyline: { encodedPolyline: '_ibkFk_zxR' },
          transitDetails: {
            stopDetails: {
              departureStop: {
                name: 'Bishan',
                location: { latLng: { latitude: 1.3513, longitude: 103.8491 } },
              },
              arrivalStop: {
                name: 'Marina Bay',
                location: { latLng: { latitude: 1.2764, longitude: 103.8545 } },
              },
              departureTime: '2026-09-18T15:00:00Z',
              arrivalTime: '2026-09-18T15:23:00Z',
            },
            headsign: 'Marina South Pier',
            transitLine: {
              name: 'North South Line',
              nameShort: 'NSL',
              color: '#d42e12',
              vehicle: {
                name: { text: 'Subway' },
                type: 'SUBWAY',
              },
            },
            stopCount: 11,
          },
        },
        {
          travelMode: 'WALK',
          staticDuration: '180s',
          distanceMeters: 150,
          polyline: { encodedPolyline: '_ibkFk_zxR' },
          startLocation: { latLng: { latitude: 1.2764, longitude: 103.8545 } },
          endLocation: { latLng: { latitude: 1.27643, longitude: 103.85148 } },
          navigationInstruction: { instructions: 'Walk to destination' },
        },
      ],
    },
  ],
};

const summarized = await summarizeGoogleRoute(sampleGoogleRoute, 0, {
  origin: { name: 'Bishan' },
  destination: { name: 'Marina Bay' },
});

console.log('Summarized route:');
console.log('- ID:', summarized.id);
console.log('- Duration:', summarized.durationMinutes, 'min');
console.log('- Type:', summarized.type);
console.log('- Legs count:', summarized.legs.length);
assert.strictEqual(summarized.legs.length, 3);
assert.strictEqual(summarized.legs[0].type, 'walk');
assert.strictEqual(summarized.legs[1].type, 'mrt');
assert.strictEqual(summarized.legs[1].line, 'NSL');
assert.strictEqual(summarized.legs[1].from.code, 'NS17');
assert.strictEqual(summarized.legs[1].to.code, 'NS27');
assert.strictEqual(summarized.legs[2].type, 'walk');
console.log('- Rail leg intermediate stations count:', summarized.legs[1].intermediateStops.length);
console.log('  Intermediate station codes:', summarized.legs[1].intermediateStops.map((s) => s.code).join(', '));
assert.ok(summarized.legs[1].intermediateStops.length > 0, 'Intermediate stations should be interpolated');

console.log('\n--- Test 4: Verifying bus route normalization and 5-digit bus stop code resolution ---');
const sampleGoogleBusRoute = {
  duration: '2100s',
  distanceMeters: 8000,
  legs: [
    {
      duration: '2100s',
      distanceMeters: 8000,
      steps: [
        {
          travelMode: 'WALK',
          staticDuration: '120s',
          distanceMeters: 80,
          navigationInstruction: { instructions: 'Walk to bus stop' },
        },
        {
          travelMode: 'TRANSIT',
          staticDuration: '1800s',
          distanceMeters: 7500,
          transitDetails: {
            stopDetails: {
              departureStop: {
                name: 'Opp Bishan Stn (53239)',
                location: { latLng: { latitude: 1.3508, longitude: 103.8484 } },
              },
              arrivalStop: {
                name: 'Opp Marina Bay Stn (03531)',
                location: { latLng: { latitude: 1.2764, longitude: 103.8545 } },
              },
              departureTime: '2026-09-18T15:00:00Z',
              arrivalTime: '2026-09-18T15:30:00Z',
            },
            headsign: 'Marina Bay',
            transitLine: {
              name: 'Bus 56',
              nameShort: '56',
              vehicle: {
                name: { text: 'Bus' },
                type: 'BUS',
              },
            },
          },
        },
      ],
    },
  ],
};

const summarizedBus = await summarizeGoogleRoute(sampleGoogleBusRoute, 1, {
  origin: { name: 'Bishan' },
  destination: { name: 'Marina Bay' },
});

console.log('Summarized Bus route:');
console.log('- Bus leg type:', summarizedBus.legs[1].type);
console.log('- Bus serviceNo:', summarizedBus.legs[1].serviceNo);
console.log('- Departure stop code:', summarizedBus.legs[1].from.code);
console.log('- Arrival stop code:', summarizedBus.legs[1].to.code);
assert.strictEqual(summarizedBus.legs[1].type, 'bus');
assert.strictEqual(summarizedBus.legs[1].serviceNo, '56');
assert.strictEqual(summarizedBus.legs[1].from.code, '53239');
assert.strictEqual(summarizedBus.legs[1].to.code, '03531');

console.log('\n--- Test 5: Verifying crowd-based ranking among Google Transit routes ---');
// Create two alternative routes:
// Route A: 30 min (fastest), but higher crowd (0.75)
// Route B: 32 min (within 10% of fastest), but lower crowd (0.25)
const routeA = { ...summarized, id: 'route-a', durationMinutes: 30, ordinal: 1, load: { score: 0.75, band: { short: 'Standing', label: 'Standing available' } } };
const routeB = { ...summarizedBus, id: 'route-b', durationMinutes: 32, ordinal: 2, load: { score: 0.25, band: { short: 'Seats', label: 'Seats available' } } };

const rankingResult = rankRoutes([routeA, routeB], { tolerance: 0.1 });
console.log('Ranked routes count:', rankingResult.routes.length);
console.log('Recommended route ID:', rankingResult.recommendation.routeId);
console.log('Recommended reason:', rankingResult.recommendation.reason);
assert.strictEqual(rankingResult.recommendation.routeId, 'route-b', 'Route B should win due to lower crowd level');
assert.strictEqual(rankingResult.routes[0].id, 'route-b', 'Recommended route should be first in ordered routes');
assert.strictEqual(rankingResult.routes[0].recommended, true);
assert.strictEqual(rankingResult.routes[1].recommended, false);

console.log('\n--- Test 6: Verifying live LTA crowd data enrichment on Google summarized route ---');
const context = {
  nowMs: Date.now(),
  departureMs: Date.now(),
  useForecast: false,
  includeServiceInfo: true,
  includeStationInfo: true,
};
await enrichRoute(summarized, context);
console.log('Live LTA MRT enrichment on Google route:');
console.log('- Route load score:', summarized.load?.score);
console.log('- Route load band:', summarized.load?.band?.label);
console.log('- Rail stations with crowd data:', summarized.legs[1].load?.stations?.length);
const sampleStations = (summarized.legs[1].load?.stations || []).slice(0, 5);
for (const s of sampleStations) {
  console.log(`  * ${s.code} (${s.name}): crowdLevel=${s.crowdLevel || 'no data'}, band=${s.band?.label}`);
}

console.log('\nAll tests passed successfully!');

