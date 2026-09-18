/**
 * Bus network index built from LTA DataMall reference data.
 *
 * `/BusRoutes` (one row per stop per direction) plus `/BusServices` (operator,
 * frequency, loop description) and `/BusStops` (coordinates) are combined into
 * the lookups the LTA-native journey planner needs:
 *
 *   routes   `serviceNo|direction` -> ordered stop list with cumulative distance
 *   byStop   stop code -> every service calling there, with its stop sequence
 *   grid     ~500 m spatial hash so "stops near me" is cheap
 *
 * The 27,000-row dataset takes ~6 s to page through, so the parsed index is
 * cached for 24 h and snapshotted to `.cache/bus-network.json.gz`, which makes
 * a server restart instant.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

import { config } from '../config.js';
import { createCache, memoize } from './cache.js';
import { getBusRouteRows, getBusServicesMap, getBusStopsMap } from './ltaClient.js';
import { haversineMeters } from './railNetwork.js';

const CACHE = createCache('bus:network');
const SNAPSHOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.cache');
const SNAPSHOT_PATH = path.join(SNAPSHOT_DIR, 'bus-network.json.gz');

/** Grid cell size (~500 m) used for nearby-stop queries. */
const CELL = 0.0045;

function cellKey(point) {
  return `${Math.floor(point.latitude / CELL)}:${Math.floor(point.longitude / CELL)}`;
}
/** Builds the compact, JSON-serialisable index from the LTA datasets. */
async function buildIndex() {
  const [routeRows, services, stops] = await Promise.all([
    getBusRouteRows(),
    getBusServicesMap(),
    getBusStopsMap(),
  ]);

  /** @type {Map<string, any>} */
  const routes = new Map();
  for (const row of routeRows) {
    const serviceNo = String(row.ServiceNo || '').trim();
    const direction = String(row.Direction ?? '');
    if (!serviceNo) continue;
    const key = `${serviceNo}|${direction}`;
    if (!routes.has(key)) {
      const info = services.get(key) || null;
      const peaks = [info?.frequency?.amPeak, info?.frequency?.pmPeak]
        .map((value) => Number.parseInt(String(value || '').split('-')[0], 10))
        .filter((value) => Number.isFinite(value));
      routes.set(key, {
        serviceNo,
        direction,
        operator: info?.operator || row.Operator || null,
        category: info?.category || null,
        loopDescription: info?.loopDescription || '',
        frequencyLabel: info?.frequencyLabel || null,
        peakFrequency: peaks.length > 0 ? Math.min(...peaks) : null,
        stops: [],
      });
    }
    routes.get(key).stops.push({
      code: String(row.BusStopCode || ''),
      seq: Number(row.StopSequence) || 0,
      distance: Number(row.Distance) || 0,
    });
  }

  for (const route of routes.values()) {
    route.stops.sort((a, b) => a.seq - b.seq);
    route.originCode = route.stops[0]?.code || null;
    route.destinationCode = route.stops[route.stops.length - 1]?.code || null;
    route.totalDistance = route.stops[route.stops.length - 1]?.distance || 0;
  }

  /** @type {Map<string, { serviceNo: string, direction: string, seq: number, distance: number }[]>} */
  const byStop = new Map();
  for (const route of routes.values()) {
    for (const stop of route.stops) {
      if (!byStop.has(stop.code)) byStop.set(stop.code, []);
      byStop.get(stop.code).push({
        serviceNo: route.serviceNo,
        direction: route.direction,
        seq: stop.seq,
        distance: stop.distance,
      });
    }
  }

  /** @type {Record<string, string[]>} */
  const grid = {};
  const stopList = [];
  for (const stop of stops.values()) {
    if (!Number.isFinite(stop.latitude) || !Number.isFinite(stop.longitude)) continue;
    const compact = {
      code: stop.code,
      name: stop.name,
      road: stop.road,
      latitude: stop.latitude,
      longitude: stop.longitude,
    };
    stopList.push(compact);
    const key = cellKey(compact);
    if (!grid[key]) grid[key] = [];
    grid[key].push(stop.code);
  }

  return {
    generatedAt: new Date().toISOString(),
    routeRowCount: routeRows.length,
    routes: Object.fromEntries(routes),
    byStop: Object.fromEntries(byStop),
    stops: stopList,
    grid,
  };
}

/** Turns the serialisable snapshot back into Maps. */
function hydrate(raw) {
  const routes = new Map(Object.entries(raw.routes || {}));
  const byStop = new Map(Object.entries(raw.byStop || {}));
  const stops = new Map((raw.stops || []).map((stop) => [stop.code, stop]));
  return {
    generatedAt: raw.generatedAt || null,
    routeRowCount: raw.routeRowCount || 0,
    routes,
    byStop,
    stops,
    grid: raw.grid || {},
    serviceCount: routes.size,
    stopCount: stops.size,
  };
}

