/**
 * Singapore rail network topology (MRT + LRT).
 *
 * Why this exists: OneMap's routing service is the preferred planner, but the
 * LTA DataMall-native fallback planner needs a real, ordered rail graph so it
 * can (a) find a path between two stations, (b) split that path into per-line
 * segments and (c) list every station between boarding and alighting so the
 * per-station platform crowd level can be turned into a leg load.
 *
 * Station names and coordinates come from `server/data/stations.json`
 * (`scripts/build-station-catalog.mjs`); this file only encodes the topology.
 */
import { lineForStationCode, lineMeta } from './railLines.js';
import { loadStationCatalog } from './stationCatalog.js';

/** Builds `NS1..NS28` style code lists. */
const range = (prefix, from, to) => Array.from({ length: to - from + 1 }, (_, index) => `${prefix}${from + index}`);

/** Station codes in running order for each line, including branches/loops. */
export const LINE_CHAINS = {
  NSL: range('NS', 1, 28),
  EWL: range('EW', 1, 33),
  CGL: [],
  NEL: range('NE', 1, 18),
  CCL: range('CC', 1, 33),
  CEL: ['CE1', 'CE2'],
  DTL: range('DT', 1, 37),
  TEL: range('TE', 1, 29),
  BPL: range('BP', 1, 13),
  SLRT: ['SE1', 'SE2', 'SE3', 'SE4', 'SE5'],
  PLRT: ['PE1', 'PE2', 'PE3', 'PE4', 'PE5', 'PE6', 'PE7'],
  JRL: range('JS', 1, 12),
};

/** Additional loop chains whose codes are not part of the parent line chain. */
export const LOOP_CHAINS = {
  SLRT: ['SW1', 'SW2', 'SW3', 'SW4', 'SW5', 'SW6', 'SW7', 'SW8'],
  PLRT: ['PW1', 'PW2', 'PW3', 'PW4', 'PW5', 'PW6', 'PW7'],
};

/** Edges that are not a straight chain-to-chain hop (branches off a parent line). */
export const BRANCH_EDGES = [
  ['EW4', 'CG1'], // Changi Airport branch leaves the East-West Line at Tanah Merah
  ['CC4', 'CE1'], // Marina Bay branch leaves the Circle Line at Promenade
];

/** Loop closures and loop-entry edges (LRT loops hang off the parent MRT station). */
export const LOOP_EDGES = [
  ['BP13', 'BP1'], // Bukit Panjang LRT is a loop
  ['NE16', 'SE1'], ['SE5', 'NE16'], // Sengkang east loop
  ['NE16', 'SW1'], ['SW8', 'NE16'], // Sengkang west loop
  ['NE17', 'PE1'], ['PE7', 'NE17'], // Punggol east loop
  ['NE17', 'PW1'], ['PW7', 'NE17'], // Punggol west loop
];
/**
 * Official interchange groups (codes that share one physical station). The
 * catalog infers most of these from OneMap station names; this table also
 * covers the ones the geocoder does not index (e.g. `CE2` Marina Bay).
 */
