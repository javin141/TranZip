/**
 * Journey planner: turns raw routing-provider itineraries plus live LTA load
 * data into ranked, comparable routes and picks the recommended one.
 *
 * Three routing sources are tried in order, each falling through to the next:
 *   1. Google Maps Routes API (preferred, when GOOGLE_MAPS_API_KEY is set).
 *   2. OneMap's public transport routing service (when the token is
 *      provisioned for `/api/public/routingsvc/route`).
 *   3. A LTA DataMall-native planner (`localPlanner.js`) that builds journeys
 *      from `/BusRoutes` + the rail topology - the always-available fallback.
 *
 * All three produce the same route shape, so load enrichment and the
 * recommendation rule below apply identically.
 *
 * Recommendation rule (as specified):
 *   Of all routes whose travel time is within `tolerance` (default 10%) of the
 *   fastest route, recommend the one with the lowest passenger load.
 */

import { getBusArrival, getBusServiceInfo, getCrowdRealTime, getCrowdForecast, getBusStop } from './ltaClient.js';
import { planJourney, ROUTE_MODES } from './oneMapClient.js';
import { computeGoogleTransitRoutes, hasGoogleRoutesKey } from './googleRoutesClient.js';
import { planJourneysLocally, PLANNER_NAME } from './localPlanner.js';
import { getServiceDisruption, disruptionSummary, disruptionNoteForLine } from './disruptions.js';
import { getWeatherNear } from './weatherClient.js';
import { applyDurationRange } from './durationRange.js';
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
import { formatStopName, parseTimeMs, stationLabel } from './format.js';

export const DEFAULT_TOLERANCE = 0.1;

