/**
 * Journey planner: turns raw OneMap/OTP itineraries plus live LTA load data
 * into ranked, comparable routes and picks the recommended one.
 *
 * Two routing sources are supported:
 *   1. OneMap's public transport routing service (preferred, when the token is
 *      provisioned for `/api/public/routingsvc/route`).
 *   2. A LTA DataMall-native planner (`localPlanner.js`) that builds journeys
 *      from `/BusRoutes` + the rail topology when OneMap routing is refused.
 *
 * Both sources produce the same route shape, so load enrichment and the
 * recommendation rule below apply identically.
 *
 * Recommendation rule (as specified):
 *   Of all routes whose travel time is within `tolerance` (default 10%) of the
 *   fastest route, recommend the one with the lowest passenger load.
 */

import { getBusArrival, getBusServiceInfo, getCrowdRealTime, getCrowdForecast, getBusStop } from './ltaClient.js';
import { computeGoogleTransitRoutes, hasGoogleRoutesKey, GOOGLE_ROUTE_MODES } from './googleRoutesClient.js';
import { UpstreamError } from './http.js';
import { decodePolyline } from './polyline.js';
import {
  LOAD_BANDS,
  averageScore,
  bandFromBusLoad,
  bandFromCrowdLevel,
  busTypeInfo,
  isLiveWindow,
  journeyLoadScore,
  scoreToBand,
} from './loadModel.js';
import { isStationCode, lineForStationCode, lineMeta } from './railLines.js';
import { knownStationName, stationDetails } from './stationCatalog.js';
import { formatStopName, stationLabel } from './format.js';

export const DEFAULT_TOLERANCE = 0.1;
export const ROUTE_MODES = GOOGLE_ROUTE_MODES;

/** Classifies a OneMap leg into the vocabulary the UI and load model understand. */
export function legType(leg) {
  const mode = String(leg?.mode || '').toUpperCase();
  const fromCode = leg?.from?.stopCode;
  if (isStationCode(fromCode) || isStationCode(leg?.to?.stopCode)) return 'mrt';
  if (mode === 'BUS' || mode === 'COACH') return 'bus';
  if (mode === 'SUBWAY' || mode === 'RAIL' || mode === 'TRAM') return 'mrt';
  if (mode === 'WALK') return 'walk';
  return 'other';
}

function toPoint(stop) {
  if (!stop) return null;
  return {
    name: formatStopName(stop.name),
    rawName: stop.name || '',
    code: stop.stopCode || null,
    latitude: typeof stop.lat === 'number' ? stop.lat : null,
    longitude: typeof stop.lon === 'number' ? stop.lon : null,
    time: stop.departure || stop.arrival || null,
  };
}

/** Stable signature so identical itineraries from different mode queries collapse. */
function itinerarySignature(itinerary) {
  return (itinerary.legs || [])
    .filter((leg) => legType(leg) !== 'walk')
    .map((leg) => `${legType(leg)}:${leg.route || ''}:${leg.from?.stopCode || leg.from?.name || ''}->${leg.to?.stopCode || leg.to?.name || ''}`)
    .join('|') || 'walk-only';
}

function modeMixLabel(types) {
  const hasRail = types.includes('mrt');
  const hasBus = types.includes('bus');
  if (hasRail && hasBus) return 'Bus + MRT';
  if (hasRail) return 'MRT / LRT';
  if (hasBus) return 'Bus';
  return 'Walking';
}

function uniqueRouteCodes(legs) {
  const labels = legs
    .filter((leg) => leg.type === 'bus' || leg.type === 'mrt')
    .map((leg) => leg.routeLabel);
  return [...new Set(labels)];
}

