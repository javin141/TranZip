import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STALE_AFTER_MS, computeFreshness, describeSavedAt, formatAge } from './freshness.js';

const MIN = 60000;

test('ages read naturally from seconds to days', () => {
  assert.equal(formatAge(20 * 1000), 'under 1 min old');
  assert.equal(formatAge(14 * MIN), '14 min old');
  assert.equal(formatAge(60 * MIN), '1 h old');
  assert.equal(formatAge(75 * MIN), '1 h 15 min old');
  assert.equal(formatAge(26 * 60 * MIN), '1 day old');
  assert.equal(formatAge(50 * 60 * MIN), '2 days old');
  assert.equal(formatAge(-5000), 'under 1 min old');
});

test('offline data is always stale, however fresh', () => {
  const now = Date.now();
  const result = computeFreshness({ asOfMs: now - 5000, offline: true, nowMs: now });
  assert.equal(result.stale, true);
  assert.equal(result.offline, true);
});

test('online data goes stale only after the threshold', () => {
  const now = Date.now();
  assert.equal(computeFreshness({ asOfMs: now - (STALE_AFTER_MS - MIN), offline: false, nowMs: now }).stale, false);
  assert.equal(computeFreshness({ asOfMs: now - (STALE_AFTER_MS + MIN), offline: false, nowMs: now }).stale, true);
});

test('stale results carry an age label and the time the data was live', () => {
  const now = new Date(2026, 8, 19, 8, 26, 0).getTime();
  const asOf = new Date(2026, 8, 19, 8, 12, 0).getTime();
  const result = computeFreshness({ asOfMs: asOf, offline: true, nowMs: now });
  assert.equal(result.ageLabel, '14 min old');
  assert.equal(result.asOfClock, '08:12');
});

test('with nothing on screen there is nothing to mark stale', () => {
  const result = computeFreshness({ asOfMs: null, offline: true, nowMs: Date.now() });
  assert.equal(result.stale, false);
  assert.equal(result.offline, true);
});

test('"Saved ___" reads "at 08:12" today and includes the date on other days', () => {
  const now = new Date(2026, 8, 19, 12, 0, 0).getTime();
  assert.equal(describeSavedAt(new Date(2026, 8, 19, 8, 12).getTime(), now), 'at 08:12');
  // The month abbreviation varies by ICU version ("Sep" / "Sept"), so only pin the parts that don't.
  const yesterday = describeSavedAt(new Date(2026, 8, 18, 20, 6).getTime(), now);
  assert.match(yesterday, /^18 Sep\w* at 20:06$/);
});