export const INTERCHANGE_GROUPS = [
  ['NS1', 'EW24'], // Jurong East
  ['NS4', 'BP1', 'JS1'], // Choa Chu Kang
  ['NS9', 'TE2'], // Woodlands
  ['NS17', 'CC15'], // Bishan
  ['NS21', 'DT11'], // Newton
  ['NS22', 'TE14'], // Orchard
  ['NS24', 'NE6', 'CC1'], // Dhoby Ghaut
  ['NS25', 'EW13'], // City Hall
  ['NS26', 'EW14'], // Raffles Place
  ['NS27', 'CC33', 'CE2', 'TE20'], // Marina Bay
  ['EW2', 'DT32'], // Tampines
  ['EW8', 'CC9'], // Paya Lebar
  ['EW12', 'DT14'], // Bugis
  ['EW16', 'NE3', 'TE17'], // Outram Park
  ['EW21', 'CC22'], // Buona Vista
  ['EW27', 'JS8'], // Boon Lay
  ['CG1', 'DT35'], // Expo
  ['NE1', 'CC29'], // HarbourFront
  ['NE4', 'DT19'], // Chinatown
  ['NE7', 'DT12'], // Little India
  ['NE12', 'CC13'], // Serangoon
  ['NE16', 'SE1', 'SW1'], // Sengkang
  ['NE17', 'PE1', 'PW1'], // Punggol
  ['CC4', 'DT15'], // Promenade
  ['CC10', 'DT26'], // MacPherson
  ['CC17', 'TE9'], // Caldecott
  ['CC19', 'DT9'], // Botanic Gardens
  ['CE1', 'DT16'], // Bayfront
  ['DT1', 'BP6'], // Bukit Panjang
  ['DT10', 'TE11'], // Stevens
  ['DT37', 'TE31'], // Sungei Bedok
];

/**
 * Rail "commercial speed" (metres/second, dwell already included) derived from
 * published NSL/EWL run times - e.g. Bishan (NS17) to Jurong East (NS1) is
 * ~22 km in ~27 minutes ≈ 13.6 m/s.
 */
const SPEED = {
  mrt: 13,
  lrt: 9.5,
};

const TRANSFER_PENALTY_MINUTES = 4.5;
const DEFAULT_EDGE_MINUTES = 2;

const toRadians = (degrees) => (degrees * Math.PI) / 180;

