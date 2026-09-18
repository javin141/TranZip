import { Router } from 'express';
import { DEFAULT_TOLERANCE, planJourneyRoutes } from '../lib/journeyPlanner.js';

export const journeyRouter = Router();

const ROUTE_MODES = ['TRANSIT', 'BUS', 'RAIL'];
const ORIGIN_KEYS = ['origin', 'from', 'start'];
const DESTINATION_KEYS = ['destination', 'dest', 'to', 'end'];

function makePoint(latitude, longitude, name) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return { latitude, longitude, name: name ? String(name) : null };
}

/** Reads `{ latitude, longitude, name }` / `{ lat, lng }` objects. */
export function pointFromObject(value) {
  if (!value || typeof value !== 'object') return null;
  return makePoint(
    Number(value.latitude ?? value.lat),
    Number(value.longitude ?? value.lng ?? value.lon),
    value.name ?? value.label,
  );
}

/**
 * Reads flattened parameters such as `originLat`, `originLng`, `originName`
 * (also accepts `fromLat`/`toLat` and `originLatitude` spellings).
 */
function pointFromFlat(source, keys) {
  for (const key of keys) {
    const stem = key.charAt(0).toUpperCase() + key.slice(1);
    const candidates = [
      [`${key}Lat`, `${key}Lng`],
      [`${key}Latitude`, `${key}Longitude`],
      [`${stem}Lat`, `${stem}Lng`],
      [`${stem}Latitude`, `${stem}Longitude`],
    ];
    for (const [latKey, lngKey] of candidates) {
      if (source[latKey] === undefined) continue;
      const point = makePoint(
        Number(source[latKey]),
        Number(source[lngKey]),
        source[`${key}Name`] ?? source[`${stem}Name`],
      );
      if (point) return point;
    }
  }
  return null;
}

function readDeparture(source) {
  const raw = source.departAt ?? source.departureTime ?? source.time;
  if (!raw) return new Date();
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function readTolerance(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_TOLERANCE;
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_TOLERANCE;
  const fraction = value > 1 ? value / 100 : value;
  return Math.min(Math.max(fraction, 0), 1);
}

function readModes(raw) {
  if (!raw) return ROUTE_MODES;
  const list = Array.isArray(raw) ? raw : String(raw).split(',');
  const modes = list.map((mode) => String(mode).trim().toUpperCase()).filter((mode) => ROUTE_MODES.includes(mode));
  return modes.length > 0 ? modes : ROUTE_MODES;
}

/**
 * Accepts both payload shapes so the endpoint works from the app (JSON body)
 * and from a browser or curl (query string):
 *   { origin: { latitude, longitude, name }, destination: { ... } }
 *   ?originLat=1.35&originLng=103.84&destLat=1.29&destLng=103.85
 */
export function buildPlanInput(source = {}) {
  const origin = pointFromObject(source.origin)
    || pointFromFlat(source, ORIGIN_KEYS);
  const destination = pointFromObject(source.destination)
    || pointFromObject(source.dest)
    || pointFromObject(source.to)
    || pointFromFlat(source, DESTINATION_KEYS);

  if (!origin || !destination) {
    const error = new Error(
      'Origin and destination coordinates are required: send {"origin":{"latitude":..,"longitude":..},'
      + '"destination":{...}} or the query parameters originLat/originLng and destLat/destLng.',
    );
    error.statusCode = 400;
    throw error;
  }

  return {
    origin,
    destination,
    dateTime: readDeparture(source),
    tolerance: readTolerance(source.tolerance ?? source.tolerancePercent),
    modes: readModes(source.modes ?? source.mode),
    maxRoutes: Math.min(Math.max(Number(source.maxRoutes) || 6, 1), 8),
  };
}

/** POST /api/journey/plan - primary planner endpoint used by the web app. */
journeyRouter.post('/plan', async (req, res, next) => {
  try {
    const result = await planJourneyRoutes(buildPlanInput(req.body || {}));
    return res.json(result);
  } catch (error) {
    return next(error);
  }
});

/** GET /api/journey/plan?originLat=..&originLng=..&destLat=..&destLng=.. - shareable/debuggable form. */
journeyRouter.get('/plan', async (req, res, next) => {
  try {
    const result = await planJourneyRoutes(buildPlanInput(req.query || {}));
    return res.json(result);
  } catch (error) {
    return next(error);
  }
});