/**
 * LTA DataMall-native journey planner (the fallback when OneMap routing is not
 * available for the configured token).
 *
 * It is intentionally a *candidate enumerator* rather than a full RAPTOR
 * implementation: it builds every plausible shape of journey between two
 * points, estimates each one with a transparent time model, then hands the
 * survivors to `journeyPlanner.rankRoutes` so the same recommendation rule
 * (lowest load within the time tolerance) applies to both planners.
 *
 * Journey shapes considered
 *   walk only
 *   rail only                       (MRT/LRT path over the topology graph)
 *   direct bus                      (one service, board -> alight)
 *   bus + rail                      (bus to a station, then rail)
 *   rail + bus                      (rail, then bus to the destination)
 *   bus + bus                       (one bus-to-bus interchange)
 *
 * Time model (all assumptions are named constants below)
 *   walk  1.25 m/s plus a fixed overhead per walking leg
 *   bus   18 km/h commercial speed plus dwell per stop, and half the published
 *         headway as the expected wait
 *   rail  commercial speed from `railNetwork` (dwell included) plus a fixed
 *         interchange penalty per line change
 */
import {
  findRailPath,
  haversineMeters,
  nearestStations,
  railNetwork,
  railStation,
  splitPathByLine,
} from './railNetwork.js';
import { busRouteStops, busStop, servicesAtStop, stopsNear } from './busNetwork.js';
import { formatStopName } from './format.js';
import { lineMeta } from './railLines.js';

export const PLANNER_NAME = 'NebulaX planner';

const WALK_SPEED = 1.25; // m/s (~4.5 km/h)
const WALK_OVERHEAD_MINUTES = 1;
const WALK_DETOUR_FACTOR = 1.25; // straight-line -> street distance
const BUS_SPEED = 5; // m/s (~18 km/h)
const BUS_DWELL_MINUTES = 0.35;
const BUS_WAIT_MINIMUM = 2.5;
const BUS_WAIT_MAXIMUM = 12;
const RAIL_WAIT_MINUTES = 3;
const RAIL_TRANSFER_MINUTES = 4.5;
const MAX_WALK_TO_BUS = 700;
const MAX_WALK_TO_RAIL = 1500;
const MAX_RAIL_ACCESS_WALK = 900; // bus -> rail interchange walk
const MAX_TRIP_MINUTES = 150;
const MAX_CANDIDATES = 120;

/** Distance-based adult card fare (SGD) - an estimate, not a quote. */
const FARE_BANDS = [
  [3.2, 1.19], [4.2, 1.29], [5.2, 1.39], [6.2, 1.49], [7.2, 1.59], [8.2, 1.69],
  [9.2, 1.79], [10.2, 1.89], [11.2, 1.99], [12.2, 2.09], [13.2, 2.19], [14.2, 2.29],
  [15.2, 2.39], [16.2, 2.49], [17.2, 2.59], [18.2, 2.69], [19.2, 2.79], [20.2, 2.89],
  [22.2, 2.99], [24.2, 3.09],
];

export function estimateFare(distanceMeters) {
  const km = Math.max(0, distanceMeters) / 1000;
  for (const [limit, fare] of FARE_BANDS) if (km <= limit) return fare;
  return 3.19;
}

const round = (value, digits = 1) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/** Walking minutes between two points (straight line plus a street detour). */
function walkMinutes(from, to) {
  const distance = haversineMeters(from, to);
  if (distance == null) return { minutes: 5, meters: 400 };
  const meters = distance * WALK_DETOUR_FACTOR;
  return {
    meters: Math.round(meters),
    minutes: Math.max(0.5, round(meters / WALK_SPEED / 60 + WALK_OVERHEAD_MINUTES)),
  };
}

/** Bus ride minutes over a distance, including dwell at every intermediate stop. */
function busRideMinutes(distanceMeters, stops) {
  return Math.max(
    1,
    round(distanceMeters / BUS_SPEED / 60 + Math.max(0, stops) * BUS_DWELL_MINUTES),
  );
}