/** Normalises one OneMap itinerary into the app's route shape (load data added later). */
export function summarizeItinerary(itinerary, index, { origin, destination } = {}) {
  const rawLegs = itinerary.legs || [];
  const legs = rawLegs.map((leg, legIndex) => {
    const type = legType(leg);
    const geometry = decodePolyline(leg.legGeometry?.points);
    const line = type === 'mrt' ? lineForStationCode(leg.from?.stopCode) : null;
    return {
      id: `${index}-${legIndex}`,
      type,
      mode: String(leg.mode || '').toUpperCase(),
      routeLabel: formatStopName(leg.routeLongName || leg.route || '') || String(leg.route || ''),
      serviceNo: type === 'bus' ? String(leg.route || '') : null,
      line,
      lineName: line ? lineMeta(line)?.name || null : null,
      from: toPoint(leg.from),
      to: toPoint(leg.to),
      departure: leg.from?.departure || null,
      arrival: leg.to?.arrival || null,
      durationMinutes: Math.max(1, Math.round((leg.duration || 0) / 60)),
      distanceMeters: Math.round(leg.distance || 0),
      intermediateStops: (leg.intermediateStops || []).map((stop) => ({
        ...toPoint(stop),
        name: formatStopName(stop.name),
      })),
      geometry,
      numStops: (leg.intermediateStops || []).length + (type === 'walk' ? 0 : 1),
      load: null,
    };
  });

  const transitLegs = legs.filter((leg) => leg.type === 'bus' || leg.type === 'mrt');
  const walkMinutes = legs.filter((leg) => leg.type === 'walk').reduce((sum, leg) => sum + leg.durationMinutes, 0);
  const transitMinutes = transitLegs.reduce((sum, leg) => sum + leg.durationMinutes, 0);
  const totalMinutes = Math.max(1, Math.round((itinerary.duration || 0) / 60));
  const waitingMinutes = Math.max(0, totalMinutes - walkMinutes - transitMinutes);

  return {
    id: `route-${index}-${itinerarySignature(itinerary).slice(0, 40)}`,
    signature: itinerarySignature(itinerary),
    ordinal: index + 1,
    type: modeMixLabel(transitLegs.map((leg) => leg.type)),
    modeChain: transitLegs.map((leg) => (leg.type === 'mrt' ? 'mrt' : 'bus')),
    routeCodes: uniqueRouteCodes(legs),
    legs,
    startTime: itinerary.startTime ? new Date(itinerary.startTime).toISOString() : null,
    endTime: itinerary.endTime ? new Date(itinerary.endTime).toISOString() : null,
    durationMinutes: totalMinutes,
    walkMinutes,
    transitMinutes,
    waitingMinutes,
    transfers: Math.max(0, transitLegs.length - 1),
    fare: typeof itinerary.fare === 'number' ? itinerary.fare : null,
    walkMeters: Math.round(itinerary.walkDistance || 0),
    originLabel: origin?.name || null,
    destinationLabel: destination?.name || null,
    load: null,
    recommended: false,
  };
}
/* ------------------------------------------------------------------ *
 * Live load enrichment
 * ------------------------------------------------------------------ */

const minutesUntil = (iso, nowMs) => {
  const time = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(time)) return null;
  return Math.max(0, Math.round((time - nowMs) / 60000));
};

function arrivalSlots(service, nowMs) {
  return ['NextBus', 'NextBus2', 'NextBus3']
    .map((slot) => service?.[slot])
    .filter((entry) => entry && entry.EstimatedArrival)
    .map((entry) => ({
      estimatedArrival: entry.EstimatedArrival,
      minutesUntil: minutesUntil(entry.EstimatedArrival, nowMs),
      arrivalMs: Date.parse(entry.EstimatedArrival),
      load: String(entry.Load || '').toUpperCase(),
      monitored: Number(entry.Monitored) === 1,
      visitNumber: entry.VisitNumber || null,
      originCode: entry.OriginCode || null,
      destinationCode: entry.DestinationCode || null,
      busType: entry.Type || null,
      feature: entry.Feature || null,
    }));
}

/**
 * Resolves the bus a passenger would actually board at this leg's stop, plus
 * the passenger-load band LTA reports for it.
 */
