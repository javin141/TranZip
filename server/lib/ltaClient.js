import { config } from '../config.js';
import { buildUrl, requestJson } from './http.js';
import { createCache, memoize } from './cache.js';
import { RAIL_LINES } from './railLines.js';

const CACHE = {
  busStops: createCache('lta:busStops'),
  busServices: createCache('lta:busServices'),
  busRoutes: createCache('lta:busRoutes'),
  busArrival: createCache('lta:busArrival'),
  crowd: createCache('lta:crowd'),
  crowdForecast: createCache('lta:crowdForecast'),
  alerts: createCache('lta:alerts'),
};

/** Lines accepted by `/PCDRealTime` and `/PCDForecast` (see railLines.js). */
export const TRAIN_LINES = RAIL_LINES;

function assertConfigured() {
  if (!config.lta.accountKey) {
    const error = new Error('LTA_ACCOUNT_KEY is not configured on the server.');
    error.statusCode = 503;
    error.kind = 'not_configured';
    throw error;
  }
}

async function ltaGet(path, params = {}, { timeoutMs } = {}) {
  assertConfigured();
  const url = buildUrl(config.lta.baseUrl, path, params);
  return requestJson(url, {
    service: 'LTA DataMall',
    timeoutMs: timeoutMs ?? config.requestTimeoutMs,
    headers: {
      AccountKey: config.lta.accountKey,
      Accept: 'application/json',
    },
  });
}

/** LTA pages every "bulk" endpoint in blocks of 500 using `$skip`. */
async function ltaGetAll(path, { maxPages = 40 } = {}) {
  const rows = [];
  for (let page = 0; page < maxPages; page += 1) {
    const chunk = await ltaGet(path, { $skip: page * config.lta.pageSize });
    const value = Array.isArray(chunk) ? chunk : chunk?.value;
    if (!Array.isArray(value) || value.length === 0) break;
    rows.push(...value);
    if (value.length < config.lta.pageSize) break;
  }
  return rows;
}
/* ------------------------------------------------------------------ *
 * Bus reference data
 * ------------------------------------------------------------------ */

async function loadBusStops() {
  const rows = await ltaGetAll('/BusStops');
  const byCode = new Map();
  for (const row of rows) {
    byCode.set(row.BusStopCode, {
      code: row.BusStopCode,
      name: row.Description,
      road: row.RoadName,
      latitude: Number(row.Latitude),
      longitude: Number(row.Longitude),
    });
  }
  return byCode;
}

/** All ~5,200 bus stops keyed by 5-digit code. Cached for 24h. */
export function getBusStopsMap() {
  return memoize({
    cache: CACHE.busStops,
    key: 'all',
    ttlMs: config.ttl.reference,
    loader: loadBusStops,
  });
}

export async function getBusStop(busStopCode) {
  const stops = await getBusStopsMap();
  return stops.get(String(busStopCode)) || null;
}

/**
 * Bus services reference data (route endpoints, loop description, frequencies)
 * keyed by `serviceNo|direction`.
 *
 * Note: DataMall ignores `$filter` on these bulk endpoints, so the full
 * dataset is paged once and cached for 24h.
 */
export function getBusServicesMap() {
  return memoize({
    cache: CACHE.busServices,
    key: 'all',
    ttlMs: config.ttl.reference,
    loader: async () => {
      const rows = await ltaGetAll('/BusServices', { maxPages: 12 });
      const byKey = new Map();
      for (const row of rows) {
        byKey.set(`${row.ServiceNo}|${row.Direction}`, {
          serviceNo: row.ServiceNo,
          operator: row.Operator,
          direction: row.Direction,
          category: row.Category,
          originCode: row.OriginCode,
          destinationCode: row.DestinationCode,
          loopDescription: row.LoopDesc || '',
          frequency: {
            amPeak: row.AM_Peak_Freq,
            amOffPeak: row.AM_Offpeak_Freq,
            pmPeak: row.PM_Peak_Freq,
            pmOffPeak: row.PM_Offpeak_Freq,
          },
          // Pre-rendered so callers never have to format nested frequency data.
          frequencyLabel: row.AM_Peak_Freq || row.PM_Peak_Freq
            ? [
              row.AM_Peak_Freq ? `${row.AM_Peak_Freq} min AM peak` : null,
              row.PM_Peak_Freq ? `${row.PM_Peak_Freq} min PM peak` : null,
            ].filter(Boolean).join(', ')
            : null,
        });
      }
      return byKey;
    },
  });
}

/** Reference details for one service, preferring the direction that serves `towardsStopCode`. */
export async function getBusServiceInfo(serviceNo, towardsStopCode) {
  const services = await getBusServicesMap();
  const number = String(serviceNo).toUpperCase();
  const candidates = [...services.values()].filter((s) => s.serviceNo.toUpperCase() === number);
  if (candidates.length === 0) return null;
  if (towardsStopCode) {
    const target = String(towardsStopCode);
    const match = candidates.find((s) => s.destinationCode === target || s.originCode === target);
    if (match) return match;
  }
  return candidates.find((s) => s.direction === 1) || candidates[0];
}
/* ------------------------------------------------------------------ *
 * Real-time bus arrivals (with live passenger load band)
 * ------------------------------------------------------------------ */

