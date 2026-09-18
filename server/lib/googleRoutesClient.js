import { config } from '../config.js';
import { createCache, memoize } from './cache.js';
import { UpstreamError } from './http.js';
import { decodePolyline } from './polyline.js';
import { formatStopName } from './format.js';
import { isStationCode, lineForStationCode, lineMeta, PREFIX_TO_LINE, RAIL_LINES } from './railLines.js';
import { lineStationCodes, loadStationCatalog, stationDetails } from './stationCatalog.js';
import { nearestStations } from './railNetwork.js';
import { servicesAtStop, stopsNear } from './busNetwork.js';

const CACHE = {
  routes: createCache('google:routes'),
};

export const GOOGLE_ROUTE_MODES = ['TRANSIT', 'BUS', 'RAIL'];

/** Returns true if a usable, non-placeholder Google API key is configured. */
export function hasGoogleRoutesKey() {
  const key = config.google.apiKey;
  return Boolean(
    key
    && key !== 'YOUR_API_KEY'
    && key !== 'YOUR_GOOGLE_MAPS_API_KEY',
  );
}

/** Parses Google duration string (e.g. "120s" or "1052.5s") into seconds. */
function parseDurationSeconds(duration) {
  if (typeof duration === 'number') return duration;
  if (typeof duration === 'string') {
    const cleaned = duration.endsWith('s') ? duration.slice(0, -1) : duration;
    const parsed = parseFloat(cleaned);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/** Maps a line name, short name, or color to Singapore rail line code. */
function matchRailLine({ name, nameShort, color }) {
  const normName = String(name || '').toUpperCase();
  const normShort = String(nameShort || '').toUpperCase();

  // Direct short code match (e.g. "NSL", "EWL", "DTL", "CCL", "NEL", "TEL")
  if (RAIL_LINES[normShort]) return normShort;
  if (PREFIX_TO_LINE[normShort]) return PREFIX_TO_LINE[normShort];

  // Match by known line names
  if (normName.includes('NORTH SOUTH') || normName.includes('NORTH-SOUTH')) return 'NSL';
  if (normName.includes('EAST WEST') || normName.includes('EAST-WEST')) return 'EWL';
  if (normName.includes('CHANGI')) return 'CGL';
  if (normName.includes('NORTH EAST') || normName.includes('NORTH-EAST')) return 'NEL';
  if (normName.includes('CIRCLE')) return 'CCL';
  if (normName.includes('MARINA BAY BRANCH')) return 'CEL';
  if (normName.includes('DOWNTOWN')) return 'DTL';
  if (normName.includes('THOMSON') || normName.includes('EAST COAST') || normName.includes('EAST-COAST')) return 'TEL';
  if (normName.includes('BUKIT PANJANG')) return 'BPL';
  if (normName.includes('SENGKANG')) return 'SLRT';
  if (normName.includes('PUNGGOL')) return 'PLRT';
  if (normName.includes('JURONG REGION')) return 'JRL';

  // Fallback by line color if provided
  if (color) {
    const hex = String(color).toLowerCase();
    for (const [code, meta] of Object.entries(RAIL_LINES)) {
      if (meta.colour && meta.colour.toLowerCase() === hex) return code;
    }
  }

  return null;
}

/** Resolves an MRT station code and line from Google stop details. */
async function resolveRailStation(stopDetails, preferredLine = null) {
  if (!stopDetails) return { code: null, name: null, line: preferredLine };
  const rawName = stopDetails.name || '';
  const lat = stopDetails.location?.latLng?.latitude;
  const lon = stopDetails.location?.latLng?.longitude;

  // 1. Check if station code is embedded in name (e.g. "Bishan (NS17/CC15)" or "NS17")
  const codeMatches = rawName.match(/\b([A-Z]{2}\d+)\b/g);
  if (codeMatches?.length) {
    if (preferredLine) {
      const match = codeMatches.find((code) => lineForStationCode(code) === preferredLine);
      if (match) {
        return {
          code: match,
          name: formatStopName(rawName.replace(/\s*\([^)]+\)/g, '')),
          line: preferredLine,
        };
      }
    }
    const valid = codeMatches.find((code) => isStationCode(code));
    if (valid) {
      return {
        code: valid,
        name: formatStopName(rawName.replace(/\s*\([^)]+\)/g, '')),
        line: lineForStationCode(valid),
      };
    }
  }

  // 2. Match by station name in catalog
  const catalog = await loadStationCatalog();
  const cleanedName = rawName
    .replace(/\s*(?:MRT|LRT)?\s*(?:STATION|STN)\b/gi, '')
    .replace(/\s*\([^)]*\)/g, '')
    .trim()
    .toUpperCase();

  let matchedStation = null;
  for (const station of Object.values(catalog.byCode || {})) {
    if (station.name && station.name.toUpperCase() === cleanedName) {
      matchedStation = station;
      break;
    }
  }

  // 3. Match by nearest station coordinates if location is present
  if (!matchedStation && Number.isFinite(lat) && Number.isFinite(lon)) {
    const nearby = await nearestStations({ latitude: lat, longitude: lon }, { maxMeters: 450, limit: 1 });
    if (nearby.length > 0) {
      matchedStation = catalog.byCode[nearby[0].code] || nearby[0];
    }
  }

  if (matchedStation) {
    const codes = matchedStation.codes || [matchedStation.code];
    let chosenCode = codes[0];
    if (preferredLine) {
      const onLine = codes.find((code) => lineForStationCode(code) === preferredLine);
      if (onLine) chosenCode = onLine;
    }
    return {
      code: chosenCode,
      name: formatStopName(matchedStation.name || rawName),
      line: lineForStationCode(chosenCode) || preferredLine,
    };
  }

  return {
    code: null,
    name: formatStopName(rawName) || 'MRT Station',
    line: preferredLine,
  };
}

