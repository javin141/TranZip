import { Router } from 'express';
import { cacheStats } from '../lib/cache.js';
import { catalogSummary } from '../lib/stationCatalog.js';
import { hasOneMapToken } from '../lib/oneMapClient.js';
import { config, integrationStatus } from '../config.js';
import { CROWD_API_LINES, RAIL_LINES } from '../lib/railLines.js';
import { LOAD_BANDS } from '../lib/loadModel.js';

export const systemRouter = Router();

/**
 * GET /api/system/health - what the app can actually do right now.
 * The UI uses this to explain missing credentials or an exhausted OneMap quota
 * instead of failing silently.
 */
systemRouter.get('/health', async (_req, res) => {
  const status = integrationStatus();
  let catalog = { stationCount: 0, lines: {} };
  try {
    catalog = await catalogSummary();
  } catch {
    // A missing catalog only degrades station names, never availability.
  }

  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    integrations: {
      lta: {
        ...status.lta,
        note: status.lta.configured
          ? 'Bus arrival load and MRT platform crowd APIs are enabled.'
          : 'Set LTA_ACCOUNT_KEY in .env to enable bus and MRT load data.',
      },
      oneMap: {
        ...status.oneMapToken,
        note: status.oneMapToken.configured || status.oneMapToken.refreshable
          ? 'Used for place search, routing and reverse geocoding.'
          : 'Set ONEMAP_TOKEN (or ONEMAP_EMAIL + ONEMAP_PASSWORD) in .env to enable routing.',
      },
    },
    integrationsLive: {
      oneMapTokenUsable: hasOneMapToken(),
      ltaConfigured: Boolean(config.lta.accountKey),
    },
    loadScale: Object.values(LOAD_BANDS).map((band) => ({
      key: band.key,
      label: band.label,
      tone: band.tone,
    })),
    railLines: Object.values(RAIL_LINES).map((line) => ({
      code: line.code,
      name: line.name,
      colour: line.colour,
      crowdApi: line.crowdApi,
      inCatalog: Boolean(catalog.lines?.[line.code]),
      stationCount: catalog.lines?.[line.code] || 0,
    })),
    crowdLines: CROWD_API_LINES,
    stationCatalog: catalog,
    caches: cacheStats(),
    recommendation: {
      algorithm: 'Lowest passenger load among routes within the time tolerance.',
      tolerancePercent: 10,
    },
  });
});