export function getBusArrival(busStopCode) {
  const code = String(busStopCode);
  return memoize({
    cache: CACHE.busArrival,
    key: code,
    ttlMs: config.ttl.busArrival,
    loader: async () => {
      // DataMall answers 404 for unknown stop codes; surface that as "no services".
      const payload = await ltaGet('/v3/BusArrival', { BusStopCode: code }).catch((error) => {
        if (error.kind === 'not_found') return { Services: [] };
        throw error;
      });
      return {
        busStopCode: code,
        fetchedAt: new Date().toISOString(),
        services: Array.isArray(payload?.Services) ? payload.Services : [],
      };
    },
  });
}

/**
 * Every `/BusRoutes` row (~27,000 across 54 pages): one row per stop served by
 * each direction of each service, with the cumulative distance from the start
 * of the trip. This is the raw material for the offline journey planner.
 *
 * Fetching all pages takes ~6 s, so the parsed rows are cached for 24 h and
 * also snapshotted to disk (see server/lib/busNetwork.js).
 */
export function getBusRouteRows() {
  return memoize({
    cache: CACHE.busRoutes,
    key: 'all',
    ttlMs: config.ttl.reference,
    loader: () => ltaGetAll('/BusRoutes', { maxPages: 70 }),
  });
}

/** Arrivals for several stops at once (drives the "stops near me" panel). */
export async function getBusArrivalsForStops(codes) {
  const unique = [...new Set(codes.map(String))].slice(0, 24);
  const results = await Promise.allSettled(unique.map((code) => getBusArrival(code)));
  return results.map((result, index) => (
    result.status === 'fulfilled'
      ? result.value
      : {
        busStopCode: unique[index],
        fetchedAt: new Date().toISOString(),
        services: [],
        error: result.reason?.message || 'unavailable',
      }
  ));
}

/* ------------------------------------------------------------------ *
 * MRT / LRT platform crowd density
 * ------------------------------------------------------------------ */

/** Real-time crowd level per station, covering the latest 10-minute window. */
export function getCrowdRealTime(trainLine) {
  const line = String(trainLine).toUpperCase();
  return memoize({
    cache: CACHE.crowd,
    key: line,
    ttlMs: config.ttl.crowd,
    loader: async () => {
      const payload = await ltaGet('/PCDRealTime', { TrainLine: line });
      const rows = Array.isArray(payload?.value) ? payload.value : [];
      return {
        trainLine: line,
        fetchedAt: new Date().toISOString(),
        window: rows[0] ? { start: rows[0].StartTime, end: rows[0].EndTime } : null,
        stations: rows.map((row) => ({
          code: row.Station,
          crowdLevel: String(row.CrowdLevel || '').toLowerCase(),
          startTime: row.StartTime,
          endTime: row.EndTime,
        })),
      };
    },
  });
}

/** 30-minute interval crowd forecast for the operating day (06:00-24:00). */
export function getCrowdForecast(trainLine) {
  const line = String(trainLine).toUpperCase();
  return memoize({
    cache: CACHE.crowdForecast,
    key: line,
    ttlMs: config.ttl.crowdForecast,
    loader: async () => {
      const payload = await ltaGet('/PCDForecast', { TrainLine: line });
      const days = Array.isArray(payload?.value) ? payload.value : [];
      const today = days[0];
      const stations = (today?.Stations || []).map((station) => ({
        code: station.Station,
        intervals: (station.Interval || []).map((interval) => ({
          start: interval.Start,
          crowdLevel: String(interval.CrowdLevel || '').toLowerCase(),
        })),
      }));
      return {
        trainLine: line,
        fetchedAt: new Date().toISOString(),
        date: today?.Date || null,
        stations,
      };
    },
  });
}

/* ------------------------------------------------------------------ *
 * Service alerts
 * ------------------------------------------------------------------ */

export function getTrainServiceAlerts() {
  return memoize({
    cache: CACHE.alerts,
    key: 'all',
    ttlMs: config.ttl.alerts,
    loader: async () => {
      const payload = await ltaGet('/TrainServiceAlerts');
      const value = payload?.value || {};
      return {
        fetchedAt: new Date().toISOString(),
        status: value.Status ?? null,
        affectedSegments: value.AffectedSegments || [],
        messages: (value.Message || []).map((message) => ({
          content: message.Content,
          createdDate: message.CreatedDate,
        })),
      };
    },
  });
}

export function ltaCacheStats() {
  return Object.values(CACHE).map((cache) => cache.stats());
}