/** Resolves a 5-digit LTA bus stop code from Google stop details. */
async function resolveBusStop(stopDetails, serviceNo = null) {
  if (!stopDetails) return { code: null, name: null };
  const rawName = stopDetails.name || '';
  const lat = stopDetails.location?.latLng?.latitude;
  const lon = stopDetails.location?.latLng?.longitude;

  // 1. Check if 5-digit bus stop code is in the name, e.g. "Opp Bishan Stn (53239)"
  const codeMatch = rawName.match(/\b(\d{5})\b/);
  if (codeMatch) {
    return {
      code: codeMatch[1],
      name: formatStopName(rawName.replace(/\s*\(\d{5}\)/g, '')),
    };
  }

  // 2. Find nearby bus stops by coordinates
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    try {
      const nearby = await stopsNear({ latitude: lat, longitude: lon }, { radiusMeters: 250, limit: 6 });
      if (nearby.length > 0) {
        if (serviceNo) {
          const normService = String(serviceNo).trim().toUpperCase();
          for (const item of nearby) {
            const services = await servicesAtStop(item.stop.code);
            const servesLine = services.some((s) => String(s.serviceNo).toUpperCase() === normService);
            if (servesLine) {
              return {
                code: item.stop.code,
                name: formatStopName(item.stop.name || rawName),
              };
            }
          }
        }
        return {
          code: nearby[0].stop.code,
          name: formatStopName(nearby[0].stop.name || rawName),
        };
      }
    } catch {
      // Fall through to raw name if bus network index lookup fails
    }
  }

  return {
    code: null,
    name: formatStopName(rawName) || 'Bus Stop',
  };
}

/** Interpolates intermediate MRT stations between departure and arrival stations on a line. */
async function interpolateIntermediateRailStations(fromCode, toCode, lineCode) {
  if (!fromCode || !toCode || !lineCode) return [];
  const lineStations = await lineStationCodes(lineCode);
  if (!lineStations?.length) return [];

  const fromIdx = lineStations.indexOf(fromCode);
  const toIdx = lineStations.indexOf(toCode);
  if (fromIdx === -1 || toIdx === -1 || Math.abs(toIdx - fromIdx) <= 1) return [];

  const slice = fromIdx < toIdx
    ? lineStations.slice(fromIdx + 1, toIdx)
    : lineStations.slice(toIdx + 1, fromIdx).reverse();

  const stops = [];
  for (const code of slice) {
    const details = await stationDetails(code);
    stops.push({
      code,
      name: details?.name || code,
      latitude: details?.latitude ?? null,
      longitude: details?.longitude ?? null,
      time: null,
    });
  }
  return stops;
}