/** Expected wait for a service based on its published peak headway. */
function busWaitMinutes(peakFrequency) {
  if (!Number.isFinite(peakFrequency)) return 6;
  return round(Math.min(BUS_WAIT_MAXIMUM, Math.max(BUS_WAIT_MINIMUM, peakFrequency / 2)), 1);
}

/** Rail ride minutes along an ordered station run (dwell included). */
function railRideMinutes(stations, line) {
  let meters = 0;
  for (let index = 1; index < stations.length; index += 1) {
    meters += haversineMeters(stations[index - 1], stations[index]) ?? 1200;
  }
  const isLrt = /LRT/i.test(lineMeta(line)?.name || '');
  const speed = isLrt ? 9.5 : 13;
  return { meters: Math.round(meters), minutes: Math.max(1, round(meters / speed / 60)) };
}

/** Point payload shared by every leg (`toPoint` in journeyPlanner consumes this). */
function point(record, time = null) {
  if (!record) return null;
  return {
    name: record.name ? formatStopName(record.name) : null,
    rawName: record.name || '',
    code: record.code || null,
    latitude: record.latitude ?? null,
    longitude: record.longitude ?? null,
    time: time ? new Date(time).toISOString() : null,
  };
}

const coordinates = (list) => list
  .filter((entry) => entry && Number.isFinite(entry.latitude) && Number.isFinite(entry.longitude))
  .map((entry) => [entry.latitude, entry.longitude]);

/* ------------------------------------------------------------------ *
 * Candidate construction
 * ------------------------------------------------------------------ */

/** Builds the in-vehicle leg for one service between two stop indexes. */
async function buildBusSegment(route, boardIndex, alightIndex) {
  const board = route.stops[boardIndex];
  const alight = route.stops[alightIndex];
  const slice = route.stops.slice(boardIndex, alightIndex + 1);
  const records = (await Promise.all(slice.map((stop) => busStop(stop.code)))).filter(Boolean);
  if (!records.some((record) => record.code === board.code)) records.unshift({ code: board.code, name: null });
  if (!records.some((record) => record.code === alight.code)) records.push({ code: alight.code, name: null });

  let meters = alight.distance - board.distance;
  if (!(meters > 0)) {
    meters = 0;
    for (let index = 1; index < records.length; index += 1) {
      meters += haversineMeters(records[index - 1], records[index]) ?? 400;
    }
    meters *= WALK_DETOUR_FACTOR;
  }

  const stopsRun = Math.max(0, slice.length - 2);
  return {
    kind: 'bus',
    serviceNo: route.serviceNo,
    direction: route.direction,
    operator: route.operator,
    category: route.category,
    frequencyLabel: route.frequencyLabel,
    peakFrequency: route.peakFrequency,
    loopDescription: route.loopDescription,
    destinationCode: route.destinationCode,
    from: records[0],
    to: records[records.length - 1],
    stops: records,
    meters: Math.round(meters),
    minutes: busRideMinutes(meters, stopsRun),
    stopsRun,
  };
}

/** Rail segments (one per line) for a station-to-station path. */
async function buildRailSegments(fromCode, toCode, { waitMinutes = RAIL_WAIT_MINUTES } = {}) {
  const path = await findRailPath(fromCode, toCode);
  if (!path || path.stations.length < 2) return null;

  const segments = splitPathByLine(path).filter((segment) => segment.stations.length > 1);
  if (segments.length === 0) return null;

  const built = [];
  for (const segment of segments) {
    const records = (await Promise.all(segment.stations.map((code) => railStation(code)))).filter(Boolean);
    const ride = railRideMinutes(records, segment.line);
    built.push({
      kind: 'rail',
      line: segment.line,
      lineName: lineMeta(segment.line)?.name || null,
      from: records[0],
      to: records[records.length - 1],
      stops: records,
      meters: ride.meters,
      minutes: ride.minutes,
      stopsRun: Math.max(0, records.length - 2),
      waitMinutes: built.length === 0 ? waitMinutes : 0,
      isInterchange: built.length > 0,
    });
  }
  return built;
}

