/**
 * Live rain/heat conditions from NEA via data.gov.sg's real-time API
 * (public, no key required): 5-minute rainfall, per-minute air temperature,
 * and the 2-hour area forecast. Used to bias route ranking toward less time
 * on foot when it's raining or hot (see `journeyPlanner.js`'s `avoidWeather`
 * option) and to show the current conditions in the UI.
 */
import { config } from '../config.js';
import { buildUrl, requestJson } from './http.js';
import { createCache, memoize } from './cache.js';
import { haversineMeters } from './railNetwork.js';
import { weatherOverride } from '../data/test-overrides.js';

const CACHE = {
  rainfall: createCache('weather:rainfall'),
  temperature: createCache('weather:temperature'),
  forecast: createCache('weather:forecast'),
};

let warnedAboutWeatherOverride = false;

/** NEA's 2-hour forecast vocabulary covers these rain-related terms. */
const RAIN_KEYWORDS = /rain|shower|thunder|drizzle/i;

/** Simple "feels hot" reference for Singapore - not a rigorous heat index. */
const HOT_THRESHOLD_C = 32;

/** Rainfall reading above this (mm in the last 5 min) counts as "raining now". */
const RAINING_THRESHOLD_MM = 0.2;

async function weatherGet(path) {
  const url = buildUrl(config.weather.baseUrl, path);
  return requestJson(url, { service: 'data.gov.sg Weather (NEA)', timeoutMs: config.requestTimeoutMs });
}

/** Normalises a `{stations, readings}` station-reading payload's latest snapshot. */
function latestStationReadings(payload) {
  const stations = (payload?.data?.stations || [])
    .map((station) => ({
      id: station.id,
      name: station.name,
      location: {
        latitude: station.location?.latitude,
        longitude: station.location?.longitude,
      },
    }))
    .filter((station) => Number.isFinite(station.location.latitude) && Number.isFinite(station.location.longitude));

  const readingGroups = payload?.data?.readings || [];
  const latest = readingGroups[readingGroups.length - 1] || null;

  return {
    fetchedAt: latest?.timestamp || new Date().toISOString(),
    stations,
    readings: latest?.data || [],
  };
}

/** Reading from the nearest station to `point` (straight-line distance). */
function nearestReading(point, { stations, readings }) {
  let best = null;
  for (const reading of readings) {
    if (typeof reading.value !== 'number') continue;
    const station = stations.find((entry) => entry.id === reading.stationId);
    if (!station) continue;
    const distanceMeters = haversineMeters(point, station.location);
    if (distanceMeters == null) continue;
    if (!best || distanceMeters < best.distanceMeters) {
      best = { value: reading.value, stationName: station.name, distanceMeters: Math.round(distanceMeters) };
    }
  }
  return best;
}

function getRainfall() {
  return memoize({
    cache: CACHE.rainfall,
    key: 'all',
    ttlMs: config.ttl.weather,
    loader: async () => latestStationReadings(await weatherGet('/rainfall')),
  });
}

function getAirTemperature() {
  return memoize({
    cache: CACHE.temperature,
    key: 'all',
    ttlMs: config.ttl.weather,
    loader: async () => latestStationReadings(await weatherGet('/air-temperature')),
  });
}

function getTwoHourForecast() {
  return memoize({
    cache: CACHE.forecast,
    key: 'all',
    ttlMs: config.ttl.weather,
    loader: async () => {
      const payload = await weatherGet('/two-hr-forecast');
      const item = payload?.data?.items?.[0] || null;
      const areas = (payload?.data?.area_metadata || [])
        .map((area) => ({
          name: area.name,
          location: { latitude: area.label_location?.latitude, longitude: area.label_location?.longitude },
        }))
        .filter((area) => Number.isFinite(area.location.latitude) && Number.isFinite(area.location.longitude));
      return {
        fetchedAt: item?.timestamp || new Date().toISOString(),
        validPeriod: item?.valid_period || null,
        areas,
        forecasts: item?.forecasts || [], // [{ area, forecast }]
      };
    },
  });
}

/** Nearest forecast area's text (e.g. "Heavy Thundery Showers") for a point. */
function nearestForecastText(point, forecast) {
  if (!forecast?.areas?.length || !forecast.forecasts?.length) return null;
  let best = null;
  for (const area of forecast.areas) {
    const distanceMeters = haversineMeters(point, area.location);
    if (distanceMeters == null) continue;
    if (!best || distanceMeters < best.distanceMeters) best = { name: area.name, distanceMeters };
  }
  if (!best) return null;
  return forecast.forecasts.find((entry) => entry.area === best.name)?.forecast || null;
}

/**
 * Current rain/heat conditions nearest to a point.
 *
 * @param {{latitude:number, longitude:number}} point
 * @returns {Promise<{
 *   fetchedAt: string,
 *   rainfallMm: number|null,
 *   isRaining: boolean,
 *   forecastText: string|null,
 *   temperatureC: number|null,
 *   isHot: boolean,
 *   condition: 'rain'|'hot'|'clear',
 *   source: string,
 *   simulated?: boolean,
 * }>}
 */
export async function getWeatherNear(point) {
  // DEV/TEST hook - see server/data/test-overrides.js.
  if (weatherOverride?.active) {
    if (!warnedAboutWeatherOverride) {
      warnedAboutWeatherOverride = true;
      console.warn(
        '[weather] TEST OVERRIDE ACTIVE - using the fake condition in server/data/test-overrides.js '
        + 'instead of live NEA data. Set active:false there when done testing.',
      );
    }
    const isRaining = weatherOverride.condition === 'rain';
    const isHot = weatherOverride.condition === 'hot';
    return {
      fetchedAt: new Date().toISOString(),
      rainfallMm: isRaining ? (weatherOverride.rainfallMm ?? 2) : 0,
      isRaining,
      forecastText: weatherOverride.forecastText || null,
      temperatureC: weatherOverride.temperatureC ?? (isHot ? 33 : 27),
      isHot,
      condition: weatherOverride.condition,
      source: 'SIMULATED (server/data/test-overrides.js)',
      simulated: true,
    };
  }

  const [rainfall, temperature, forecast] = await Promise.all([
    getRainfall().catch(() => null),
    getAirTemperature().catch(() => null),
    getTwoHourForecast().catch(() => null),
  ]);

  const rain = rainfall ? nearestReading(point, rainfall) : null;
  const temp = temperature ? nearestReading(point, temperature) : null;
  const forecastText = forecast ? nearestForecastText(point, forecast) : null;

  const rainfallMm = rain?.value ?? null;
  const isRaining = (typeof rainfallMm === 'number' && rainfallMm >= RAINING_THRESHOLD_MM)
    || (forecastText ? RAIN_KEYWORDS.test(forecastText) : false);

  const temperatureC = temp?.value ?? null;
  const isHot = typeof temperatureC === 'number' && temperatureC >= HOT_THRESHOLD_C;

  return {
    fetchedAt: new Date().toISOString(),
    rainfallMm,
    isRaining,
    forecastText,
    temperatureC,
    isHot,
    condition: isRaining ? 'rain' : isHot ? 'hot' : 'clear',
    source: 'NEA via data.gov.sg (rainfall + air-temperature + 2-hour forecast)',
  };
}