/** Normalises a Google Directions v2 computeRoutes step into TranZip leg shape. */
async function normalizeGoogleStep(step, legIndex, routeIndex) {
  const travelMode = String(step.travelMode || '').toUpperCase();
  const transitDetails = step.transitDetails;

  const durationSec = parseDurationSeconds(step.staticDuration || step.duration);
  const durationMinutes = Math.max(1, Math.round(durationSec / 60));
  const distanceMeters = Math.round(step.distanceMeters || 0);
  const geometry = decodePolyline(step.polyline?.encodedPolyline);

  if (travelMode === 'TRANSIT' && transitDetails) {
    const vehicleType = String(transitDetails.transitLine?.vehicle?.type || '').toUpperCase();
    const lineName = transitDetails.transitLine?.name || '';
    const lineShort = transitDetails.transitLine?.nameShort || '';
    const lineColor = transitDetails.transitLine?.color || null;

    const isBus = vehicleType === 'BUS'
      || (!vehicleType.includes('SUBWAY') && !vehicleType.includes('RAIL') && !vehicleType.includes('TRAIN')
          && /^\d+[A-Za-z]?$/.test(lineShort));

    if (isBus) {
      const serviceNo = lineShort || lineName.replace(/^Bus\s+/i, '') || transitDetails.headsign || '';
      const [fromResolved, toResolved] = await Promise.all([
        resolveBusStop(transitDetails.stopDetails?.departureStop, serviceNo),
        resolveBusStop(transitDetails.stopDetails?.arrivalStop, serviceNo),
      ]);

      const depStop = transitDetails.stopDetails?.departureStop;
      const arrStop = transitDetails.stopDetails?.arrivalStop;

      return {
        id: `${routeIndex}-${legIndex}`,
        type: 'bus',
        mode: 'BUS',
        routeLabel: serviceNo,
        serviceNo,
        line: null,
        lineName: null,
        from: {
          name: fromResolved.name || depStop?.name || 'Bus stop',
          rawName: depStop?.name || '',
          code: fromResolved.code,
          latitude: depStop?.location?.latLng?.latitude ?? null,
          longitude: depStop?.location?.latLng?.longitude ?? null,
          time: transitDetails.stopDetails?.departureTime || null,
        },
        to: {
          name: toResolved.name || arrStop?.name || 'Bus stop',
          rawName: arrStop?.name || '',
          code: toResolved.code,
          latitude: arrStop?.location?.latLng?.latitude ?? null,
          longitude: arrStop?.location?.latLng?.longitude ?? null,
          time: transitDetails.stopDetails?.arrivalTime || null,
        },
        departure: transitDetails.stopDetails?.departureTime || null,
        arrival: transitDetails.stopDetails?.arrivalTime || null,
        durationMinutes,
        distanceMeters,
        intermediateStops: [],
        geometry,
        numStops: transitDetails.stopCount || 1,
        load: null,
      };
    }

    // Otherwise Rail (MRT / LRT / SUBWAY / TRAIN)
    const line = matchRailLine({ name: lineName, nameShort: lineShort, color: lineColor });
    const depStop = transitDetails.stopDetails?.departureStop;
    const arrStop = transitDetails.stopDetails?.arrivalStop;

    const [fromResolved, toResolved] = await Promise.all([
      resolveRailStation(depStop, line),
      resolveRailStation(arrStop, line),
    ]);

    const resolvedLine = line || fromResolved.line || toResolved.line || null;
    const intermediateStops = await interpolateIntermediateRailStations(
      fromResolved.code,
      toResolved.code,
      resolvedLine,
    );

    return {
      id: `${routeIndex}-${legIndex}`,
      type: 'mrt',
      mode: 'SUBWAY',
      routeLabel: lineShort || lineMeta(resolvedLine)?.short || lineName || 'MRT',
      serviceNo: null,
      line: resolvedLine,
      lineName: resolvedLine ? lineMeta(resolvedLine)?.name : lineName || 'MRT',
      from: {
        name: fromResolved.name || depStop?.name || 'MRT Station',
        rawName: depStop?.name || '',
        code: fromResolved.code,
        latitude: depStop?.location?.latLng?.latitude ?? null,
        longitude: depStop?.location?.latLng?.longitude ?? null,
        time: transitDetails.stopDetails?.departureTime || null,
      },
      to: {
        name: toResolved.name || arrStop?.name || 'MRT Station',
        rawName: arrStop?.name || '',
        code: toResolved.code,
        latitude: arrStop?.location?.latLng?.latitude ?? null,
        longitude: arrStop?.location?.latLng?.longitude ?? null,
        time: transitDetails.stopDetails?.arrivalTime || null,
      },
      departure: transitDetails.stopDetails?.departureTime || null,
      arrival: transitDetails.stopDetails?.arrivalTime || null,
      durationMinutes,
      distanceMeters,
      intermediateStops,
      geometry,
      numStops: intermediateStops.length + 1,
      load: null,
    };
  }

  // Walking or other step
  const startLoc = step.startLocation?.latLng;
  const endLoc = step.endLocation?.latLng;
  const instructions = step.navigationInstruction?.instructions || 'Walk';

  return {
    id: `${routeIndex}-${legIndex}`,
    type: travelMode === 'WALK' ? 'walk' : 'other',
    mode: travelMode,
    routeLabel: instructions,
    serviceNo: null,
    line: null,
    lineName: null,
    from: {
      name: instructions,
      rawName: instructions,
      code: null,
      latitude: startLoc?.latitude ?? null,
      longitude: startLoc?.longitude ?? null,
      time: null,
    },
    to: {
      name: instructions,
      rawName: instructions,
      code: null,
      latitude: endLoc?.latitude ?? null,
      longitude: endLoc?.longitude ?? null,
      time: null,
    },
    departure: null,
    arrival: null,
    durationMinutes,
    distanceMeters,
    intermediateStops: [],
    geometry,
    numStops: 0,
    load: null,
  };
}

