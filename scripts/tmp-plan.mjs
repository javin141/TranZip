// Temporary verification script (deleted before hand-off).
import { planJourneyRoutes } from '../server/lib/journeyPlanner.js';

const cases = [
  {
    label: 'Ang Mo Kio -> Marina Bay',
    origin: { latitude: 1.3699, longitude: 103.8455, name: 'Ang Mo Kio' },
    destination: { latitude: 1.2792, longitude: 103.8545, name: 'Marina Bay' },
  },
  {
    label: 'Bishan -> Jurong East (MRT vs bus)',
    origin: { latitude: 1.3508, longitude: 103.8484, name: 'Bishan' },
    destination: { latitude: 1.333, longitude: 103.7424, name: 'Jurong East' },
  },
  {
    label: 'Tampines -> NUS',
    origin: { latitude: 1.3531, longitude: 103.9453, name: 'Tampines' },
    destination: { latitude: 1.2966, longitude: 103.7764, name: 'NUS' },
  },
];

for (const testCase of cases) {
  const started = Date.now();
  const result = await planJourneyRoutes({ ...testCase, maxRoutes: 6 });
  console.log(`\n=== ${testCase.label} (${Date.now() - started} ms, source=${result.routingSource}) ===`);
  console.log('warnings:', result.warnings.map((warning) => `${warning.mode}: ${warning.message.slice(0, 90)}`).join(' | ') || 'none');
  console.log('recommendation:', result.recommendation?.reason);
  for (const route of result.routes) {
    const legs = route.legs
      .map((leg) => (leg.type === 'walk'
        ? `walk ${leg.durationMinutes}m`
        : `${leg.type === 'bus' ? `bus ${leg.serviceNo}` : leg.line} ${leg.durationMinutes}m [${leg.load?.band?.label || 'no data'}]`))
      .join(' -> ');
    console.log(` ${route.recommended ? '*' : ' '} #${route.ordinal} ${route.durationMinutes}min ${route.type} load=${route.load?.score?.toFixed?.(2) ?? 'n/a'} (${route.load?.band?.label}) legs=${legs}`);
    if (route.recommended) {
      console.log('   reason:', route.recommendationReason);
      for (const leg of route.legs) {
        if (leg.type === 'mrt' && leg.load?.stations) {
          console.log(`   ${leg.line} stations:`, leg.load.stations.map((station) => `${station.code}=${station.crowdLevel || '?'}`).join(' '));
        }
        if (leg.type === 'bus') {
          console.log(`   bus ${leg.serviceNo}:`, leg.load?.note, '| upcoming', (leg.load?.upcoming || []).map((slot) => `${slot.minutesUntil}m/${slot.band.short}`).join(', '));
        }
      }
    }
  }
}