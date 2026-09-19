import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { getWeatherNear } from '../lib/weatherClient.js';
import { weatherOverride } from '../data/test-overrides.js';

const PUNGGOL = { latitude: 1.4058, longitude: 103.9022 };

// In-process-only mutation of the shared DEV/TEST override, never the live
// dev/API server - safe to change and restore.
after(() => {
  weatherOverride.active = false;
});

test('getWeatherNear reflects the [SIMULATED] rain override when active', async () => {
  weatherOverride.active = true;
  weatherOverride.condition = 'rain';
  weatherOverride.rainfallMm = 4.5;
  weatherOverride.forecastText = 'Moderate Rain';

  const weather = await getWeatherNear(PUNGGOL);
  assert.equal(weather.simulated, true);
  assert.equal(weather.condition, 'rain');
  assert.equal(weather.isRaining, true);
  assert.equal(weather.isHot, false);
  assert.equal(weather.rainfallMm, 4.5);
});

test('getWeatherNear "hot" override sets isHot without needing rainfall', async () => {
  weatherOverride.active = true;
  weatherOverride.condition = 'hot';
  weatherOverride.temperatureC = 34;

  const weather = await getWeatherNear(PUNGGOL);
  assert.equal(weather.isHot, true);
  assert.equal(weather.isRaining, false);
  assert.equal(weather.rainfallMm, 0);
});

test('getWeatherNear "clear" override reports no adverse condition', async () => {
  weatherOverride.active = true;
  weatherOverride.condition = 'clear';

  const weather = await getWeatherNear(PUNGGOL);
  assert.equal(weather.isRaining, false);
  assert.equal(weather.isHot, false);
  assert.equal(weather.condition, 'clear');
});