/** Walk segment between two arbitrary records. */
function buildWalkSegment(from, to, { labelFrom = null, labelTo = null } = {}) {
  const walk = walkMinutes(from, to);
  return {
    kind: 'walk',
    from: labelFrom || from,
    to: labelTo || to,
    stops: [from, to],
    meters: walk.meters,
    minutes: walk.minutes,
  };
}

/** Turns a segment list into a comparable candidate. */
function makeCandidate(segments) {
  const rides = segments.filter((segment) => segment.kind !== 'walk');
  if (rides.length === 0) return null;
  return {
    segments,
    signature: segments
      .map((segment) => (segment.kind === 'walk'
        ? `w${segment.meters}`
        : `${segment.kind}:${segment.serviceNo || segment.line}:${segment.from?.code}->${segment.to?.code}`))
      .join('|'),
  };
}

/** Coarse total-minutes estimate, used to prune candidates before enrichment. */
export function candidateMinutes(candidate) {
  let minutes = 0;
  for (const segment of candidate.segments) {
    minutes += segment.minutes + (segment.waitMinutes || 0);
    if (segment.isInterchange) minutes += RAIL_TRANSFER_MINUTES;
  }
  return round(minutes);
}
/* ------------------------------------------------------------------ *
 * Access indexes
 * ------------------------------------------------------------------ */

let accessIndexPromise = null;

/**
 * stop code -> nearest rail station, for every bus stop within walking range of
 * a station. Built once (~20k distance checks) so bus-to-rail transfers can be
 * detected with a single Map lookup while scanning a bus route.
 */
export function stationAccessIndex() {
  if (!accessIndexPromise) accessIndexPromise = buildStationAccessIndex();
  return accessIndexPromise;
}

async function buildStationAccessIndex() {
  const network = await railNetwork();
  const index = new Map();
  for (const station of network.located) {
    const near = await stopsNear(station, { radiusMeters: MAX_RAIL_ACCESS_WALK, limit: 40 });
    for (const entry of near) {
      const existing = index.get(entry.stop.code);
      if (!existing || entry.distanceMeters < existing.distanceMeters) {
        index.set(entry.stop.code, { station, distanceMeters: entry.distanceMeters });
      }
    }
  }
  return index;
}

/** Resolves the origin/destination access points once per request. */
async function resolveAccess(origin, destination) {
  const [originStops, destStops, originStations, destStations] = await Promise.all([
    stopsNear(origin, { radiusMeters: MAX_WALK_TO_BUS, limit: 18 }),
    stopsNear(destination, { radiusMeters: MAX_WALK_TO_BUS, limit: 18 }),
    nearestStations(origin, { limit: 3, maxMeters: MAX_WALK_TO_RAIL }),
    nearestStations(destination, { limit: 3, maxMeters: MAX_WALK_TO_RAIL }),
  ]);
  return { originStops, destStops, originStations, destStations };
}

/* ------------------------------------------------------------------ *
 * Journey shapes
 * ------------------------------------------------------------------ */

function walkOnlyCandidate(origin, destination) {
  const distance = haversineMeters(origin, destination);
  if (distance == null || distance > 2500) return null;
  return makeCandidate([buildWalkSegment(origin, destination, { labelTo: destination })]);
}