function modeMixLabel(types) {
  const hasRail = types.includes('mrt');
  const hasBus = types.includes('bus');
  if (hasRail && hasBus) return 'Bus + MRT';
  if (hasRail) return 'MRT / LRT';
  if (hasBus) return 'Bus';
  return 'Walking';
}

function itinerarySignature(legs) {
  return (legs || [])
    .filter((leg) => leg.type !== 'walk')
    .map((leg) => `${leg.type}:${leg.serviceNo || leg.line || leg.routeLabel || ''}:${leg.from?.code || leg.from?.name || ''}->${leg.to?.code || leg.to?.name || ''}`)
    .join('|') || 'walk-only';
}

function uniqueRouteCodes(legs) {
  const labels = legs
    .filter((leg) => leg.type === 'bus' || leg.type === 'mrt')
    .map((leg) => leg.routeLabel);
  return [...new Set(labels)];
}

/** Summarises a single raw route from Google Routes API into TranZip route shape. */
export async function summarizeGoogleRoute(googleRoute, index, { origin, destination } = {}) {
  const googleLegs = googleRoute.legs || [];
  const rawSteps = googleLegs.flatMap((leg) => leg.steps || []);

  const legs = [];
  for (let i = 0; i < rawSteps.length; i += 1) {
    const leg = await normalizeGoogleStep(rawSteps[i], i, index);
    legs.push(leg);
  }

  const transitLegs = legs.filter((leg) => leg.type === 'bus' || leg.type === 'mrt');
  const walkMinutes = legs.filter((leg) => leg.type === 'walk').reduce((sum, leg) => sum + leg.durationMinutes, 0);
  const transitMinutes = transitLegs.reduce((sum, leg) => sum + leg.durationMinutes, 0);

  const totalDurationSec = parseDurationSeconds(googleRoute.duration || googleLegs[0]?.duration);
  const totalMinutes = totalDurationSec > 0
    ? Math.max(1, Math.round(totalDurationSec / 60))
    : Math.max(1, walkMinutes + transitMinutes);

  const waitingMinutes = Math.max(0, totalMinutes - walkMinutes - transitMinutes);
  const walkMeters = legs.filter((leg) => leg.type === 'walk').reduce((sum, leg) => sum + leg.distanceMeters, 0);

  const firstLegWithTime = legs.find((leg) => leg.departure);
  const lastLegWithTime = [...legs].reverse().find((leg) => leg.arrival);

  const signature = itinerarySignature(legs);

  return {
    id: `route-${index}-${signature.slice(0, 40)}`,
    signature,
    ordinal: index + 1,
    type: modeMixLabel(transitLegs.map((leg) => leg.type)),
    modeChain: transitLegs.map((leg) => (leg.type === 'mrt' ? 'mrt' : 'bus')),
    routeCodes: uniqueRouteCodes(legs),
    legs,
    startTime: firstLegWithTime?.departure || null,
    endTime: lastLegWithTime?.arrival || null,
    durationMinutes: totalMinutes,
    walkMinutes,
    transitMinutes,
    waitingMinutes,
    transfers: Math.max(0, transitLegs.length - 1),
    fare: null,
    walkMeters,
    originLabel: origin?.name || null,
    destinationLabel: destination?.name || null,
    load: null,
    recommended: false,
    source: 'google',
    planner: 'Google Maps Transit Route API',
  };
}