/** Straight-line distance in metres between two `{ latitude, longitude }` points. */
export function haversineMeters(a, b) {
  if (!a || !b) return null;
  const [lat1, lng1, lat2, lng2] = [a.latitude, a.longitude, b.latitude, b.longitude];
  if (![lat1, lng1, lat2, lng2].every((value) => typeof value === 'number' && Number.isFinite(value))) return null;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

/** Every chain (main line plus extra loops) with the line it belongs to. */
function chainCodes() {
  const chains = [];
  for (const [line, codes] of Object.entries(LINE_CHAINS)) {
    if (codes.length > 0) chains.push({ line, codes });
  }
  for (const [line, codes] of Object.entries(LOOP_CHAINS)) {
    chains.push({ line, codes });
  }
  return chains;
}

/** Consecutive pairs inside every chain plus the explicit branch/loop hops. */
function chainEdges() {
  const edges = [];
  for (const { line, codes } of chainCodes()) {
    for (let index = 1; index < codes.length; index += 1) {
      edges.push({ from: codes[index - 1], to: codes[index], line });
    }
  }
  for (const [from, to] of BRANCH_EDGES) {
    edges.push({ from, to, line: lineForStationCode(to) || lineForStationCode(from) });
  }
  for (const [from, to] of LOOP_EDGES) {
    edges.push({ from, to, line: lineForStationCode(to) || lineForStationCode(from) });
  }
  return edges;
}

let networkPromise = null;

/** Builds (once) the in-memory rail graph described above. */
export function railNetwork() {
  if (!networkPromise) networkPromise = buildNetwork();
  return networkPromise;
}

async function buildNetwork() {
  const catalog = await loadStationCatalog();
  const byCode = catalog.byCode || {};

  /** @type {Map<string, { code: string, name: string|null, line: string|null, lines: string[], latitude: number|null, longitude: number|null }>} */
  const stations = new Map();
  const touch = (code) => {
    const key = String(code || '').toUpperCase();
    if (!key) return null;
    if (!stations.has(key)) {
      const entry = byCode[key] || {};
      stations.set(key, {
        code: key,
        name: entry.name || null,
        line: lineForStationCode(key),
        lines: entry.lines?.length ? entry.lines : [lineForStationCode(key)].filter(Boolean),
        latitude: typeof entry.latitude === 'number' ? entry.latitude : null,
        longitude: typeof entry.longitude === 'number' ? entry.longitude : null,
      });
    }
    return stations.get(key);
  };

  for (const { codes } of chainCodes()) for (const code of codes) touch(code);
  for (const [from, to] of [...BRANCH_EDGES, ...LOOP_EDGES]) { touch(from); touch(to); }

  // Coordinates for a few interchanges are published under one partner code
  // only (CE2 shares Marina Bay with NS27), so copy them across the group.
  for (const group of INTERCHANGE_GROUPS) {
    const known = group.map((code) => stations.get(code)).filter((station) => station && station.latitude != null);
    if (known.length === 0) continue;
    for (const code of group) {
      const station = stations.get(code);
      if (!station || station.latitude != null) continue;
      station.latitude = known[0].latitude;
      station.longitude = known[0].longitude;
      if (!station.name) station.name = known[0].name;
    }
  }

  /** @type {Map<string, { to: string, line: string, minutes: number }[]>} */
  const adjacency = new Map();
  const link = (from, to, line) => {
    const a = stations.get(from);
    const b = stations.get(to);
    if (!a || !b) return;
    const lineCode = line || a.line || b.line;
    const isLrt = /LRT/i.test(lineMeta(lineCode)?.name || '');
    const distance = haversineMeters(a, b);
    const seconds = distance ? distance / (isLrt ? SPEED.lrt : SPEED.mrt) : DEFAULT_EDGE_MINUTES * 60;
    const minutes = Math.max(0.8, Math.round(seconds / 6) / 10);
    for (const [origin, destination] of [[from, to], [to, from]]) {
      if (!adjacency.has(origin)) adjacency.set(origin, []);
      adjacency.get(origin).push({ to: destination, line: lineCode, minutes });
    }
  };

  for (const edge of chainEdges()) link(edge.from, edge.to, edge.line);

  // Interchanges behave as a very short platform-to-platform hop; the transfer
  // penalty in `findRailPath` already accounts for the walking time.
  const interchangeLinks = (from, to, line) => {
    if (!adjacency.has(from)) adjacency.set(from, []);
    if (!adjacency.has(to)) adjacency.set(to, []);
    adjacency.get(from).push({ to, line, minutes: 0.5, transfer: true });
    adjacency.get(to).push({ to: from, line, minutes: 0.5, transfer: true });
  };

  const interchanges = new Map();
  for (const group of INTERCHANGE_GROUPS) {
    const present = group.filter((code) => stations.has(code));
    for (const code of present) interchanges.set(code, present.filter((other) => other !== code));
    for (let a = 0; a < present.length; a += 1) {
      for (let b = a + 1; b < present.length; b += 1) {
        interchangeLinks(present[a], present[b], stations.get(present[b])?.line || stations.get(present[a])?.line);
      }
    }
  }

  return {
    stations,
    adjacency,
    interchanges,
    /** Only stations with coordinates can be matched to a user's search point. */
    located: [...stations.values()].filter((station) => station.latitude != null),
    catalogSize: Object.keys(byCode).length,
  };
}

/** Stations sorted by straight-line distance from a search point. */
export async function nearestStations(point, { limit = 4, maxMeters = 1600, lines = null } = {}) {
  const network = await railNetwork();
  const allowed = lines ? new Set(lines) : null;
  return network.located
    .filter((station) => (allowed ? station.lines.some((line) => allowed.has(line)) : true))
    .map((station) => ({ station, distanceMeters: haversineMeters(point, station) }))
    .filter((entry) => entry.distanceMeters != null && entry.distanceMeters <= maxMeters)
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, limit)
    .map((entry) => ({
      code: entry.station.code,
      name: entry.station.name,
      line: entry.station.line,
      lines: entry.station.lines,
      latitude: entry.station.latitude,
      longitude: entry.station.longitude,
      distanceMeters: Math.round(entry.distanceMeters),
    }));
}

