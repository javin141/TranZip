import 'dotenv/config';

const asInt = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  port: asInt(process.env.PORT, 8787),
  lta: {
    baseUrl: 'https://datamall2.mytransport.sg/ltaodataservice',
    accountKey: (process.env.LTA_ACCOUNT_KEY || '').trim(),
    pageSize: 500,
  },
  google: {
    baseUrl: 'https://routes.googleapis.com',
    apiKey: (process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_ROUTES_API_KEY || process.env.GOOGLE_API_KEY || '').trim(),
  },
  weather: {
    // NEA real-time readings via data.gov.sg - public, no API key required.
    baseUrl: 'https://api-open.data.gov.sg/v2/real-time/api',
  },
  oneMap: {
    baseUrl: 'https://www.onemap.gov.sg/api',
    token: (process.env.ONEMAP_TOKEN || '').trim(),
    email: (process.env.ONEMAP_EMAIL || '').trim(),
    password: process.env.ONEMAP_PASSWORD || '',
    // The public basemap tiles used by Leaflet are key-less; documented styles:
    tileStyles: ['Default', 'Original', 'Grey', 'GreyLite', 'Night', 'LandLot'],
  },
  ttl: {
    reference: asInt(process.env.CACHE_TTL_REFERENCE_MS, 24 * 60 * 60 * 1000),
    busArrival: asInt(process.env.CACHE_TTL_BUS_ARRIVAL_MS, 20000),
    crowd: asInt(process.env.CACHE_TTL_CROWD_MS, 60000),
    crowdForecast: asInt(process.env.CACHE_TTL_CROWD_FORECAST_MS, 30 * 60 * 1000),
    alerts: asInt(process.env.CACHE_TTL_ALERTS_MS, 60000),
    route: asInt(process.env.CACHE_TTL_ROUTE_MS, 45000),
    window: asInt(process.env.CACHE_TTL_WINDOW_MS, 45000),
    weather: asInt(process.env.CACHE_TTL_WEATHER_MS, 5 * 60 * 1000),
    placeSearch: 5 * 60 * 1000,
    stationName: 24 * 60 * 60 * 1000,
  },
  requestTimeoutMs: asInt(process.env.REQUEST_TIMEOUT_MS, 20000),
  // Gates the in-app "Demo: simulate NEL disruption" toggle entirely - the
  // toggle is never sent to the browser, and the activation endpoint refuses
  // to do anything, unless this is set. Off by default so a real deployment
  // never accidentally ships with a fake-disruption switch in the UI.
  demoMode: process.env.DEMO_MODE === '1',
};

export function integrationStatus() {
  const isGoogleKeyConfigured = Boolean(
    config.google.apiKey
    && config.google.apiKey !== 'YOUR_API_KEY'
    && config.google.apiKey !== 'YOUR_GOOGLE_MAPS_API_KEY',
  );

  return {
    lta: { configured: Boolean(config.lta.accountKey), label: 'LTA DataMall' },
    google: {
      configured: isGoogleKeyConfigured,
      label: 'Google Routes',
    },
    oneMapToken: {
      configured: Boolean(config.oneMap.token),
      refreshable: Boolean(config.oneMap.email && config.oneMap.password),
      label: 'OneMap',
    },
  };
}
