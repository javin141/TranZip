/**
 * Travel-time RANGES per leg and per route, from a few simple documented
 * rules. These are heuristics, not calibrated predictions: every constant
 * below is a round number chosen for plausibility, none was fitted to data.
 * The README's "Travel-time ranges" section mirrors this file.
 *
 * Every leg (and the route) gets `{ minMinutes, maxMinutes, typicalMinutes }`
 * in whole minutes, with minMinutes <= typicalMinutes <= maxMinutes.
 *
 *   Walk   typical +/-10%. If it is raining, the top end grows by a further
 *          15% of typical (slower steps, sheltering).
 *   Bus    waiting time + in-vehicle time.
 *            wait: from the next 2-3 LTA BusArrival estimates (NextBus,
 *                  NextBus2, NextBus3) the passenger can still catch -
 *                  min = the soonest, max = the latest of those.
 *            ride: typical +/-10%.
 *          Without usable live arrivals the wait is left at the planner's own
 *          figure and not widened (we have nothing to base a range on).
 *          (LTA's road speed bands would widen the ride when slow, but the
 *          app does not fetch them, so that rule is not applied.)
 *   Rail   platform crowd 'h' at the boarding station: +0 to +3 minutes (may
 *          miss a full train). Otherwise (or if the crowd is unknown)
 *          ride typical +/-5%. The planner's wait is not widened.
 */

import { parseTimeMs } from './format.js';

export const RANGE_RULES = {
  walkPct: 0.1,
  walkRainExtraPct: 0.15,
  busRidePct: 0.1,
  busArrivalsConsidered: 3,
  railPct: 0.05,
  railMissedTrainMaxMinutes: 3,
  // A bus is still catchable if it arrives up to this long before the
  // passenger reaches the stop (same allowance the load enrichment uses).
  boardingGraceMs: 60000,
};

const MS_PER_MINUTE = 60000;

const parseMs = parseTimeMs;

/**
 * When the passenger is expected to be standing at this leg's boarding stop:
 * the previous leg's arrival, else the leg's own departure less the wait the
 * planner attributed to it.
 */
function reachMsFor(route, index) {
  const previous = index > 0 ? parseMs(route.legs[index - 1]?.arrival) : null;
  if (previous !== null) return previous;
  const departure = parseMs(route.legs[index]?.departure);
  if (departure === null) return null;
  return departure - (route.legs[index].waitMinutes || 0) * MS_PER_MINUTE;
}

/** The wait the routing source already built into the route for this leg. */
function plannedWaitMinutes(route, index) {
  const leg = route.legs[index];
  if (typeof leg.waitMinutes === 'number') return leg.waitMinutes;
  const reach = reachMsFor(route, index);
  const departure = parseMs(leg.departure);
  if (reach === null || departure === null) return 0;
  return Math.max(0, (departure - reach) / MS_PER_MINUTE);
}

/** Waits (minutes, ascending) to the catchable live arrivals for a bus leg, or [] when none. */
export function liveBusWaits(route, index, { useForecast = false } = {}) {
  if (useForecast) return [];
  const leg = route.legs[index];
  const reach = reachMsFor(route, index);
  if (reach === null) return [];
  return (leg.load?.upcoming || [])
    .slice(0, RANGE_RULES.busArrivalsConsidered)
    .map((slot) => parseMs(slot.estimatedArrival))
    .filter((arrival) => arrival !== null && arrival >= reach - RANGE_RULES.boardingGraceMs)
    .map((arrival) => Math.max(0, (arrival - reach) / MS_PER_MINUTE))
    .sort((a, b) => a - b);
}