/** Station record (name/coordinates/line) for a code, or `null` when unknown. */
export async function railStation(code) {
  const network = await railNetwork();
  return network.stations.get(String(code || '').toUpperCase()) || null;
}

/** Interchange partners for a station code (empty when it is not an interchange). */
export async function interchangeWith(code) {
  const network = await railNetwork();
  return network.interchanges.get(String(code || '').toUpperCase()) || [];
}

/**
 * Dijkstra over station codes with a transfer penalty, so the result is the
 * fastest journey rather than the fewest-stops path.
 *
 * @param {Set<string>} [options.avoidStations] Station codes to route around
 *   (e.g. from a live LTA service alert). A station in this set is treated as
 *   unreachable by rail - the path detours via another line/interchange when
 *   one exists, or the search fails when it doesn't (which correctly pushes
 *   the caller toward a bus alternative instead of riding through the fault).
 * @returns {Promise<{ stations: { code: string, line: string }[], minutes: number, transfers: number }|null>}
 */
export async function findRailPath(fromCode, toCode, { includeLrt = true, avoidStations = null } = {}) {
  const network = await railNetwork();
  const start = String(fromCode || '').toUpperCase();
  const goal = String(toCode || '').toUpperCase();
  if (!network.stations.has(start) || !network.stations.has(goal)) return null;
  if (avoidStations && (avoidStations.has(start) || avoidStations.has(goal))) return null;
  if (start === goal) {
    return { stations: [{ code: start, line: lineForStationCode(start) }], minutes: 0, transfers: 0 };
  }

  const isLrt = (line) => /LRT/i.test(lineMeta(line)?.name || '');
  /** @type {Map<string, number>} */
  const best = new Map([[start, 0]]);
  /** @type {Map<string, { code: string, line: string }>} */
  const previous = new Map();
  const queue = [{ code: start, line: null, minutes: 0, hops: 0 }];

  while (queue.length > 0) {
    queue.sort((a, b) => a.minutes - b.minutes);
    const current = queue.shift();
    if (current.minutes > (best.get(current.code) ?? Infinity)) continue;
    if (current.code === goal) break;

    for (const edge of network.adjacency.get(current.code) || []) {
      if (!includeLrt && isLrt(edge.line)) continue;
      if (avoidStations && avoidStations.has(edge.to)) continue;
      const transferCost = current.line && current.line !== edge.line ? TRANSFER_PENALTY_MINUTES : 0;
      const minutes = current.minutes + edge.minutes + transferCost;
      if (minutes >= (best.get(edge.to) ?? Infinity)) continue;
      best.set(edge.to, minutes);
      previous.set(edge.to, { code: current.code, line: edge.line });
      queue.push({ code: edge.to, line: edge.line, minutes, hops: current.hops + 1 });
    }
  }

  if (!best.has(goal)) return null;

  const stations = [];
  let cursor = goal;
  while (cursor) {
    const step = previous.get(cursor);
    if (!step) { stations.unshift({ code: cursor, line: lineForStationCode(cursor) }); break; }
    stations.unshift({ code: cursor, line: step.line });
    cursor = step.code;
  }

  let transfers = 0;
  for (let index = 1; index < stations.length; index += 1) {
    if (stations[index].line !== stations[index - 1].line) transfers += 1;
  }

  return { stations, minutes: Math.max(1, Math.round(best.get(goal))), transfers };
}

/** Splits a path into single-line segments (`[{ line, stations }]`) for leg building. */
export function splitPathByLine(path) {
  if (!path?.stations?.length) return [];
  const segments = [];
  let current = { line: path.stations[0].line, stations: [path.stations[0].code] };
  for (let index = 1; index < path.stations.length; index += 1) {
    const step = path.stations[index];
    if (step.line === current.line) current.stations.push(step.code);
    else {
      segments.push(current);
      current = { line: step.line, stations: [path.stations[index - 1].code, step.code] };
    }
  }
  segments.push(current);
  return segments;
}