async function railOnlyCandidates({ origin, destination, originStations, destStations }) {
  const candidates = [];
  for (const from of originStations) {
    for (const to of destStations) {
      if (from.code === to.code) continue;
      const rail = await buildRailSegments(from.code, to.code);
      if (!rail) continue;
      const toWalk = buildWalkSegment(rail[rail.length - 1].to, destination, { labelTo: destination });
      if (toWalk.meters > MAX_WALK_TO_RAIL) continue;
      candidates.push(makeCandidate([
        buildWalkSegment(origin, rail[0].from, { labelFrom: origin }),
        ...rail,
        toWalk,
      ]));
    }
  }
  return candidates;
}
/** Direct bus: one service from a stop near the origin to a stop near the destination. */
async function directBusCandidates({ origin, destination, originStops, destStops }) {
  const destByCode = new Map(destStops.map((entry) => [entry.stop.code, entry]));
  const candidates = [];
  const seen = new Set();

  for (const access of originStops) {
    const services = await servicesAtStop(access.stop.code);
    for (const service of services) {
      const route = await busRouteStops(service.serviceNo, service.direction);
      if (!route) continue;
      const boardIndex = route.stops.findIndex((stop) => stop.code === access.stop.code);
      if (boardIndex < 0) continue;
      const key = `${route.serviceNo}|${route.direction}`;
      if (seen.has(key)) continue;

      let best = null;
      const limit = Math.min(route.stops.length - 1, boardIndex + 80);
      for (let index = boardIndex + 1; index <= limit; index += 1) {
        const target = destByCode.get(route.stops[index].code);
        if (!target) continue;
        const meters = route.stops[index].distance - route.stops[boardIndex].distance;
        const minutes = busRideMinutes(meters > 0 ? meters : 0, index - boardIndex - 1);
        // Rank by total time (walking at ~1.25 m/s) so the closest stop wins.
        const total = minutes + (access.distanceMeters + target.distanceMeters) / WALK_SPEED / 60;
        if (!best || total < best.total) best = { index, total };
      }
      if (!best) continue;
      seen.add(key);

      const segment = await buildBusSegment(route, boardIndex, best.index);
      if (!segment) continue;
      const candidate = makeCandidate([
        buildWalkSegment(origin, segment.from, { labelFrom: origin }),
        { ...segment, waitMinutes: busWaitMinutes(segment.peakFrequency) },
        buildWalkSegment(segment.to, destination, { labelTo: destination }),
      ]);
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates;
}

/** Bus to a rail station, then rail to a station near the destination. */
async function busThenRailCandidates({ origin, destination, originStops, destStations }) {
  const railAccess = await stationAccessIndex();
  const candidates = [];
  const used = new Set();

  for (const access of originStops) {
    const services = await servicesAtStop(access.stop.code);
    for (const service of services) {
      const route = await busRouteStops(service.serviceNo, service.direction);
      if (!route) continue;
      const boardIndex = route.stops.findIndex((stop) => stop.code === access.stop.code);
      if (boardIndex < 0) continue;

      // Keep the two closest rail interchanges reachable without a long ride.
      const transfers = [];
      const limit = Math.min(route.stops.length - 1, boardIndex + 60);
      for (let index = boardIndex + 1; index <= limit; index += 1) {
        const hit = railAccess.get(route.stops[index].code);
        if (!hit) continue;
        const meters = route.stops[index].distance - route.stops[boardIndex].distance;
        if (meters > 14000) break;
        transfers.push({ index, station: hit.station, meters });
        if (transfers.length >= 2) break;
      }

      for (const transfer of transfers) {
        for (const to of destStations) {
          if (to.code === transfer.station.code) continue;
          const key = `${route.serviceNo}|${route.direction}|${transfer.station.code}|${to.code}`;
          if (used.has(key)) continue;
          const rail = await buildRailSegments(transfer.station.code, to.code);
          if (!rail) continue;
          used.add(key);

          const busSegment = await buildBusSegment(route, boardIndex, transfer.index);
          if (!busSegment) continue;
          const railToWalk = buildWalkSegment(rail[rail.length - 1].to, destination, { labelTo: destination });
          if (railToWalk.meters > MAX_WALK_TO_RAIL) continue;
          const interchangeWalk = buildWalkSegment(busSegment.to, rail[0].from, { labelTo: rail[0].from });
          if (interchangeWalk.meters > MAX_RAIL_ACCESS_WALK + 250) continue;

          const candidate = makeCandidate([
            buildWalkSegment(origin, busSegment.from, { labelFrom: origin }),
            { ...busSegment, waitMinutes: busWaitMinutes(busSegment.peakFrequency) },
            { ...interchangeWalk, transfer: true },
            ...rail,
            railToWalk,
          ]);
          if (candidate) candidates.push(candidate);
        }
      }
    }
  }
  return candidates;
}

/** Rail to a station near the destination, then a feeder bus to the destination. */
async function railThenBusCandidates({ origin, destination, originStations, destStops }) {
  const candidates = [];
  const railAccess = await stationAccessIndex();

  // Feeder buses only help when the destination is beyond walking range of a
  // station, so the services calling at destination stops are indexed up front.
  const feederServices = new Map();
  for (const entry of destStops) {
    for (const service of await servicesAtStop(entry.stop.code)) {
      const key = `${service.serviceNo}|${service.direction}`;
      if (!feederServices.has(key)) feederServices.set(key, []);
      feederServices.get(key).push(entry);
    }
  }
  if (feederServices.size === 0) return candidates;

  for (const from of originStations) {
    for (const [key, targets] of feederServices) {
      const [serviceNo, direction] = key.split('|');
      const route = await busRouteStops(serviceNo, direction);
      if (!route) continue;
      // The feeder bus must begin its run at a stop that serves a station.
      const board = route.stops
        .slice(0, 6)
        .map((stop, index) => ({ stop, index, access: railAccess.get(stop.code) }))
        .find((entry) => entry.access);
      if (!board) continue;

      for (const target of targets) {
        const alightIndex = route.stops.findIndex((stop) => stop.code === target.stop.code);
        if (alightIndex <= board.index) continue;
        if (from.code === board.access.station.code) continue;
        const rail = await buildRailSegments(from.code, board.access.station.code);
        if (!rail) continue;
        const busSegment = await buildBusSegment(route, board.index, alightIndex);
        if (!busSegment) continue;
        const candidate = makeCandidate([
          buildWalkSegment(origin, rail[0].from, { labelFrom: origin }),
          ...rail,
          buildWalkSegment(rail[rail.length - 1].to, busSegment.from, { labelTo: busSegment.from, transfer: true }),
          { ...busSegment, waitMinutes: busWaitMinutes(busSegment.peakFrequency) },
          buildWalkSegment(busSegment.to, destination, { labelTo: destination }),
        ]);
        if (candidate) candidates.push(candidate);
      }
    }
  }
  return candidates;
}
/** One bus-to-bus interchange, which covers many cross-town suburban trips. */
async function busThenBusCandidates({ origin, destination, originStops, destStops }) {
  const destByCode = new Map(destStops.map((entry) => [entry.stop.code, entry]));
  const destServiceKeys = new Set();
  for (const entry of destStops) {
    for (const service of await servicesAtStop(entry.stop.code)) {
      destServiceKeys.add(`${service.serviceNo}|${service.direction}`);
    }
  }
  if (destServiceKeys.size === 0) return [];

  const candidates = [];
  const used = new Set();

  for (const access of originStops) {
    const services = await servicesAtStop(access.stop.code);
    for (const service of services) {
      const first = await busRouteStops(service.serviceNo, service.direction);
      if (!first) continue;
      const boardIndex = first.stops.findIndex((stop) => stop.code === access.stop.code);
      if (boardIndex < 0) continue;

      const limit = Math.min(first.stops.length - 1, boardIndex + 50);
      for (let index = boardIndex + 1; index <= limit; index += 1) {
        const transferStop = first.stops[index];
        const rideOne = transferStop.distance - first.stops[boardIndex].distance;
        if (rideOne > 16000) break;
        const onward = await servicesAtStop(transferStop.code);
        for (const next of onward) {
          const nextKey = `${next.serviceNo}|${next.direction}`;
          if (!destServiceKeys.has(nextKey) || nextKey === `${service.serviceNo}|${service.direction}`) continue;
          const second = await busRouteStops(next.serviceNo, next.direction);
          if (!second) continue;
          const transferIndex = second.stops.findIndex((stop) => stop.code === transferStop.code);
          if (transferIndex < 0) continue;

          let best = null;
          const end = Math.min(second.stops.length - 1, transferIndex + 70);
          for (let cursor = transferIndex + 1; cursor <= end; cursor += 1) {
            const target = destByCode.get(second.stops[cursor].code);
            if (!target) continue;
            const meters = second.stops[cursor].distance - second.stops[transferIndex].distance;
            const minutes = busRideMinutes(meters > 0 ? meters : 0, cursor - transferIndex - 1);
            const total = minutes + target.distanceMeters / WALK_SPEED / 60;
            if (!best || total < best.total) best = { cursor, total };
          }
          if (!best) continue;
          const dedupe = `${service.serviceNo}|${service.direction}|${transferStop.code}|${nextKey}`;
          if (used.has(dedupe)) continue;
          used.add(dedupe);

          const legOne = await buildBusSegment(first, boardIndex, index);
          const legTwo = await buildBusSegment(second, transferIndex, best.cursor);
          if (!legOne || !legTwo) continue;
          const candidate = makeCandidate([
            buildWalkSegment(origin, legOne.from, { labelFrom: origin }),
            { ...legOne, waitMinutes: busWaitMinutes(legOne.peakFrequency) },
            buildWalkSegment(legOne.to, legTwo.from, { labelTo: legTwo.from, transfer: true }),
            { ...legTwo, waitMinutes: busWaitMinutes(legTwo.peakFrequency) },
            buildWalkSegment(legTwo.to, destination, { labelTo: destination }),
          ]);
          if (candidate) candidates.push(candidate);
        }
      }
    }
  }
  return candidates;
}

/* ------------------------------------------------------------------ *
 * Candidate -> route
 * ------------------------------------------------------------------ */

const iso = (ms) => new Date(Math.round(ms)).toISOString();

function modeMixLabel(types) {
  const hasRail = types.includes('mrt');
  const hasBus = types.includes('bus');
  if (hasRail && hasBus) return 'Bus + MRT';
  if (hasRail) return 'MRT / LRT';
  if (hasBus) return 'Bus';
  return 'Walking';
}

function legTitle(segment) {
  if (segment.kind === 'bus') {
    const towards = segment.to?.name ? formatStopName(segment.to.name) : null;
    return towards ? `Bus ${segment.serviceNo} towards ${towards}` : `Bus ${segment.serviceNo}`;
  }
  if (segment.kind === 'rail') {
    const meta = lineMeta(segment.line);
    return meta ? `${meta.short} · ${meta.name}` : 'MRT';
  }
  return 'Walk';
}

/**
 * Walks a candidate segment list, stamps real clock times onto each leg and
 * produces the same route object shape the OneMap path produces, so load
 * enrichment and ranking are identical for both planners.
 */
export function finalizeCandidate(candidate, { origin, destination, departureMs }) {
  let cursor = departureMs;
  const legs = [];
  let index = 0;

  for (const segment of candidate.segments) {
    if (segment.kind === 'walk' && segment.meters < 40) continue; // ignore kerb-side hops
    const waitMinutes = segment.waitMinutes || 0;
    const boardMs = cursor + waitMinutes * 60000;
    const arriveMs = boardMs + segment.minutes * 60000;
    const type = segment.kind === 'walk' ? 'walk' : segment.kind === 'rail' ? 'mrt' : 'bus';

    legs.push({
      id: `${candidate.signature}-${index}`,
      type,
      mode: type === 'walk' ? 'WALK' : type === 'mrt' ? 'SUBWAY' : 'BUS',
      routeLabel: legTitle(segment),
      serviceNo: segment.kind === 'bus' ? segment.serviceNo : null,
      line: segment.kind === 'rail' ? segment.line : null,
      lineName: segment.kind === 'rail' ? segment.lineName : null,
      from: point(segment.from, cursor),
      to: point(segment.to, arriveMs),
      departure: iso(cursor),
      arrival: iso(arriveMs),
      waitMinutes: round(waitMinutes),
      durationMinutes: Math.max(1, Math.round(segment.minutes)),
      distanceMeters: Math.round(segment.meters),
      intermediateStops: (segment.stops || []).slice(1, -1).map((stop) => point(stop)),
      geometry: coordinates(segment.stops || []),
      numStops: segment.kind === 'walk' ? 0 : segment.stopsRun + 1,
      operator: segment.operator || null,
      category: segment.category || null,
      frequencyLabel: segment.frequencyLabel || null,
      loopDescription: segment.loopDescription || null,
      destinationCode: segment.destinationCode || null,
      transferFromPrevious: Boolean(segment.transfer),
      load: null,
    });
    index += 1;
    cursor = arriveMs;
  }

  const rideLegs = legs.filter((leg) => leg.type === 'bus' || leg.type === 'mrt');
  if (rideLegs.length === 0) return null;

  const walkMinutes = legs.filter((leg) => leg.type === 'walk').reduce((sum, leg) => sum + leg.durationMinutes, 0);
  const transitMinutes = rideLegs.reduce((sum, leg) => sum + leg.durationMinutes, 0);
  const waitingMinutes = legs.reduce((sum, leg) => sum + (leg.waitMinutes || 0), 0);
  const totalMinutes = Math.max(1, Math.round((cursor - departureMs) / 60000));
  const rideMeters = rideLegs.reduce((sum, leg) => sum + leg.distanceMeters, 0);

  return {
    id: `lta-${candidate.signature.slice(0, 48)}`,
    signature: candidate.signature,
    ordinal: 0,
    type: modeMixLabel(rideLegs.map((leg) => (leg.type === 'mrt' ? 'mrt' : 'bus'))),
    modeChain: rideLegs.map((leg) => (leg.type === 'mrt' ? 'mrt' : 'bus')),
    routeCodes: [...new Set(rideLegs.map((leg) => (leg.type === 'bus' ? leg.serviceNo : leg.line)))],
    legs,
    startTime: iso(departureMs),
    endTime: iso(cursor),
    durationMinutes: totalMinutes,
    walkMinutes,
    transitMinutes,
    waitingMinutes,
    transfers: Math.max(0, rideLegs.length - 1),
    fare: estimateFare(rideMeters),
    fareEstimated: true,
    walkMeters: legs.filter((leg) => leg.type === 'walk').reduce((sum, leg) => sum + leg.distanceMeters, 0),
    originLabel: origin?.name || null,
    destinationLabel: destination?.name || null,
    source: 'lta',
    planner: PLANNER_NAME,
    load: null,
    recommended: false,
  };
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

/**
 * Plans journeys with LTA DataMall reference data only (no OneMap routing).
 *
 * @param {object} options
 * @param {{latitude:number,longitude:number,name?:string}} options.origin
 * @param {{latitude:number,longitude:number,name?:string}} options.destination
 * @param {Date}    [options.dateTime]
 * @param {string[]} [options.modes]  TRANSIT (mixed) / BUS / RAIL
 * @param {number}  [options.maxRoutes]
 * @returns {Promise<{ routes: any[], warnings: {mode: string, message: string}[], stats: object }>}
 */
export async function planJourneysLocally({
  origin,
  destination,
  dateTime = new Date(),
  modes = ['TRANSIT', 'BUS', 'RAIL'],
  maxRoutes = 6,
} = {}) {
  const started = Date.now();
  const warnings = [];
  const requested = new Set(modes);
  const allowBus = requested.has('TRANSIT') || requested.has('BUS');
  const allowRail = requested.has('TRANSIT') || requested.has('RAIL');
  if (!allowBus && !allowRail) {
    return { routes: [], warnings: [{ mode: 'local', message: 'No bus or rail mode selected.' }], stats: {} };
  }

  const access = await resolveAccess(origin, destination);
  if (access.originStops.length === 0 && access.originStations.length === 0) {
    warnings.push({ mode: 'local', message: 'No bus stop or MRT station was found near the starting point.' });
  }
  if (access.destStops.length === 0 && access.destStations.length === 0) {
    warnings.push({ mode: 'local', message: 'No bus stop or MRT station was found near the destination.' });
  }

  const tasks = [];
  if (allowRail) {
    tasks.push(railOnlyCandidates({ origin, destination, originStations: access.originStations, destStations: access.destStations }));
  }
  if (allowBus) {
    tasks.push(directBusCandidates({ origin, destination, originStops: access.originStops, destStops: access.destStops }));
    tasks.push(busThenBusCandidates({ origin, destination, originStops: access.originStops, destStops: access.destStops }));
  }
  if (allowBus && allowRail) {
    tasks.push(busThenRailCandidates({
      origin, destination, originStops: access.originStops, destStations: access.destStations,
    }));
    tasks.push(railThenBusCandidates({
      origin, destination, originStations: access.originStations, destStops: access.destStops,
    }));
  }

  const groups = await Promise.allSettled(tasks);
  const collected = [];
  groups.forEach((result, index) => {
    if (result.status === 'rejected') {
      warnings.push({ mode: 'local', message: `Candidate search ${index + 1} failed: ${result.reason?.message || 'unknown error'}` });
      return;
    }
    for (const candidate of result.value || []) if (candidate) collected.push(candidate);
  });

  const walkOnly = walkOnlyCandidate(origin, destination);
  if (walkOnly) collected.push(walkOnly);

  // Deduplicate, drop candidates that cannot beat the time budget, then keep a
  // diverse shortlist: the best few per mode mix, plus the overall fastest.
  const unique = new Map();
  for (const candidate of collected) {
    const minutes = candidateMinutes(candidate);
    if (minutes > MAX_TRIP_MINUTES) continue;
    const existing = unique.get(candidate.signature);
    if (!existing || minutes < existing.minutes) unique.set(candidate.signature, { candidate, minutes });
  }

  const ranked = [...unique.values()].sort((a, b) => a.minutes - b.minutes).slice(0, MAX_CANDIDATES);

  const perMix = new Map();
  const shortlist = [];
  for (const entry of ranked) {
    const mix = entry.candidate.segments
      .filter((segment) => segment.kind !== 'walk')
      .map((segment) => (segment.kind === 'rail' ? 'mrt' : 'bus'))
      .join('+');
    const count = perMix.get(mix) || 0;
    if (count >= 3) continue;
    perMix.set(mix, count + 1);
    shortlist.push(entry);
    if (shortlist.length >= Math.max(maxRoutes * 2, 8)) break;
  }

  const departureMs = dateTime.getTime();
  const routes = shortlist
    .map((entry) => finalizeCandidate(entry.candidate, { origin, destination, departureMs }))
    .filter(Boolean)
    .sort((a, b) => a.durationMinutes - b.durationMinutes)
    .slice(0, maxRoutes);

  routes.forEach((route, index) => { route.ordinal = index + 1; });

  return {
    routes,
    warnings,
    stats: {
      candidatesConsidered: collected.length,
      candidatesKept: ranked.length,
      originStops: access.originStops.length,
      destinationStops: access.destStops.length,
      originStations: access.originStations.map((station) => station.code),
      destinationStations: access.destStations.map((station) => station.code),
      elapsedMs: Date.now() - started,
    },
  };
}