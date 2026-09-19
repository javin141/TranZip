import { Router } from 'express';
import {
  getBusArrival,
  getBusServiceInfo,
  getBusServicesMap,
  getBusStop,
  getCrowdForecast,
  getCrowdRealTime,
} from '../lib/ltaClient.js';
import { getTrainServiceAlertsForDisplay } from '../lib/disruptions.js';
import { bandFromBusLoad, bandFromCrowdLevel, busTypeInfo, isLiveWindow } from '../lib/loadModel.js';
import { RAIL_LINES, isStationCode, lineForStationCode, lineMeta } from '../lib/railLines.js';
import { lineStationCodes, loadStationCatalog, stationDetails, stationNameMap } from '../lib/stationCatalog.js';

export const loadsRouter = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readLine(rawLine) {
  const line = String(rawLine || '').toUpperCase();
  if (!lineMeta(line)) {
    const error = new Error(`Unknown train line "${rawLine}". Known codes: ${Object.keys(RAIL_LINES).join(', ')}.`);
    error.statusCode = 400;
    throw error;
  }
  return line;
}

/* ------------------------------------------------------------------ *
 * MRT / LRT platform crowd density
 * ------------------------------------------------------------------ */

/** Live platform crowd level for every station on a line, plus its 30-minute forecast. */
loadsRouter.get('/lines/:line', async (req, res, next) => {
  try {
    const line = readLine(req.params.line);
    const [realtime, forecast] = await Promise.all([
      getCrowdRealTime(line),
      getCrowdForecast(line).catch(() => null),
    ]);

    const stationCodes = await lineStationCodes(line);
    const codes = stationCodes.length > 0
      ? stationCodes
      : realtime.stations.map((station) => station.code);

    const names = await stationNameMap();
    const nameFor = (code) => names.get(code) || null;

    const realtimeByCode = new Map(realtime.stations.map((station) => [station.code, station]));
    const forecastByCode = new Map((forecast?.stations || []).map((station) => [station.code, station]));

    const stations = codes.map((code) => {
      const live = realtimeByCode.get(code) || null;
      const ahead = forecastByCode.get(code) || null;
      return {
        code,
        name: nameFor(code) || null,
        band: bandFromCrowdLevel(live?.crowdLevel),
        crowdLevel: live?.crowdLevel || null,
        window: live ? { start: live.startTime, end: live.endTime } : null,
        forecast: ahead
          ? [...ahead.intervals]
            .reverse()
            .map((interval) => ({ start: interval.start, band: bandFromCrowdLevel(interval.crowdLevel) }))
            .slice(0, 8)
          : [],
      };
    });

    return res.json({
      line,
      lineName: lineMeta(line).name,
      lineColour: lineMeta(line).colour,
      fetchedAt: realtime.fetchedAt,
      window: realtime.window,
      forecastDate: forecast?.date || null,
      source: forecast ? 'LTA DataMall /PCDRealTime + /PCDForecast' : 'LTA DataMall /PCDRealTime',
      stationCount: stations.length,
      stations,
    });
  } catch (error) {
    return next(error);
  }
});
/**
 * GET /api/loads/station/:code - crowd level at one station: the live 10-minute
 * window, the timeline for the rest of the day, and interchange information.
 *
 * `:code` accepts a station code (`NS17`) or a UUID station id from the LTA
 * station dataset.
 */