async function enrichBusLeg(leg, context) {
  const { nowMs } = context;
  const stopCode = leg.from?.code;
  const boardingTime = leg.departure ? Date.parse(leg.departure) : context.departureMs;

  let arrival = null;
  let arrivalError = null;
  if (stopCode) {
    try {
      arrival = await getBusArrival(stopCode);
    } catch (error) {
      arrivalError = error.message;
    }
  }

  const matchingServices = (arrival?.services || []).filter(
    (service) => String(service.ServiceNo).toUpperCase() === String(leg.serviceNo).toUpperCase(),
  );

  const slots = matchingServices.flatMap((service) => arrivalSlots(service, nowMs));
  const chosen = slots.find((slot) => Number.isFinite(slot.arrivalMs) && slot.arrivalMs >= boardingTime - 60000)
    || slots[0]
    || null;

  const [serviceInfo, destinationStop] = await Promise.all([
    context.includeServiceInfo && leg.serviceNo
      ? getBusServiceInfo(leg.serviceNo, leg.to?.code).catch(() => null)
      : Promise.resolve(null),
    leg.to?.code && context.includeServiceInfo
      ? getBusStop(leg.to.code).catch(() => null)
      : Promise.resolve(null),
  ]);

  const band = chosen ? bandFromBusLoad(chosen.load) : LOAD_BANDS.unknown;
  const typeInfo = chosen ? busTypeInfo(chosen.busType) : null;

  leg.load = {
    kind: 'bus',
    available: Boolean(chosen && chosen.monitored),
    band,
    score: band.score,
    boardingStop: leg.from,
    boarding: chosen
      ? {
        minutesUntil: chosen.minutesUntil,
        estimatedArrival: chosen.estimatedArrival,
        monitored: chosen.monitored,
        busType: chosen.busType,
        busTypeLabel: typeInfo?.label || null,
        approximateCapacity: typeInfo?.capacity || null,
        visitNumber: chosen.visitNumber,
        destinationCode: chosen.destinationCode,
        originCode: chosen.originCode,
      }
      : null,
    upcoming: slots.slice(0, 3).map((slot) => ({
      minutesUntil: slot.minutesUntil,
      estimatedArrival: slot.estimatedArrival,
      monitored: slot.monitored,
      busType: slot.busType,
      band: bandFromBusLoad(slot.load),
    })),
    service: serviceInfo
      ? {
        operator: serviceInfo.operator,
        category: serviceInfo.category,
        loopDescription: serviceInfo.loopDescription,
        frequency: serviceInfo.frequency,
        destinationCode: serviceInfo.destinationCode,
        originCode: serviceInfo.originCode,
        towards: destinationStop
          ? { code: destinationStop.code, name: destinationStop.name, road: destinationStop.road }
          : null,
      }
      : null,
    source: 'LTA DataMall /v3/BusArrival · Load',
    note: chosen
      ? (chosen.monitored
        ? `Live load reported for service ${leg.serviceNo} at ${leg.from?.name}.`
        : `LTA is not tracking service ${leg.serviceNo} in real time, so load is unavailable.`)
      : `No load reported for service ${leg.serviceNo} at ${leg.from?.name}.`,
    error: arrivalError,
  };

  return leg.load;
}

/** Picks the crowd level that applies when the passenger reaches a station. */
function crowdLevelAt(code, expectedMs, { realtime, forecast, nowMs, useForecast }) {
  const target = Number.isFinite(expectedMs) ? expectedMs : nowMs;
  const minutesAhead = (target - nowMs) / 60000;

  if (useForecast && minutesAhead > 15 && forecast) {
    const station = forecast.stations.find((entry) => entry.code === code);
    if (station?.intervals?.length) {
      let match = null;
      for (const interval of station.intervals) {
        const start = Date.parse(interval.start);
        if (Number.isFinite(start) && start <= target) match = interval;
        else break;
      }
      if (match) return { level: match.crowdLevel, source: 'forecast', intervalStart: match.start };
    }
  }

  const realtimeStation = realtime?.stations.find((entry) => entry.code === code);
  if (realtimeStation) return { level: realtimeStation.crowdLevel, source: 'realtime' };
  return { level: null, source: 'unknown' };
}

/**
 * Estimates the load of an MRT/LRT leg from the crowd level at every station
 * along the route between the boarding and alighting station.
 */