/** Classifies a OneMap leg into the vocabulary the UI and load model understand. */
export function legType(leg) {
  const mode = String(leg?.mode || '').toUpperCase();
  if (mode === 'WALK') return 'walk';
  const fromCode = leg?.from?.stopCode;
  if (isStationCode(fromCode) || isStationCode(leg?.to?.stopCode)) return 'mrt';
  if (mode === 'BUS' || mode === 'COACH') return 'bus';
  if (mode === 'SUBWAY' || mode === 'RAIL' || mode === 'TRAM') return 'mrt';
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

/**
 * Keeps the first route for each distinct itinerary signature. Google's
 * `computeAlternativeRoutes` can return the same journey several times over at
 * successive departures, which would otherwise show as identical route cards
 * and make "lowest load within tolerance" a comparison between copies.
 */
export function dedupeRoutesBySignature(routes) {
  const seen = new Set();
  return routes.filter((route) => {
    const key = route.signature || route.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  const boardingTime = parseTimeMs(leg.departure) ?? context.departureMs;

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
  // The bus the passenger can actually catch. Only when leaving soon is it
  // fine to fall back to the next bus listed; for a departure further out
  // (crowd forecast territory) that bus is a different vehicle at a
  // different time, so reporting its load would be misleading - LTA has no
  // bus-load forecast - and the leg is left as "no live data" instead.
  const chosen = slots.find((slot) => Number.isFinite(slot.arrivalMs) && slot.arrivalMs >= boardingTime - 60000)
    || (context.useForecast ? null : slots[0])
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

/* ------------------------------------------------------------------ *
 * Live service disruptions
 * ------------------------------------------------------------------ */

function legStationCodes(leg) {
  if (leg.type !== 'mrt') return [];
  return [leg.from?.code, ...(leg.intermediateStops || []).map((stop) => stop.code), leg.to?.code].filter(Boolean);
}

/**
 * Flags any rail leg that passes through a station named in a live
 * `/TrainServiceAlerts` segment with `affected: true`. The pathfinder tries
 * to route around an active disruption for the routes it builds itself (see
 * `disruption.stationCodes` passed to the local planner), so a flagged leg
 * on one of *those* means no rail alternative existed. But this also runs
 * on `baselineRoute` (deliberately planned *without* avoiding the
 * disruption, to show what the "usual" route looks like) and on routes from
 * sources that don't know about LTA disruptions at all (Google/OneMap) -
 * for those, a flagged leg just means the disruption sits on that route, not
 * that TranZip failed to route around it.
 */
function applyDisruption(route, disruption) {
  if (!disruption?.active) {
    route.disrupted = false;
    route.disruptionSimulated = false;
    return route;
  }
  let disrupted = false;
  for (const leg of route.legs) {
    if (leg.type !== 'mrt') continue;
    const hit = legStationCodes(leg).some((code) => disruption.stationCodes.has(code));
    leg.affected = hit;
    if (hit) {
      disrupted = true;
      leg.affectedNote = disruptionNoteForLine(disruption, leg.line);
    }
  }
  route.disrupted = disrupted;
  // Only meaningful alongside `disrupted`/`rerouted`, but set unconditionally
  // so the UI can show "[SIMULATED]" on any route touched by the demo
  // toggle, not just ones the pathfinder couldn't route around.
  route.disruptionSimulated = disruption.simulated;
  return route;
}

/** Every MRT/LRT stop (code + resolved name) a route actually passes through. */
function routeRailStops(route) {
  const stops = [];
  for (const leg of route.legs) {
    if (leg.type !== 'mrt') continue;
    for (const stop of [leg.from, ...(leg.intermediateStops || []), leg.to]) {
      if (stop?.code) stops.push(stop);
    }
  }
  return stops;
}

/**
 * One-line note when a route passes through a station where LTA is running a
 * free bus or free MRT shuttle to bridge a live disruption - reuses each
 * stop's already-resolved name (from the routing source), so no extra
 * lookup is needed.
 */
function applyFreeTransfer(route, disruption) {
  if (!disruption?.active) {
    route.freeTransferNote = null;
    return route;
  }
  const prefix = disruption.simulated ? '[SIMULATED] ' : '';
  const stops = routeRailStops(route);

  const busStop = stops.find((stop) => disruption.freeBusStations.has(stop.code));
  if (busStop) {
    route.freeTransferNote = `${prefix}Free bus available at ${busStop.name || busStop.code}`;
    return route;
  }
  const shuttleStop = stops.find((stop) => disruption.shuttleStations.has(stop.code));
  if (shuttleStop) {
    const direction = disruption.shuttleDirection ? ` (${disruption.shuttleDirection})` : '';
    route.freeTransferNote = `${prefix}Free MRT shuttle at ${shuttleStop.name || shuttleStop.code}${direction}`;
    return route;
  }
  if (disruption.freeBusIslandWide && (route.disrupted || stops.some((stop) => disruption.stationCodes.has(stop.code)))) {
    route.freeTransferNote = `${prefix}Free bus service available island-wide during this disruption`;
    return route;
  }
  route.freeTransferNote = null;
  return route;
}

/* ------------------------------------------------------------------ *
 * Weather-aware ranking (opt-in)
 * ------------------------------------------------------------------ */

/**
 * Notes how exposed a route is to current weather (time spent walking), for
 * display only - the actual ranking bias lives in `rankRoutes`. Called on
 * every route regardless of whether weather-avoidance is active, so the UI
 * field is always present (`null` when inactive).
 */
function applyWeather(route, weather) {
  if (!weather?.active) {
    route.weatherNote = null;
    return route;
  }
  const walkMinutes = route.walkMinutes || 0;
  route.weatherNote = walkMinutes > 0
    ? `${Math.round(walkMinutes)} min on foot ${weather.condition === 'rain' ? 'in the rain' : 'in the heat'}.`
    : `No time on foot${weather.condition === 'rain' ? ' - stays under cover.' : ' - stays out of the heat.'}`;
  return route;
}

/** Enriches every in-vehicle leg with LTA load data (never throws). */
async function enrichRoute(route, context) {
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

  applyDurationRange(route, context);

  return route;
}

/* ------------------------------------------------------------------ *
 * Ranking & recommendation
 * ------------------------------------------------------------------ */

/**
 * Applies the recommendation rule:
 *   1. Find the fastest route - among routes clear of a live service
 *      disruption when at least one exists, since a disruption is a hard
 *      constraint rather than a comfort preference the usual tolerance can
 *      trade away.
 *   2. Consider every remaining route within `tolerance` (default 10%) of
 *      that time.
 *   3. Recommend the candidate with the lowest passenger load.
 *
 * Routes with no live load data are treated as neutral (0.5) so a route with
 * known-good load always wins a tie, and remaining ties fall back to time.
 *
 * When `weatherActive` is set (the user opted into rain/heat avoidance and
 * it's currently raining or hot), each route's rank score blends its crowd
 * load with how much of the trip is spent walking - a preference, not a hard
 * filter like the disruption rule above, since staying dry is a comfort
 * trade-off the traveller opted into rather than a route being unusable.
 */
export function rankRoutes(routes, { tolerance = DEFAULT_TOLERANCE, weatherActive = false } = {}) {
  if (routes.length === 0) return { routes, recommendation: null };

  const NEUTRAL_SCORE = 0.5;
  const WEATHER_WEIGHT = 0.5;
  const fastestOverall = routes.reduce((best, route) => (route.durationMinutes < best.durationMinutes ? route : best));
  const hasCleanRoute = routes.some((route) => !route.disrupted);
  const pool = hasCleanRoute ? routes.filter((route) => !route.disrupted) : routes;
  const fastest = pool.reduce((best, route) => (route.durationMinutes < best.durationMinutes ? route : best));
  const cutoffMinutes = fastest.durationMinutes * (1 + tolerance);
  const candidates = pool.filter((route) => route.durationMinutes <= cutoffMinutes + 1e-9);

  const rankScoreFor = (route) => {
    const loadScore = typeof route.load?.score === 'number' ? route.load.score : NEUTRAL_SCORE;
    if (!weatherActive || !(route.durationMinutes > 0)) return loadScore;
    const walkShare = Math.min(1, (route.walkMinutes || 0) / route.durationMinutes);
    return loadScore * (1 - WEATHER_WEIGHT) + walkShare * WEATHER_WEIGHT;
  };

  const ranked = candidates
    .map((route) => ({ route, rankScore: rankScoreFor(route) }))
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

  // Weather bias can make the winner's raw crowd load *worse* than the
  // fastest route's (walk-exposure outweighed it) - the usual "lower load
  // instead of higher" phrasing would then misdescribe the trade-off, so it
  // switches to comparing walking time instead, which is what actually
  // decided it.
  const winnerWalk = Math.round(winner.walkMinutes || 0);
  const fastestWalk = Math.round(fastest.walkMinutes || 0);
  const weatherDecided = weatherActive && winnerWalk !== fastestWalk;

  let reason;
  if (winner.id === fastest.id && ranked.length === 1) {
    reason = `Fastest option at ${winner.durationMinutes} min and the only route within ${Math.round(tolerance * 100)}% of it.`;
  } else if (winner.id === fastest.id) {
    reason = `Fastest option at ${winner.durationMinutes} min, and it also has the lowest passenger load among comparable routes.`;
  } else if (weatherDecided) {
    reason = `${deltaPercent <= 0 ? 'Just as fast as the quickest route' : `Only ${deltaPercent}% slower than the quickest route`} `
      + `but ${winnerWalk} min on foot instead of ${fastestWalk} min `
      + `(${winner.durationMinutes} min vs ${fastest.durationMinutes} min).`;
  } else {
    const winnerBand = winner.load?.band?.short || 'lower';
    const fastestBand = fastest.load?.band?.short || 'higher';
    reason = `${deltaPercent <= 0 ? 'Just as fast as the quickest route' : `Only ${deltaPercent}% slower than the quickest route`} `
      + `but ${String(winnerBand).toLowerCase()} load instead of ${String(fastestBand).toLowerCase()} `
      + `(${winner.durationMinutes} min vs ${fastest.durationMinutes} min).`;
  }

  if (weatherActive && !weatherDecided) {
    reason += ` ${winner.weatherNote || "It's raining or hot right now"} - routes were weighted toward less time on foot.`;
  } else if (weatherActive) {
    reason += " It's raining or hot right now, so routes were weighted toward less time on foot.";
  }

  if (winner.disrupted) {
    reason += ' Every option currently passes through a live service alert - this keeps the affected stretch as short as possible.';
  } else if (fastestOverall.disrupted && fastestOverall.id !== winner.id) {
    reason += ' A faster route exists but was skipped because it is affected by a live service alert.';
  }

  winner.recommendationReason = reason;
  for (const route of ordered) {
    if (route.id === winner.id) continue;
    const slowerPercent = fastest.durationMinutes > 0
      ? Math.round(((route.durationMinutes - fastest.durationMinutes) / fastest.durationMinutes) * 100)
      : 0;
    if (route.disrupted && hasCleanRoute) {
      const lines = [...new Set(
        route.legs.filter((leg) => leg.affected).map((leg) => lineMeta(leg.line)?.short || leg.line),
      )];
      route.recommendationReason = `Avoided - affected by a live service alert on ${lines.join(', ') || 'the rail network'}.`;
    } else if (!orderedCandidates.includes(route)) {
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
      disruptionAvoided: hasCleanRoute && Boolean(fastestOverall.disrupted),
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
 * @param {boolean} [options.avoidWeather]         bias ranking toward less time on foot when it's raining/hot
 * @param {'auto'|'google'|'onemap'|'lta'} [options.planner] force a routing source (debug/QA)
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
  avoidWeather = false,
  planner = 'auto',
} = {}) {
  const nowMs = Date.now();
  const requested = [...new Set((modes || []).filter((mode) => ROUTE_MODES.includes(mode)))];
  const queryModes = requested.length > 0 ? requested : ['TRANSIT'];

  const warnings = [];
  let routingSource = null;
  /** @type {any} */
  let analyzedLocal = null;

  // Weather is read every time (cached, no key needed) because the travel-time
  // ranges widen walking legs when it's raining; `avoidWeather` only decides
  // whether it also biases ranking.
  const [disruption, weatherReading] = await Promise.all([
    getServiceDisruption().catch(() => ({
      active: false, segments: [], stationCodes: new Set(), lineCodes: new Set(), messages: [],
    })),
    getWeatherNear(origin).catch(() => null),
  ]);
  if (disruption.active) {
    warnings.push({ mode: 'warning', message: disruptionSummary(disruption) });
  }

  const weather = avoidWeather ? weatherReading : null;
  const weatherActive = Boolean(weather && (weather.isRaining || weather.isHot));
  if (avoidWeather && weatherActive) {
    const conditionText = weather.isRaining
      ? `Raining now${weather.forecastText ? ` (${weather.forecastText})` : ''}`
      : `Hot right now${typeof weather.temperatureC === 'number' ? ` (${Math.round(weather.temperatureC)}°C)` : ''}`;
    const prefix = weather.simulated ? '[SIMULATED] ' : '';
    warnings.push({ mode: 'weather', message: `${prefix}${conditionText}. Routes were weighted toward less time on foot.` });
  }

  const context = {
    nowMs,
    departureMs: dateTime.getTime(),
    // Plans more than 15 minutes ahead use the 30-minute crowd forecast;
    // sooner departures use LTA's live 10-minute crowd reading.
    useForecast: dateTime.getTime() - nowMs > 15 * 60 * 1000,
    includeServiceInfo,
    includeStationInfo,
    raining: Boolean(weatherReading?.isRaining),
    rainSimulated: Boolean(weatherReading?.simulated),
  };

  /** @type {any[]} */
  let summarized = [];

  // 1. Google Maps Routes API - preferred when a key is configured.
  if (routingSource === null && planner !== 'onemap' && planner !== 'lta' && hasGoogleRoutesKey()) {
    try {
      const googleRoutes = await computeGoogleTransitRoutes({ origin, destination, dateTime, modes: queryModes });
      if (googleRoutes.length > 0) {
        summarized = dedupeRoutesBySignature(googleRoutes).slice(0, maxRoutes);
        routingSource = 'google';
      } else if (planner === 'google') {
        warnings.push({ mode: 'google', message: 'Google routing was requested but returned no itineraries.' });
      }
    } catch (error) {
      warnings.push({ mode: 'google', message: error.message || 'Google routing request failed.' });
    }
  }

  // 2. OneMap's public transport routing service - fallback, or when
  // explicitly requested.
  if (routingSource === null && planner !== 'lta' && planner !== 'google') {
    /** @type {Map<string, { itinerary: any, modes: Set<string> }>} */
    const collected = new Map();
    const settled = await Promise.allSettled(
      queryModes.map((mode) => planJourney({
        start: origin,
        end: destination,
        mode,
        dateTime,
        numItineraries: 3,
      })),
    );

    settled.forEach((result, index) => {
      const mode = queryModes[index];
      if (result.status === 'rejected') {
        warnings.push({ mode, message: result.reason?.message || 'Routing request failed.' });
        return;
      }
      for (const itinerary of result.value?.plan?.itineraries || []) {
        const signature = itinerarySignature(itinerary);
        if (!signature || signature === 'walk-only') continue;
        const existing = collected.get(signature);
        if (existing) existing.modes.add(mode);
        else collected.set(signature, { itinerary, modes: new Set([mode]) });
      }
    });

    if (collected.size > 0) {
      summarized = [...collected.values()]
        .sort((a, b) => (a.itinerary.duration || 0) - (b.itinerary.duration || 0))
        .slice(0, maxRoutes)
        .map((entry, index) => {
          const route = summarizeItinerary(entry.itinerary, index, { origin, destination });
          route.queryModes = [...entry.modes];
          route.source = 'onemap';
          route.planner = 'OneMap routing (OTP)';
          return route;
        });
      routingSource = 'onemap';
    } else if (planner === 'onemap') {
      warnings.push({ mode: 'onemap', message: 'OneMap routing was requested but returned no itineraries.' });
    }
  }

  // Neither Google nor OneMap knows about live LTA service alerts, so either
  // can hand back itineraries that ride straight through a disruption. Ask
  // the LTA-native planner for alternates that route around the affected
  // stations and fold in the ones it finds, so a real reroute is offered
  // instead of only a warning.
  if ((routingSource === 'google' || routingSource === 'onemap') && disruption.active) {
    const detour = await planJourneysLocally({
      origin,
      destination,
      dateTime,
      modes: queryModes,
      maxRoutes: Math.max(3, Math.round(maxRoutes / 2)),
      avoidStations: disruption.stationCodes,
    }).catch(() => null);
    if (detour?.routes?.length) {
      const existingSignatures = new Set(summarized.map((route) => (route.routeCodes || []).join('+')));
      for (const route of detour.routes) {
        if (existingSignatures.has((route.routeCodes || []).join('+'))) continue;
        route.source = 'lta';
        route.planner = PLANNER_NAME;
        route.rerouted = true;
        summarized.push(route);
      }
    }
  }

  // 3. LTA DataMall-native planner - the always-available last resort, so the
  // app keeps working with no Google key and no OneMap routing.
  if (routingSource === null && planner !== 'onemap' && planner !== 'google') {
    const local = await planJourneysLocally({
      origin,
      destination,
      dateTime,
      modes: queryModes,
      maxRoutes: Math.max(maxRoutes, 6),
      avoidStations: disruption.active ? disruption.stationCodes : null,
    });
    analyzedLocal = local;
    summarized = local.routes;
    warnings.push(...local.warnings);
    if (summarized.length > 0) {
      routingSource = 'lta';
      warnings.push({
        mode: 'info',
        message: 'Neither Google Routes nor OneMap routing is enabled, so journeys were planned with LTA DataMall '
          + 'bus routes and the MRT network (times are estimates).',
      });
    }
  }

  summarized.forEach((route) => {
    applyDisruption(route, disruption);
    applyFreeTransfer(route, disruption);
    applyWeather(route, weatherActive ? { active: true, condition: weather.condition } : null);
  });

  // When a disruption is active, also plan the "usual" route - the fastest
  // one WITHOUT avoiding the disruption - so the UI can draw it against the
  // actual recommendation and show exactly how much the disruption costs.
  // This intentionally always goes through the local LTA-native planner
  // (never Google/OneMap, which don't know the disruption exists in the
  // first place) so it's a like-for-like "what the topology normally gives
  // you" comparison regardless of which source served the routes above.
  let baselineRoute = null;
  if (disruption.active) {
    const baseline = await planJourneysLocally({
      origin, destination, dateTime, modes: queryModes, maxRoutes: 1, avoidStations: null,
    }).catch(() => null);
    if (baseline?.routes?.[0]) {
      [baselineRoute] = baseline.routes;
      baselineRoute.source = 'lta';
      baselineRoute.planner = PLANNER_NAME;
      baselineRoute.isBaseline = true;
      applyDisruption(baselineRoute, disruption);
      applyFreeTransfer(baselineRoute, disruption);
      await enrichRoute(baselineRoute, context).catch(() => null);
    }
  }

  if (summarized.length === 0) {
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
      warnings: warnings.length > 0 ? warnings : [{ mode: 'info', message: 'No routes found for this trip.' }],
      routes: [],
      baselineRoute,
      disruption: { active: disruption.active, lines: [...disruption.lineCodes], simulated: Boolean(disruption.simulated) },
      weather: weather ? { active: weatherActive, condition: weather.condition, temperatureC: weather.temperatureC, rainfallMm: weather.rainfallMm } : { active: false },
    };
  }

  await Promise.all(summarized.map((route) => enrichRoute(route, context)));

  const { routes, recommendation } = rankRoutes(summarized, { tolerance, weatherActive });

  if (baselineRoute && recommendation) {
    recommendation.baselineMinutes = baselineRoute.durationMinutes;
    recommendation.deltaMinutes = recommendation.recommendedMinutes - baselineRoute.durationMinutes;
  }

  const plannerLabel = {
    google: 'Google Maps Transit Route API',
    onemap: 'OneMap routing (OTP)',
    lta: PLANNER_NAME,
  }[routingSource] || null;

  return {
    generatedAt: new Date().toISOString(),
    departureTime: dateTime.toISOString(),
    origin,
    destination,
    tolerancePercent: Math.round(tolerance * 100),
    queryModes,
    routingSource,
    planner: plannerLabel,
    localPlannerStats: routingSource === 'lta' ? analyzedLocal?.stats || null : null,
    routeCount: routes.length,
    recommendation,
    warnings,
    routes,
    baselineRoute,
    disruption: {
      active: disruption.active,
      lines: [...disruption.lineCodes],
      stations: [...disruption.stationCodes],
      simulated: Boolean(disruption.simulated),
    },
    weather: weather
      ? {
        active: weatherActive,
        condition: weather.condition,
        isRaining: weather.isRaining,
        isHot: weather.isHot,
        temperatureC: weather.temperatureC,
        rainfallMm: weather.rainfallMm,
        forecastText: weather.forecastText,
      }
      : { active: false },
  };
}