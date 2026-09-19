import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestJson } from '../lib/http.js';

// Fails if someone runs this file without the guard `npm test` preloads
// (`node --import ./server/tests/no-network.setup.js`), so the offline
// promise can't silently lapse.
test('the test run blocks all network access', async () => {
  await assert.rejects(() => fetch('https://datamall2.mytransport.sg/ltaodataservice/BusStops'), /Network access is not allowed in tests/);
});

test('the shared HTTP wrapper cannot reach the network from a test either', async () => {
  await assert.rejects(
    () => requestJson('https://www.onemap.gov.sg/api/common/elastic/search', { service: 'OneMap', timeoutMs: 500, backoffMs: [] }),
    /OneMap request failed|Network access is not allowed/,
  );
});