async function enrichRailLeg(leg, context) {
  const line = leg.line || lineForStationCode(leg.from?.code);
  const stationStops = [leg.from, ...leg.intermediateStops, leg.to].filter(Boolean);

  const [realtime, forecast] = await Promise.all([
    line ? getCrowdRealTime(line).catch(() => null) : Promise.resolve(null),
    line && context.useForecast ? getCrowdForecast(line).catch(() => null) : Promise.resolve(null),
  ]);

  const stations = [];
  for (let index = 0; index < stationStops.length; index += 1) {
    const stop = stationStops[index];
    const expectedMs = stop.time ? Date.parse(stop.time) : context.departureMs;
    const resolved = crowdLevelAt(stop.code, expectedMs, {
      realtime, forecast, nowMs: context.nowMs, useForecast: context.useForecast,
    });
    const details = context.includeStationInfo ? await stationDetails(stop.code) : null;
    const name = stop.name || (details && details.name) || stop.code;
    stations.push({
      code: stop.code,
      name,
      band: bandFromCrowdLevel(resolved.level),
      crowdLevel: resolved.level,
      bandSource: resolved.source,
      expectedTime: Number.isFinite(expectedMs) ? new Date(expectedMs).toISOString() : null,
      isStart: index === 0,
      isEnd: index === stationStops.length - 1,
      isInterchange: Boolean(details && details.codes.length > 1),
      interchangeWith: details && details.codes.length > 1 ? details.codes.filter((code) => code !== stop.code) : [],
      interchangeLines: details?.lines || [],
    });
  }

  const average = averageScore(stations.map((station) => station.band.score));
  const peak = stations.reduce((worst, station) => {
    if (!worst) return station;
    return (station.band.score ?? -1) > (worst.band.score ?? -1) ? station : worst;
  }, null);

  leg.load = {
    kind: 'mrt',
    available: stations.some((station) => Boolean(station.crowdLevel)),
    band: scoreToBand(average),
    score: average,
    line,
    lineName: lineMeta(line)?.name || null,
    lineColour: lineMeta(line)?.colour || null,
    stations,
    boardingStation: stations[0] || null,
    alightingStation: stations[stations.length - 1] || null,
    peakStation: peak && peak.crowdLevel ? peak : null,
    source: forecast
      ? 'LTA DataMall /PCDRealTime + /PCDForecast'
      : 'LTA DataMall /PCDRealTime',
    note: `Estimated from platform crowd levels at ${stations.length} station${stations.length === 1 ? '' : 's'} between ${stations[0]?.name || 'boarding'} and ${stations[stations.length - 1]?.name || 'alighting'}.`,
  };

  return leg.load;
}

/** Enriches every in-vehicle leg with LTA load data (never throws). */
export async function enrichRoute(route, context) {
  const inVehicle = route.legs.filter((leg) => leg.type === 'bus' || leg.type === 'mrt');
  await Promise.all(inVehicle.map((leg) => (
    leg.type === 'bus'
      ? enrichBusLeg(leg, context)
      : enrichRailLeg(leg, context)
  ).catch(() => null)));

  const samples = inVehicle
    .filter((leg) => leg.load)
    .map((leg) => ({ score: leg.load.score, weightMinutes: leg.durationMinutes }));

  const score = journeyLoadScore(samples);
  const knownLegs = inVehicle.filter((leg) => typeof leg.load?.score === 'number');
  const worstLeg = knownLegs.reduce((worst, leg) => {
    if (!worst) return leg;
    return (leg.load.score ?? -1) > (worst.load.score ?? -1) ? leg : worst;
  }, null);

  route.load = {
    score,
    band: scoreToBand(score),
    legsWithData: knownLegs.length,
    legsWithoutData: inVehicle.length - knownLegs.length,
    worstLeg: worstLeg
      ? {
        type: worstLeg.type,
        label: worstLeg.type === 'bus'
          ? `Bus ${worstLeg.serviceNo} from ${worstLeg.from?.name}`
          : `${lineMeta(worstLeg.line)?.short || worstLeg.line} from ${worstLeg.from?.name} to ${worstLeg.to?.name}`,
        band: worstLeg.load.band,
      }
      : null,
    summary: knownLegs.length === 0
      ? 'No live load data available for this route right now.'
      : inVehicle.length === 1
        ? `${worstLeg?.load?.band?.label || 'Unknown'} on ${worstLeg?.type === 'bus' ? `bus ${worstLeg.serviceNo}` : `${lineMeta(worstLeg?.line)?.short || ''} rail`}.`
        : `Overall ${scoreToBand(score).label.toLowerCase()} across ${knownLegs.length} vehicle${knownLegs.length === 1 ? '' : 's'}.`,
  };

  return route;
}