/**
 * Builds waypoint representation for Google computeRoutes.
 */
function buildWaypoint(point) {
  if (Number.isFinite(point?.latitude) && Number.isFinite(point?.longitude)) {
    return {
      location: {
        latLng: {
          latitude: Number(point.latitude),
          longitude: Number(point.longitude),
        },
      },
    };
  }
  if (point?.address || point?.name) {
    return {
      address: point.address || point.name,
    };
  }
  throw new Error('Invalid waypoint: coordinates or address required.');
}

/**
 * Calls Google Directions v2 computeRoutes to get transit routes.
 *
 * @param {object} options
 * @param {{latitude:number,longitude:number,name?:string,address?:string}} options.origin
 * @param {{latitude:number,longitude:number,name?:string,address?:string}} options.destination
 * @param {Date} [options.dateTime]
 * @param {string[]} [options.modes] ['TRANSIT', 'BUS', 'RAIL']
 * @param {string} [options.routingPreference] 'LESS_WALKING' | 'FEWER_TRANSFERS'
 */
export async function computeGoogleTransitRoutes({
  origin,
  destination,
  dateTime = new Date(),
  modes = ['TRANSIT'],
  routingPreference = 'LESS_WALKING',
}) {
  if (!hasGoogleRoutesKey()) {
    throw new UpstreamError(
      'Google Maps API key is not configured. Please set GOOGLE_MAPS_API_KEY in .env.',
      { service: 'Google Routes', kind: 'not_configured' },
    );
  }

  const queryModes = (modes || []).map((m) => String(m).toUpperCase());
  let allowedTravelModes = undefined;
  if (queryModes.includes('BUS') && !queryModes.includes('RAIL') && !queryModes.includes('TRANSIT')) {
    allowedTravelModes = ['BUS'];
  } else if (queryModes.includes('RAIL') && !queryModes.includes('BUS') && !queryModes.includes('TRANSIT')) {
    allowedTravelModes = ['TRAIN', 'SUBWAY', 'LIGHT_RAIL', 'RAIL'];
  }

  const body = {
    origin: buildWaypoint(origin),
    destination: buildWaypoint(destination),
    travelMode: 'TRANSIT',
    computeAlternativeRoutes: true,
    transitPreferences: {
      routingPreference,
      ...(allowedTravelModes ? { allowedTravelModes } : {}),
    },
  };

  // Only include departureTime if it is in the future (> 60s from now)
  const nowMs = Date.now();
  if (dateTime && dateTime.getTime() - nowMs > 60_000) {
    body.departureTime = dateTime.toISOString();
  }

  const cacheKey = JSON.stringify(body);

  const rawData = await memoize({
    cache: CACHE.routes,
    key: cacheKey,
    ttlMs: config.ttl.route,
    loader: async () => {
      const url = `${config.google.baseUrl}/directions/v2:computeRoutes`;
      const fieldMask = [
        'routes.duration',
        'routes.distanceMeters',
        'routes.polyline.encodedPolyline',
        'routes.description',
        'routes.legs.duration',
        'routes.legs.distanceMeters',
        'routes.legs.polyline.encodedPolyline',
        'routes.legs.steps.distanceMeters',
        'routes.legs.steps.staticDuration',
        'routes.legs.steps.polyline.encodedPolyline',
        'routes.legs.steps.startLocation',
        'routes.legs.steps.endLocation',
        'routes.legs.steps.travelMode',
        'routes.legs.steps.navigationInstruction',
        'routes.legs.steps.transitDetails',
      ].join(',');

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': config.google.apiKey,
          'X-Goog-FieldMask': fieldMask,
        },
        body: JSON.stringify(body),
      });

      const text = await res.text();
      let json = {};
      try {
        json = JSON.parse(text);
      } catch {
        // Non-JSON response
      }

      if (!res.ok) {
        const errorMsg = json.error?.message || `Google Routes API request failed (${res.status})`;
        throw new UpstreamError(errorMsg, {
          service: 'Google Routes',
          status: res.status,
          url,
          body: text,
          kind: res.status === 403 ? 'forbidden' : 'error',
        });
      }

      return json;
    },
  });

  const routes = [];
  const rawRoutes = rawData.routes || [];
  for (let i = 0; i < rawRoutes.length; i += 1) {
    const route = await summarizeGoogleRoute(rawRoutes[i], i, { origin, destination });
    routes.push(route);
  }

  return routes;
}

