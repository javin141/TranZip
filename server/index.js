/**
 * TranZip - API proxy server.
 *
 * The browser never sees the LTA DataMall AccountKey or the OneMap token: the
 * React app talks to /api/* on this server, which adds the credentials, caches
 * upstream responses and normalises errors.
 */
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { config, integrationStatus } from './config.js';
import { placeRateLimit } from './middleware/placeRateLimit.js';
import { journeyRouter } from './routes/journey.js';
import { loadsRouter } from './routes/loads.js';
import { placesRouter } from './routes/places.js';
import { systemRouter } from './routes/system.js';
import { weatherRouter } from './routes/weather.js';
import { cacheStats } from './lib/cache.js';
import { catalogSummary, loadStationCatalog } from './lib/stationCatalog.js';
import { getBusServicesMap, getBusStopsMap } from './lib/ltaClient.js';
import { hasGoogleRoutesKey } from './lib/googleRoutesClient.js';
import { hasOneMapToken } from './lib/oneMapClient.js';
import { RAIL_LINES } from './lib/railLines.js';

const app = express();

app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '256kb' }));

/* ------------------------------------------------------------------ *
 * Platform metadata (basemap config, line catalogue, integration health)
 * ------------------------------------------------------------------ */

app.get('/api/meta', async (_req, res) => {
  const stations = await catalogSummary();
  res.json({
    app: { name: 'TranZip', city: 'Singapore' },
    integrations: {
      ...integrationStatus(),
      googleRoutesLive: hasGoogleRoutesKey(),
      oneMapTokenLive: hasOneMapToken(),
    },
    oneMap: {
      // Key-less basemap + search services documented at
      // https://www.onemap.gov.sg/apidocs/maps and /apidocs/search
      basemap: {
        provider: 'OneMap',
        tileStyles: config.oneMap.tileStyles,
        defaultStyle: 'Default',
        attribution: '&copy; OneMap &copy; Singapore Land Authority',
      },
    },
    railLines: Object.values(RAIL_LINES),
    stations,
    cache: cacheStats(),
  });
});

app.get('/api/health', async (_req, res) => {
  let busStops = null;
  try {
    busStops = (await getBusStopsMap()).size;
  } catch {
    busStops = null;
  }
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    integrations: integrationStatus(),
    referenceData: { busStops },
  });
});

/* ------------------------------------------------------------------ *
 * Feature routes
 * ------------------------------------------------------------------ */

app.use('/api/places', placeRateLimit, placesRouter);
app.use('/api/journey', journeyRouter);
app.use('/api/loads', loadsRouter);
app.use('/api/system', systemRouter);
app.use('/api/weather', weatherRouter);

/* ------------------------------------------------------------------ *
 * Static production build (npm run build && npm start)
 * ------------------------------------------------------------------ */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(projectRoot, 'dist');
if (existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

app.use((_req, res) => {
  res.status(404).json({ error: { message: 'Not found.' } });
});

// eslint-disable-next-line no-unused-vars
app.use((error, _req, res, _next) => {
  const status = error.statusCode
    || (error.kind === 'not_configured' ? 503 : error.status && error.status >= 400 && error.status < 600 ? error.status : 502);
  if (status >= 500) console.error('[api]', error.message);
  res.status(status).json({
    error: {
      message: error.message || 'Unexpected server error.',
      service: error.service || null,
      kind: error.kind || null,
      upstreamStatus: error.status || null,
    },
  });
});

/* ------------------------------------------------------------------ *
 * Start
 * ------------------------------------------------------------------ */

/** Warms the big static datasets so the first journey search is fast. */
async function warmCaches() {
  const tasks = [
    getBusStopsMap().catch(() => null),
    getBusServicesMap().catch(() => null),
    loadStationCatalog(),
  ];
  await Promise.all(tasks);
  const summary = await catalogSummary();
  console.log(
    `[startup] reference data ready - ${summary.stationCount} rail stations (${summary.codeCount} codes)`,
  );
}

// Vercel runs this app as a serverless function (see /api/index.js and
// vercel.json): no long-lived process, so the port listener is skipped there.
if (!process.env.VERCEL) {
  app.listen(config.port, async () => {
    const status = integrationStatus();
    console.log(`[startup] TranZip API listening on http://localhost:${config.port}`);
    console.log(`[startup] Google Routes API key: ${status.google.configured ? 'configured' : 'MISSING (set GOOGLE_MAPS_API_KEY)'}`);
    console.log(`[startup] LTA DataMall key: ${status.lta.configured ? 'configured' : 'MISSING (set LTA_ACCOUNT_KEY)'}`);
    console.log(`[startup] OneMap token: ${status.oneMapToken.configured ? 'configured' : 'MISSING (set ONEMAP_TOKEN)'}`
      + `${status.oneMapToken.refreshable ? ' + auto-renew enabled' : ''}`);
    warmCaches().catch((error) => console.warn('[startup] cache warm-up skipped:', error.message));
  });
}

export default app;