/* ------------------------------------------------------------------ *
 * Ranking & recommendation
 * ------------------------------------------------------------------ */

/**
 * Applies the recommendation rule:
 *   1. Find the fastest route.
 *   2. Consider every route within `tolerance` (default 10%) of that time.
 *   3. Recommend the candidate with the lowest passenger load.
 *
 * Routes with no live load data are treated as neutral (0.5) so a route with
 * known-good load always wins a tie, and remaining ties fall back to time.
 */
export function rankRoutes(routes, { tolerance = DEFAULT_TOLERANCE } = {}) {
  if (routes.length === 0) return { routes, recommendation: null };

  const NEUTRAL_SCORE = 0.5;
  const fastest = routes.reduce((best, route) => (route.durationMinutes < best.durationMinutes ? route : best));
  const cutoffMinutes = fastest.durationMinutes * (1 + tolerance);
  const candidates = routes.filter((route) => route.durationMinutes <= cutoffMinutes + 1e-9);

  const ranked = candidates
    .map((route) => ({
      route,
      rankScore: typeof route.load?.score === 'number' ? route.load.score : NEUTRAL_SCORE,
    }))
    .sort((a, b) => {
      if (Math.abs(a.rankScore - b.rankScore) > 0.05) return a.rankScore - b.rankScore;
      if (a.route.durationMinutes !== b.route.durationMinutes) return a.route.durationMinutes - b.route.durationMinutes;
      return a.route.transfers - b.route.transfers;
    });

  const winner = ranked[0].route;
  const orderedCandidates = ranked.map((entry) => entry.route);
  const others = routes
    .filter((route) => !orderedCandidates.includes(route))
    .sort((a, b) => a.durationMinutes - b.durationMinutes);

  // Recommended route first, then everything else that fits the time window
  // (cheapest load first), then the routes that were too slow to qualify.
  const ordered = [winner, ...orderedCandidates.filter((route) => route.id !== winner.id), ...others];

  for (const route of ordered) {
    route.recommended = route.id === winner.id;
  }

  const deltaMinutes = winner.durationMinutes - fastest.durationMinutes;
  const deltaPercent = fastest.durationMinutes > 0
    ? Math.round((deltaMinutes / fastest.durationMinutes) * 100)
    : 0;

  let reason;
  if (winner.id === fastest.id && ranked.length === 1) {
    reason = `Fastest option at ${winner.durationMinutes} min and the only route within ${Math.round(tolerance * 100)}% of it.`;
  } else if (winner.id === fastest.id) {
    reason = `Fastest option at ${winner.durationMinutes} min, and it also has the lowest passenger load among comparable routes.`;
  } else {
    const winnerBand = winner.load?.band?.short || 'lower';
    const fastestBand = fastest.load?.band?.short || 'higher';
    reason = `${deltaPercent <= 0 ? 'Just as fast as the quickest route' : `Only ${deltaPercent}% slower than the quickest route`} `
      + `but ${String(winnerBand).toLowerCase()} load instead of ${String(fastestBand).toLowerCase()} `
      + `(${winner.durationMinutes} min vs ${fastest.durationMinutes} min).`;
  }

  winner.recommendationReason = reason;
  for (const route of ordered) {
    if (route.id === winner.id) continue;
    const slowerPercent = fastest.durationMinutes > 0
      ? Math.round(((route.durationMinutes - fastest.durationMinutes) / fastest.durationMinutes) * 100)
      : 0;
    if (!orderedCandidates.includes(route)) {
      route.recommendationReason = `${route.durationMinutes} min - more than ${Math.round(tolerance * 100)}% slower than the fastest route (${fastest.durationMinutes} min).`;
    } else if (route.transfers > winner.transfers && route.durationMinutes >= winner.durationMinutes) {
      route.recommendationReason = 'Same travel-time window but more interchanges than the recommended route.';
    } else if (typeof route.load?.score === 'number' && typeof winner.load?.score === 'number' && route.load.score > winner.load.score) {
      route.recommendationReason = `${slowerPercent > 0 ? `${slowerPercent}% slower and ` : ''}${String(route.load.band.label).toLowerCase()} on board versus the recommended route (index ${route.load.score.toFixed(2)} vs ${winner.load.score.toFixed(2)}).`;
    } else {
      route.recommendationReason = `Comparable comfort but ${route.durationMinutes - winner.durationMinutes} min longer than the recommended route.`;
    }
  }

  return {
    routes: ordered,
    recommendation: {
      routeId: winner.id,
      reason,
      tolerancePercent: Math.round(tolerance * 100),
      fastestRouteId: fastest.id,
      fastestMinutes: fastest.durationMinutes,
      recommendedMinutes: winner.durationMinutes,
      deltaMinutes,
      deltaPercent,
      loadCompared: {
        recommended: winner.load?.band?.key || 'unknown',
        fastest: fastest.load?.band?.key || 'unknown',
      },
      candidateCount: ranked.length,
      candidates: ranked.map((entry) => ({
        routeId: entry.route.id,
        minutes: entry.route.durationMinutes,
        band: entry.route.load?.band?.key || 'unknown',
      })),
    },
  };
}
/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

