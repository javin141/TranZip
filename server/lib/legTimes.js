/**
 * Fills in missing clock times on a route's legs from their neighbours.
 *
 * Google's Routes API reports real departure/arrival times for transit legs
 * but none for the walks between them, so those rows had no time to show. A
 * walk's times follow directly from what is known:
 *   - after a leg with a known arrival, it starts when that leg arrives and
 *     runs for its own duration (consecutive walks chain end to end);
 *   - before a leg with a known departure (e.g. the first walk to a station),
 *     it is worked backwards from that departure;
 *   - a walk-only route starts at the requested departure time.
 * A walk is never made to end after the next leg has already departed.
 *
 * These are estimates built from the leg durations, so every leg that gets a
 * time this way is flagged `timesInferred: true` and the UI prefixes it with
 * "~". Times the routing source supplied are never changed.
 */

import { parseTimeMs } from './format.js';

const MINUTE = 60000;

const iso = (ms) => new Date(ms).toISOString();

export function inferLegTimes(route, { fallbackStartMs = null } = {}) {
  const legs = route?.legs || [];
  if (legs.length === 0) return route;

  const duration = (leg) => Math.max(0, Number(leg.durationMinutes) || 0) * MINUTE;
  const dep = legs.map((leg) => parseTimeMs(leg.departure));
  const arr = legs.map((leg) => parseTimeMs(leg.arrival));
  const inferred = legs.map(() => false);

  // A leg with just one of its two times gets the other from its duration.
  legs.forEach((leg, index) => {
    if (dep[index] !== null && arr[index] === null) {
      arr[index] = dep[index] + duration(leg);
      inferred[index] = true;
    } else if (dep[index] === null && arr[index] !== null) {
      dep[index] = arr[index] - duration(leg);
      inferred[index] = true;
    }
  });

  let start = 0;
  while (start < legs.length) {
    if (dep[start] !== null) {
      start += 1;
      continue;
    }
    // A run of legs with no time at all: [start, end).
    let end = start;
    while (end < legs.length && dep[end] === null) end += 1;

    const before = start > 0 ? arr[start - 1] : null;
    const after = end < legs.length ? dep[end] : null;

    if (before !== null) {
      let cursor = before;
      for (let index = start; index < end; index += 1) {
        dep[index] = after !== null ? Math.min(cursor, after) : cursor;
        arr[index] = after !== null ? Math.min(cursor + duration(legs[index]), after) : cursor + duration(legs[index]);
        cursor += duration(legs[index]);
        inferred[index] = true;
      }
    } else if (after !== null) {
      let cursor = after;
      for (let index = end - 1; index >= start; index -= 1) {
        arr[index] = cursor;
        dep[index] = cursor - duration(legs[index]);
        cursor = dep[index];
        inferred[index] = true;
      }
    } else if (fallbackStartMs !== null) {
      let cursor = fallbackStartMs;
      for (let index = start; index < end; index += 1) {
        dep[index] = cursor;
        arr[index] = cursor + duration(legs[index]);
        cursor = arr[index];
        inferred[index] = true;
      }
    }
    start = end;
  }

  legs.forEach((leg, index) => {
    if (!inferred[index] || dep[index] === null || arr[index] === null) return;
    if (parseTimeMs(leg.departure) === null) leg.departure = iso(dep[index]);
    if (parseTimeMs(leg.arrival) === null) leg.arrival = iso(arr[index]);
    leg.timesInferred = true;
  });

  // Google's route-level times only span the transit legs; widen them to the whole journey.
  if (legs[0].timesInferred && legs[0].departure) route.startTime = legs[0].departure;
  const last = legs[legs.length - 1];
  if (last.timesInferred && last.arrival) route.endTime = last.arrival;
  return route;
}