/** Unrounded { min, typical, max } plus a human-readable basis for one leg. */
export function legRangeRaw(route, index, { raining = false, rainSimulated = false, useForecast = false } = {}) {
  const leg = route.legs[index];
  const ride = leg.durationMinutes;

  if (leg.type === 'walk') {
    const extra = raining ? RANGE_RULES.walkRainExtraPct : 0;
    const rainNote = raining ? `, +${Math.round(extra * 100)}% at the top end because it is raining` : '';
    return {
      min: ride * (1 - RANGE_RULES.walkPct),
      typical: ride,
      max: ride * (1 + RANGE_RULES.walkPct + extra),
      basis: `Walking time ±${Math.round(RANGE_RULES.walkPct * 100)}%${rainNote}.`,
      simulated: raining && rainSimulated,
    };
  }

  if (leg.type === 'bus') {
    const ridePct = RANGE_RULES.busRidePct;
    const waits = liveBusWaits(route, index, { useForecast });
    if (waits.length > 0) {
      const count = waits.length;
      return {
        min: ride * (1 - ridePct) + waits[0],
        typical: ride + waits[0],
        max: ride * (1 + ridePct) + waits[count - 1],
        basis: `Wait ${Math.round(waits[0])}–${Math.round(waits[count - 1])} min from the next ${count} bus arrival${count === 1 ? '' : 's'} `
          + `(LTA estimates), plus ride ±${Math.round(ridePct * 100)}%.`,
        simulated: false,
      };
    }
    const wait = plannedWaitMinutes(route, index);
    return {
      min: ride * (1 - ridePct) + wait,
      typical: ride + wait,
      max: ride * (1 + ridePct) + wait,
      basis: `No live bus arrivals to base a wait range on, so the wait is not widened; ride ±${Math.round(ridePct * 100)}%.`,
      simulated: false,
    };
  }

  if (leg.type === 'mrt') {
    const wait = plannedWaitMinutes(route, index);
    const crowd = leg.load?.stations?.[0]?.crowdLevel;
    if (String(crowd || '').toLowerCase() === 'h') {
      return {
        min: ride + wait,
        typical: ride + wait,
        max: ride + wait + RANGE_RULES.railMissedTrainMaxMinutes,
        basis: `Boarding platform is crowded, so you may miss a train: +0 to +${RANGE_RULES.railMissedTrainMaxMinutes} min.`,
        simulated: false,
      };
    }
    return {
      min: ride * (1 - RANGE_RULES.railPct) + wait,
      typical: ride + wait,
      max: ride * (1 + RANGE_RULES.railPct) + wait,
      basis: `Ride ±${Math.round(RANGE_RULES.railPct * 100)}%.`,
      simulated: false,
    };
  }

  const wait = plannedWaitMinutes(route, index);
  return {
    min: ride + wait, typical: ride + wait, max: ride + wait, basis: 'No range rule for this kind of leg.', simulated: false,
  };
}

/** Rounds to whole minutes, keeping min <= typical <= max and min >= 1. */
function roundRange({ min, typical, max }) {
  const typicalMinutes = Math.max(1, Math.round(typical));
  const minMinutes = Math.min(typicalMinutes, Math.max(1, Math.round(min)));
  const maxMinutes = Math.max(typicalMinutes, Math.round(max));
  return { minMinutes, maxMinutes, typicalMinutes };
}

/**
 * Attaches `durationRange` to every leg and to the route. Call after live
 * load enrichment (bus arrivals and platform crowd are read from `leg.load`).
 *
 * The route's range is the sum of its legs' ranges plus whatever waiting the
 * routing source built in that isn't attributed to any single leg, so with no
 * live data it comes out at the planner's own figure.
 */
export function applyDurationRange(route, context = {}) {
  const options = {
    raining: Boolean(context.raining),
    rainSimulated: Boolean(context.rainSimulated),
    useForecast: Boolean(context.useForecast),
  };

  let plannedSum = 0;
  const totals = { min: 0, typical: 0, max: 0 };
  let simulated = false;

  route.legs.forEach((leg, index) => {
    const raw = legRangeRaw(route, index, options);
    leg.durationRange = {
      ...roundRange(raw),
      estimate: true,
      basis: raw.simulated ? `[SIMULATED] ${raw.basis}` : raw.basis,
      simulated: raw.simulated,
    };
    if (raw.simulated) simulated = true;
    totals.min += raw.min;
    totals.typical += raw.typical;
    totals.max += raw.max;
    plannedSum += leg.durationMinutes + (leg.type === 'walk' ? 0 : plannedWaitMinutes(route, index));
  });

  // Whatever the source's total contains beyond its legs' own durations and
  // waits (or, if its legs overshoot the total, the shortfall), so that with
  // no live data the typical equals the planner's figure exactly.
  const unattributed = route.durationMinutes - plannedSum;
  const raw = {
    min: totals.min + unattributed,
    typical: totals.typical + unattributed,
    max: totals.max + unattributed,
  };
  route.durationRange = {
    ...roundRange(raw),
    estimate: true,
    simulated,
    basis: 'Sum of each leg\'s range (bus waits from live arrivals, ride/walk percentages, crowded-platform allowance). '
      + 'A heuristic estimate, not a calibrated prediction.',
  };
  return route;
}
