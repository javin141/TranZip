// Temporary verification script (deleted before hand-off).
import { findRailPath, nearestStations, splitPathByLine, railNetwork } from '../server/lib/railNetwork.js';
import { loadStationCatalog } from '../server/lib/stationCatalog.js';

const pairs = [['NS17', 'EW24'], ['EW1', 'BP13'], ['NS17', 'DT16'], ['NE1', 'TE29'], ['CC1', 'CE1'], ['NS13', 'TE29'], ['JE5', 'NS28']];

const network = await railNetwork();
const catalog = await loadStationCatalog();
console.log('graph stations', network.stations.size, 'adjacency keys', network.adjacency.size, 'located', network.located.length, 'catalog', Object.keys(catalog.byCode).length);

for (const [from, to] of pairs) {
  const path = await findRailPath(from, to);
  console.log(`${from} -> ${to}:`, path ? `${path.minutes}min transfers=${path.transfers} :: ${path.stations.map((s) => s.code).join(' ')}` : 'null');
  if (path) {
    console.log('   segments:', splitPathByLine(path).map((s) => `${s.line}(${s.stations.length}) ${s.stations.join('+')}`).join(' | '));
  }
}

console.log('nearest to Bishan:', (await nearestStations({ latitude: 1.3508, longitude: 103.8484 })).map((s) => `${s.code}@${s.distanceMeters}m`).join(', '));
console.log('nearest to Marina Bay Sands:', (await nearestStations({ latitude: 1.2834, longitude: 103.8607 }, { maxMeters: 1200 })).map((s) => `${s.code}@${s.distanceMeters}m`).join(', '));