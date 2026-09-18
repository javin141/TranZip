import { config } from '../config.js';
import { buildUrl, decodeJwtExpiry, requestJson, UpstreamError } from './http.js';
import { createCache, memoize } from './cache.js';

const CACHE = {
  search: createCache('onemap:search'),
  revgeocode: createCache('onemap:revgeocode'),
  token: createCache('onemap:token'),
  stationName: createCache('onemap:stationName'),
  routes: createCache('onemap:routes'),
};

/** OneMap denies requests with a valid-but-throttled token using a 403. */
function explainForbidden(error) {
  if (error instanceof UpstreamError && error.status === 403) {
    return new UpstreamError(
      'OneMap returned HTTP 403. The access token may have expired or the account quota is '
      + 'exhausted - requests are throttled, cached and retried automatically.',
      {
        service: 'OneMap',
        status: 403,
        kind: 'forbidden',
        url: error.url,
        body: error.body,
      },
    );
  }
  return error;
}

export function hasOneMapToken() {
  const token = config.oneMap.token;
  if (!token) return false;
  const expiry = decodeJwtExpiry(token);
  return !expiry || expiry > Date.now();
}

async function currentToken() {
  const configured = config.oneMap.token;
  const expiry = configured ? decodeJwtExpiry(configured) : null;
  if (configured && (!expiry || expiry - Date.now() > 60_000)) return configured;

  if (!config.oneMap.email || !config.oneMap.password) {
    if (configured) return configured; // trust it even when `exp` cannot be read
    throw new UpstreamError(
      'No usable OneMap token. Set ONEMAP_TOKEN (plus ONEMAP_EMAIL and ONEMAP_PASSWORD for '
      + 'automatic renewal) in .env.',
      { service: 'OneMap', kind: 'not_configured' },
    );
  }

  return memoize({
    cache: CACHE.token,
    key: 'access-token',
    ttlMs: 23 * 60 * 60 * 1000,
    loader: async () => {
      const url = buildUrl(config.oneMap.baseUrl, '/auth/post/getToken');
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          email: config.oneMap.email,
          password: config.oneMap.password,
        }),
      });
      const text = await res.text();
      if (!res.ok) {
        throw new UpstreamError(`OneMap token refresh failed (${res.status})`, {
          service: 'OneMap', status: res.status, url, body: text, kind: 'auth',
        });
      }
      const json = JSON.parse(text);
      return json.access_token || json.token || '';
    },
  });
}

/**
 * GET against the OneMap REST API with bearer auth (required by /api/public/*).
 * Token expiry and quota failures are normalised into UpstreamError.
 */
export async function oneMapGet(path, params = {}, { authenticated = true, timeoutMs } = {}) {
  const url = buildUrl(config.oneMap.baseUrl, path, params);
  /** @type {Record<string,string>} */
  const headers = { Accept: 'application/json' };
  if (authenticated) {
    const token = await currentToken();
    headers.Authorization = /^Bearer\s/i.test(token) ? token : `Bearer ${token}`;
  }
  try {
    return await requestJson(url, {
      service: 'OneMap',
      headers,
      timeoutMs: timeoutMs ?? config.requestTimeoutMs,
      backoffMs: [1200, 3000],
    });
  } catch (error) {
    throw explainForbidden(error);
  }
}
/** Fuzzy place / address / postal-code lookup used by both search boxes. */
export function searchPlaces(searchValue, pageNum = 1) {
  const term = String(searchValue || '').trim();
  return memoize({
    cache: CACHE.search,
    key: `${term.toLowerCase()}|${pageNum}`,
    ttlMs: config.ttl.placeSearch,
    loader: async () => {
      if (term.length < 2) return { found: 0, results: [] };
      const payload = await oneMapGet('/common/elastic/search', {
        searchVal: term,
        returnGeom: 'Y',
        getAddrDetails: 'Y',
        pageNum,
      });
      const results = (payload?.results || [])
        .map((row) => ({
          name: row.SEARCHVAL,
          address: row.ADDRESS,
          building: row.BUILDING,
          postal: row.POSTAL && row.POSTAL !== 'NIL' ? row.POSTAL : null,
          latitude: Number(row.LATITUDE),
          longitude: Number(row.LONGITUDE),
        }))
        .filter((row) => Number.isFinite(row.latitude) && Number.isFinite(row.longitude));
      return { found: payload?.found ?? results.length, results };
    },
  });
}

