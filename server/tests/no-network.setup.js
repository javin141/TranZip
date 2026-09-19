/**
 * Preloaded by `npm test` (node --import): the whole suite runs offline, using
 * fixtures only. Any test - or any code a test reaches - that tries to call
 * `fetch` fails immediately with a clear message instead of quietly hitting
 * LTA, OneMap, Google or NEA (which would make the suite slow, flaky, and a
 * drain on real API quotas).
 */
globalThis.fetch = async (input) => {
  const target = typeof input === 'string' ? input : input?.url || String(input);
  throw new Error(`Network access is not allowed in tests: fetch(${target.slice(0, 80)}). Use a fixture instead.`);
};