/**
 * Plans journeys between two coordinates and returns load-aware routes.
 *
 * @param {object} options
 * @param {{latitude:number,longitude:number,name?:string}} options.origin
 * @param {{latitude:number,longitude:number,name?:string}} options.destination
 * @param {Date}   [options.dateTime]              departure time (default: now)
 * @param {number} [options.tolerance]             recommendation tolerance (0.1 = 10%)
 * @param {string[]} [options.modes]               modes to query (TRANSIT/BUS/RAIL)
 * @param {number} [options.maxRoutes]             cap on returned route count
 * @param {boolean} [options.includeServiceInfo]   include bus operator/frequency details
 * @param {boolean} [options.includeStationInfo]   include interchange info per station
 */
export async function planJourneyRoutes({
  origin,
  destination,
  dateTime = new Date(),
  tolerance = DEFAULT_TOLERANCE,
  modes = ROUTE_MODES,
  maxRoutes = 6,
  includeServiceInfo = true,
  includeStationInfo = true,
} = {}) {
  if (!hasGoogleRoutesKey()) {
    throw new UpstreamError(
      'Google Maps API key is not configured. Please set GOOGLE_MAPS_API_KEY in .env.',
      { service: 'Google Routes', kind: 'not_configured' },
    );
  }

  const nowMs = Date.now();
  const requested = [...new Set((modes || []).filter((mode) => ROUTE_MODES.includes(mode)))];
  const queryModes = requested.length > 0 ? requested : ['TRANSIT'];

  const warnings = [];
  const routes = await computeGoogleTransitRoutes({
    origin,
    destination,
    dateTime,
    modes: queryModes,
  });

  if (routes.length === 0) {
    return {
      generatedAt: new Date().toISOString(),
      departureTime: dateTime.toISOString(),
      origin,
      destination,
      tolerancePercent: Math.round(tolerance * 100),
      queryModes,
      routingSource: null,
      routeCount: 0,
      recommendation: null,
      warnings: [{ mode: 'info', message: 'No routes found for this trip.' }],
      routes: [],
    };
  }

  const context = {
    nowMs,
    departureMs: dateTime.getTime(),
    useForecast: dateTime.getTime() - nowMs > 15 * 60 * 1000,
    includeServiceInfo,
    includeStationInfo,
  };

  const cappedRoutes = routes.slice(0, maxRoutes);
  await Promise.all(cappedRoutes.map((route) => enrichRoute(route, context)));

  const { routes: rankedRoutes, recommendation } = rankRoutes(cappedRoutes, { tolerance });

  return {
    generatedAt: new Date().toISOString(),
    departureTime: dateTime.toISOString(),
    origin,
    destination,
    tolerancePercent: Math.round(tolerance * 100),
    queryModes,
    routingSource: 'google',
    planner: 'Google Maps Transit Route API',
    routeCount: rankedRoutes.length,
    recommendation,
    warnings,
    routes: rankedRoutes,
  };
}