/**
 * Resolves an MRT/LRT station code (`NS17`, `EW24/NS1`, ...) to its official
 * name via the OneMap search index. Used for codes that never appear on a
 * planned itinerary, e.g. the crowd-level line panel.
 */
export function resolveStationName(stationCode) {
  const code = String(stationCode).toUpperCase();
  return memoize({
    cache: CACHE.stationName,
    key: code,
    ttlMs: config.ttl.stationName,
    loader: async () => {
      const payload = await searchPlaces(code);
      const pattern = /^(.*?)\s*(?:MRT|LRT)?\s*STATION\s*\(([^)]+)\)$/i;
      for (const result of payload.results || []) {
        const match = pattern.exec(result.name || '');
        if (!match) continue;
        const codes = match[2].split('/').map((part) => part.trim().toUpperCase());
        if (codes.includes(code)) return match[1].trim();
      }
      return null;
    },
  }).catch(() => null);
}

/** Reverse geocode, used by the "use my current location" buttons. */
export function reverseGeocode(latitude, longitude) {
  return memoize({
    cache: CACHE.revgeocode,
    key: `${Number(latitude).toFixed(5)},${Number(longitude).toFixed(5)}`,
    ttlMs: config.ttl.placeSearch,
    loader: async () => {
      const payload = await oneMapGet('/public/revgeocode', {
        location: `${latitude},${longitude}`,
        buffer: 200,
        addressType: 'All',
      });
      const first = payload?.GeocodeInfo?.[0];
      if (!first) return null;
      return {
        name: first.BUILDINGNAME && first.BUILDINGNAME !== 'NIL'
          ? first.BUILDINGNAME
          : first.ROAD || 'Current location',
        address: [first.BLK_NO, first.ROAD, first.POSTALCODE]
          .filter((part) => part && part !== 'NIL')
          .join(' '),
      };
    },
  }).catch(() => null);
}

/* ------------------------------------------------------------------ *
 * Public transport routing (OTP engine behind OneMap)
 * ------------------------------------------------------------------ */

export const ROUTE_MODES = ['TRANSIT', 'BUS', 'RAIL'];

function formatDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${date.getFullYear()}`;
}

function formatTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Journey plans from OneMap.
 *
 * `mode: TRANSIT` returns the best mix of bus + rail, `BUS`/`RAIL` restrict the
 * search to a single mode so the planner can compare modes against each other.
 * OneMap caps `numItineraries` at 3 per request.
 */
export function planJourney({
  start,
  end,
  mode = 'TRANSIT',
  dateTime = new Date(),
  numItineraries = 3,
  maxWalkDistance = 1200,
}) {
  const params = {
    start: `${start.latitude},${start.longitude}`,
    end: `${end.latitude},${end.longitude}`,
    routeType: 'pt',
    mode,
    date: formatDate(dateTime),
    time: formatTime(dateTime),
    maxWalkDistance,
    numItineraries: Math.min(Math.max(numItineraries, 1), 3),
  };
  return memoize({
    cache: CACHE.routes,
    key: JSON.stringify(params),
    ttlMs: config.ttl.route,
    loader: () => oneMapGet('/public/routingsvc/route', params, { timeoutMs: 25000 }),
  });
}

/** Walking route between two points (origin/destination legs on the map). */
export function planWalk({ start, end }) {
  const params = {
    start: `${start.latitude},${start.longitude}`,
    end: `${end.latitude},${end.longitude}`,
    routeType: 'walk',
  };
  return memoize({
    cache: CACHE.routes,
    key: `walk:${JSON.stringify(params)}`,
    ttlMs: config.ttl.route,
    loader: () => oneMapGet('/public/routingsvc/route', params).catch(() => null),
  });
}

export function oneMapCacheStats() {
  return Object.values(CACHE).map((cache) => cache.stats());
}