loadsRouter.get('/station/:code', async (req, res, next) => {
  try {
    const raw = String(req.params.code || '');
    const catalog = await loadStationCatalog();

    let stationCode = null;
    let stationId = null;
    if (isStationCode(raw)) stationCode = raw.toUpperCase();
    else if (UUID_RE.test(raw)) {
      stationId = raw.toLowerCase();
      stationCode = catalog.byId?.[stationId]?.code || null;
    }

    if (!stationCode) {
      const error = new Error(
        'Provide an MRT/LRT station code such as NS17, or a station id present in the LTA station dataset.',
      );
      error.statusCode = 400;
      throw error;
    }

    const line = lineForStationCode(stationCode);
    const [realtime, forecast] = await Promise.all([
      getCrowdRealTime(line),
      getCrowdForecast(line).catch(() => null),
    ]);

    const live = realtime.stations.find((station) => station.code === stationCode) || null;
    const ahead = (forecast?.stations || []).find((station) => station.code === stationCode) || null;
    const details = await stationDetails(stationCode);
    const catalogEntry = catalog.byId?.[stationId] || null;

    const now = Date.now();
    const timeline = (ahead?.intervals || []).map((interval) => {
      const start = Date.parse(interval.start);
      return {
        start: interval.start,
        band: bandFromCrowdLevel(interval.crowdLevel),
        isCurrent: Number.isFinite(start) && now >= start && now < start + 30 * 60 * 1000,
      };
    });

    // Anchor the timeline on the current interval rather than the start of day.
    const currentIndex = timeline.findIndex((entry) => entry.isCurrent);
    const upcoming = currentIndex >= 0
      ? timeline.slice(currentIndex, currentIndex + 8)
      : timeline.slice(-8);

    return res.json({
      stationCode,
      stationId: stationId || catalogEntry?.id || null,
      name: details?.name || catalogEntry?.name || stationCode,
      lines: details?.lines || [line],
      interchangeWith: details?.codes?.filter((code) => code !== stationCode) || [],
      line,
      fetchedAt: realtime.fetchedAt,
      source: 'LTA DataMall /PCDRealTime + /PCDForecast',
      live: live
        ? {
          band: bandFromCrowdLevel(live.crowdLevel),
          crowdLevel: live.crowdLevel,
          window: { start: live.startTime, end: live.endTime },
        }
        : { band: bandFromCrowdLevel(null), crowdLevel: null, window: null },
      forecastDate: forecast?.date || null,
      upcoming,
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * GET /api/loads/alerts - whole-network MRT/LRT service alerts. Reflects the
 * demo disruption toggle when it's on (`simulated: true`), so this banner
 * never disagrees with what the journey planner is actually doing.
 */
loadsRouter.get('/alerts', async (_req, res, next) => {
  try {
    const alerts = await getTrainServiceAlertsForDisplay();
    return res.json(alerts);
  } catch (error) {
    return next(error);
  }
});
/* ------------------------------------------------------------------ *
 * Bus arrivals & load
 * ------------------------------------------------------------------ */

const arrivalSlot = (entry, now) => {
  if (!entry || !entry.EstimatedArrival) return null;
  const band = bandFromBusLoad(entry.Load);
  const typeInfo = busTypeInfo(entry.Type);
  return {
    estimatedArrival: entry.EstimatedArrival,
    minutesUntil: Math.max(0, Math.round((Date.parse(entry.EstimatedArrival) - now) / 60000)),
    monitored: Number(entry.Monitored) === 1,
    band,
    loadCode: String(entry.Load || '') || null,
    live: Number(entry.Monitored) === 1 && isLiveWindow(entry.EstimatedArrival, 30, now),
    busType: entry.Type || null,
    busTypeLabel: typeInfo?.label || null,
    approximateCapacity: typeInfo?.capacity || null,
    visitNumber: entry.VisitNumber || null,
    originCode: entry.OriginCode || null,
    destinationCode: entry.DestinationCode || null,
    wheelchairAccessible: String(entry.Feature || '').includes('WAB'),
  };
};

/**
 * GET /api/loads/bus-stop/:code - every service calling at a stop with its live
 * load band (seats available / standing available / limited standing).
 */
loadsRouter.get('/bus-stop/:code', async (req, res, next) => {
  try {
    const code = String(req.params.code || '').trim();
    const [arrival, stop, servicesMap] = await Promise.all([
      getBusArrival(code),
      getBusStop(code).catch(() => null),
      getBusServicesMap().catch(() => null),
    ]);

    const now = Date.now();
    const services = await Promise.all(arrival.services.map(async (service) => {
      const info = await getBusServiceInfo(service.ServiceNo).catch(() => null);
      return {
        serviceNo: service.ServiceNo,
        operator: service.Operator,
        category: info?.category || null,
        loopDescription: info?.loopDescription || null,
        frequency: info?.frequency || null,
        frequencyLabel: info?.frequencyLabel || null,
        destinationCode: info?.destinationCode || null,
        originCode: info?.originCode || null,
        arrivals: ['NextBus', 'NextBus2', 'NextBus3']
          .map((slot) => arrivalSlot(service[slot], now))
          .filter(Boolean),
      };
    }));

    services.sort((a, b) => a.serviceNo.localeCompare(b.serviceNo, 'en', { numeric: true }));

    return res.json({
      busStopCode: code,
      stop: stop
        ? {
          code: stop.code,
          name: stop.name,
          road: stop.road,
          latitude: stop.latitude,
          longitude: stop.longitude,
        }
        : null,
      fetchedAt: arrival.fetchedAt,
      source: 'LTA DataMall /v3/BusArrival',
      serviceCount: services.length,
      services,
    });
  } catch (error) {
    return next(error);
  }
});