async function readSnapshot() {
  try {
    const raw = JSON.parse(gunzipSync(await readFile(SNAPSHOT_PATH)).toString('utf8'));
    const age = Date.now() - Date.parse(raw.generatedAt || 0);
    if (!Number.isFinite(age) || age > config.ttl.reference) return null;
    return hydrate(raw);
  } catch {
    return null;
  }
}

async function writeSnapshot(compact) {
  try {
    await mkdir(SNAPSHOT_DIR, { recursive: true });
    await writeFile(SNAPSHOT_PATH, gzipSync(Buffer.from(JSON.stringify(compact)), { level: 6 }));
  } catch (error) {
    console.warn('[bus-network] snapshot write skipped:', error.message);
  }
}
/**
 * Loads the bus network: disk snapshot when it is younger than the reference
 * TTL, otherwise a fresh build straight from LTA DataMall.
 */
export function getBusNetwork() {
  return memoize({
    cache: CACHE,
    key: 'index',
    ttlMs: config.ttl.reference,
    loader: async () => {
      const snapshot = await readSnapshot();
      if (snapshot) {
        console.log(`[bus-network] loaded ${snapshot.serviceCount} service directions from snapshot`);
        return snapshot;
      }
      const compact = await buildIndex();
      await writeSnapshot(compact);
      const hydrated = hydrate(compact);
      console.log(`[bus-network] built index: ${hydrated.serviceCount} service directions, ${hydrated.stopCount} stops`);
      return hydrated;
    },
  });
}

/** Stops within `radiusMeters` of a point, nearest first. */
export async function stopsNear(point, { radiusMeters = 500, limit = 24 } = {}) {
  const network = await getBusNetwork();
  const cellMeters = CELL * 111000;
  const radiusCells = Math.ceil(radiusMeters / cellMeters);
  const baseLat = Math.floor(point.latitude / CELL);
  const baseLng = Math.floor(point.longitude / CELL);
  const codes = new Set();
  for (let dLat = -radiusCells; dLat <= radiusCells; dLat += 1) {
    for (let dLng = -radiusCells; dLng <= radiusCells; dLng += 1) {
      for (const code of network.grid[`${baseLat + dLat}:${baseLng + dLng}`] || []) codes.add(code);
    }
  }
  const found = [];
  for (const code of codes) {
    const stop = network.stops.get(code);
    const distance = haversineMeters(point, stop);
    if (distance != null && distance <= radiusMeters) found.push({ stop, distanceMeters: Math.round(distance) });
  }
  found.sort((a, b) => a.distanceMeters - b.distanceMeters);
  return found.slice(0, limit);
}

/** Every service (with its stop sequence) that calls at a stop. */
export async function servicesAtStop(stopCode) {
  const network = await getBusNetwork();
  return network.byStop.get(String(stopCode)) || [];
}

/** Ordered stop list for one service direction, or `null`. */
export async function busRouteStops(serviceNo, direction) {
  const network = await getBusNetwork();
  return network.routes.get(`${String(serviceNo)}|${String(direction)}`) || null;
}

/** Reference row for a service direction (operator, frequency, loop text). */
export async function busRouteInfo(serviceNo, direction) {
  const route = await busRouteStops(serviceNo, direction);
  if (!route) return null;
  return {
    serviceNo: route.serviceNo,
    direction: route.direction,
    operator: route.operator,
    category: route.category,
    loopDescription: route.loopDescription,
    frequencyLabel: route.frequencyLabel,
    peakFrequency: route.peakFrequency,
    originCode: route.originCode,
    destinationCode: route.destinationCode,
    totalDistance: route.totalDistance,
    stopCount: route.stops.length,
  };
}

/** Stop record with coordinates, or `null`. */
export async function busStop(stopCode) {
  const network = await getBusNetwork();
  return network.stops.get(String(stopCode)) || null;
}

/** Compact stats for /api/meta and /api/system/health. */
export async function busNetworkSummary() {
  const network = await getBusNetwork();
  return {
    generatedAt: network.generatedAt,
    routeRows: network.routeRowCount,
    serviceDirections: network.serviceCount,
    stops: network.stopCount,
  };
}

/** Warms the index in the background at start-up. */
export async function warmBusNetwork() {
  try {
    return await getBusNetwork();
  } catch (error) {
    console.warn('[bus-network] warm-up failed:', error.message);
    return null;
  }
}