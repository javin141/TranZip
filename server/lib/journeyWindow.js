/**
 * "Today" advice for a saved usual trip: plans the recommended route at a few
 * departure times across the user's flexible window and turns the comparison
 * into one line of advice - fine as usual, leave later for a quieter ride, or
 * a live disruption to route around.
 *
 * Bounded on purpose (see the constants below): at most 5 departure times,
 * one TRANSIT routing query each, a hard cap on real upstream calls per
 * request, and the whole result cached for 45 seconds.
 *
 * Crowding for departures more than 15 minutes ahead comes from LTA's
 * PCDForecast (that switch lives in `planJourneyRoutes`); anything sooner uses
 * the live PCDRealTime reading. LTA publishes no forecast for bus load, so a
 * bus leg for a future departure is "no data" rather than a guess.
 */

import { config } from '../config.js';
import { createCache, memoize } from './cache.js';
import { runWithCallBudget } from './callBudget.js';
import { getDemoDisruptionActive } from './disruptions.js';
import { DEFAULT_TOLERANCE, planJourneyRoutes } from './journeyPlanner.js';
import { parseTimeMs } from './format.js';
import { lineMeta } from './railLines.js';

export const WINDOW_LIMITS = {
  stepMinutes: 15,
  maxCandidates: 5, // usual + up to four later departures => a 60 minute window
  maxFlexibilityMinutes: 60,
  maxUpstreamCalls: 40,
  // A departure time this far in the past still counts as "now".
  pastToleranceMs: 2 * 60 * 1000,
  // Later departures closer than this to the first one add nothing.
  minGapMs: 5 * 60 * 1000,
  // Mirrors the switch to PCDForecast in planJourneyRoutes.
  forecastAfterMs: 15 * 60 * 1000,
};

const CACHE = createCache('journey:window');
const MINUTE = 60000;

const CLOCK = new Intl.DateTimeFormat('en-SG', {
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Singapore',
});
/** `08:30` in Singapore time. */
export const clockSg = (value) => CLOCK.format(typeof value === 'number' ? value : new Date(value));

const BAND_ORDER = { seats: 0, standing: 1, limited: 2 };
const BAND_WORDS = { seats: 'seats', standing: 'standing', limited: 'limited standing' };

/* ------------------------------------------------------------------ *
 * Candidate departure times
 * ------------------------------------------------------------------ */

/**
 * The departure times to plan: the usual time, then every 15 minutes up to
 * the flexibility, capped at 5 in total. Times already in the past are
 * dropped, except that a usual time that has passed becomes "leave now".
 *
 * @returns {{ status: 'ok'|'passed', times: {ms:number,isUsual:boolean,isNow:boolean}[] }}
 */
export function buildCandidateTimes({ usualMs, flexibilityMinutes, nowMs }) {
  const steps = Math.min(
    WINDOW_LIMITS.maxCandidates - 1,
    Math.max(0, Math.floor(flexibilityMinutes / WINDOW_LIMITS.stepMinutes)),
  );
  const slots = Array.from({ length: steps + 1 }, (_, k) => usualMs + k * WINDOW_LIMITS.stepMinutes * MINUTE);

  if (slots[slots.length - 1] < nowMs - WINDOW_LIMITS.pastToleranceMs) return { status: 'passed', times: [] };

  const usualPassed = usualMs < nowMs;
  const firstMs = usualPassed ? nowMs : usualMs;
  const times = [{ ms: firstMs, isUsual: true, isNow: usualPassed }];
  for (const slot of slots.slice(1)) {
    if (slot >= nowMs && slot - firstMs >= WINDOW_LIMITS.minGapMs) {
      times.push({ ms: slot, isUsual: false, isNow: false });
    }
  }
  return { status: 'ok', times };
}

export function normaliseFlexibility(value) {
  const minutes = Math.round(Number(value) || 0);
  return Math.min(Math.max(minutes, 0), WINDOW_LIMITS.maxFlexibilityMinutes);
}

/* ------------------------------------------------------------------ *
 * Per-candidate summary
 * ------------------------------------------------------------------ */

/** `Bus 666 + EWL + CCL` for a route's vehicle legs. */
export function describeRoute(route) {
  const labels = (route?.legs || [])
    .filter((leg) => leg.type === 'bus' || leg.type === 'mrt')
    .map((leg) => (leg.type === 'bus' ? `Bus ${leg.serviceNo}` : (lineMeta(leg.line)?.short || leg.line || 'MRT')));
  return [...new Set(labels)].join(' + ') || 'Walk';
}

function affectedLineNames(route) {
  const names = (route?.legs || []).filter((leg) => leg.affected).map((leg) => lineMeta(leg.line)?.short || leg.line);
  return [...new Set(names.filter(Boolean))];
}

/** Boils one full plan response down to what the advice needs. */
export function summarizeCandidate(plan, time, nowMs) {
  const base = {
    departAt: new Date(time.ms).toISOString(),
    isUsual: time.isUsual,
    isNow: time.isNow,
    usedForecast: time.ms - nowMs > WINDOW_LIMITS.forecastAfterMs,
  };
  const route = plan?.routes?.find((entry) => entry.recommended) || plan?.routes?.[0] || null;
  if (!route) return { ...base, available: false };

  const band = route.load?.band;
  const baseline = plan.baselineRoute || null;
  const endMs = parseTimeMs(route.endTime);
  const disruption = plan.disruption || {};
  const affectsTrip = Boolean(disruption.active && (
    baseline?.disrupted || route.disrupted || route.rerouted || plan.recommendation?.disruptionAvoided
  ));
  const lines = affectedLineNames(baseline).length > 0 ? affectedLineNames(baseline) : affectedLineNames(route);

  return {
    ...base,
    available: true,
    routeId: route.id,
    signature: route.signature || null,
    routeLabel: describeRoute(route),
    type: route.type,
    transfers: route.transfers,
    durationMinutes: route.durationMinutes,
    durationRange: route.durationRange
      ? {
        minMinutes: route.durationRange.minMinutes,
        maxMinutes: route.durationRange.maxMinutes,
        typicalMinutes: route.durationRange.typicalMinutes,
      }
      : null,
    arriveAt: new Date(endMs ?? time.ms + route.durationMinutes * MINUTE).toISOString(),
    load: {
      key: band?.key || 'unknown',
      label: band?.label || 'No live data',
      short: band?.short || 'Unknown',
    },
    disrupted: Boolean(route.disrupted),
    rerouted: Boolean(route.rerouted),
    freeTransferNote: route.freeTransferNote || baseline?.freeTransferNote || null,
    disruption: {
      active: Boolean(disruption.active),
      simulated: Boolean(disruption.simulated),
      affectsTrip,
      lines: lines.length > 0
        ? lines
        : (disruption.lines || []).map((code) => lineMeta(code)?.short || code),
    },
    baseline: baseline
      ? {
        routeLabel: describeRoute(baseline),
        durationMinutes: baseline.durationMinutes,
        disrupted: Boolean(baseline.disrupted),
      }
      : null,
    deltaVsUsualMinutes: baseline ? route.durationMinutes - baseline.durationMinutes : null,
  };
}

/* ------------------------------------------------------------------ *
 * Advice
 * ------------------------------------------------------------------ */

const signed = (minutes) => (minutes > 0 ? `+${minutes} min` : minutes === 0 ? 'same trip time' : `−${Math.abs(minutes)} min`);
const rangeText = (range, fallback) => (range && range.minMinutes !== range.maxMinutes
  ? `${range.minMinutes}–${range.maxMinutes} min`
  : `${fallback} min`);
const joinNames = (names) => (names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

function adviceFor(candidate, fields) {
  return {
    departAt: candidate?.departAt ?? null,
    signature: candidate?.signature ?? null,
    routeLabel: candidate?.routeLabel ?? null,
    simulated: false,
    ...fields,
  };
}

/**
 * One line of advice from the planned candidates (`candidates[0]` is the
 * usual departure, or "now" if the usual time has passed). Only `disruption`
 * and `crowded` are `prominent`: everything else says the usual trip is fine
 * (or that nothing better exists), so it stays quiet.
 */
export function buildAdvice({ candidates, flexibilityMinutes = 0 }) {
  const usual = candidates[0];
  if (!usual || !usual.available) {
    return adviceFor(usual, {
      kind: 'unavailable',
      prominent: false,
      headline: "Couldn't check your usual trip right now.",
      reason: 'No route could be planned for your saved trip at the moment. Try again shortly, or plan it in the planner below.',
    });
  }

  const usualPhrase = usual.isNow ? 'Leaving now' : `Your usual ${clockSg(usual.departAt)}`;
  const checked = candidates.filter((candidate) => candidate.available);
  const checkedText = `Checked ${checked.length} departure time${checked.length === 1 ? '' : 's'}`
    + (checked.length > 1 ? ` (${clockSg(checked[0].departAt)}–${clockSg(checked[checked.length - 1].departAt)})` : '')
    + '.';
  const basis = usual.usedForecast
    ? "Crowding is from LTA's 30-minute crowd forecast."
    : 'Crowding is from live LTA readings.';

  // 1. A live disruption on the trip outranks any crowding comparison.
  if (usual.disruption.active && usual.disruption.affectsTrip) {
    const prefix = usual.disruption.simulated ? '[SIMULATED] ' : '';
    const lines = joinNames(usual.disruption.lines) || 'Rail';
    if (usual.disrupted) {
      return adviceFor(usual, {
        kind: 'disruption',
        prominent: true,
        simulated: usual.disruption.simulated,
        headline: `${prefix}${lines} disrupted. Every route to your destination runs through it - expect delays.`,
        reason: `No route avoids the affected stretch. ${usual.routeLabel} keeps it shortest (${usual.durationMinutes} min).`
          + `${usual.freeTransferNote ? ` ${usual.freeTransferNote}.` : ''}`,
      });
    }
    const when = usual.isNow ? 'now' : `at ${clockSg(usual.departAt)}`;
    const delta = usual.deltaVsUsualMinutes;
    return adviceFor(usual, {
      kind: 'disruption',
      prominent: true,
      simulated: usual.disruption.simulated,
      headline: `${prefix}${lines} disrupted. Take ${usual.routeLabel} ${when}${delta === null ? '' : `, ${signed(delta)}`}.`,
      reason: `Your usual route${usual.baseline ? ` (${usual.baseline.routeLabel}, ${usual.baseline.durationMinutes} min)` : ''} runs through the disruption. `
        + `${usual.routeLabel} avoids it and takes ${usual.durationMinutes} min.`
        + `${usual.freeTransferNote ? ` ${usual.freeTransferNote}.` : ''}`,
    });
  }

  // 2. Crowding: is a later departure in the window in a quieter band?
  const usualBand = BAND_ORDER[usual.load.key];
  if (usualBand === undefined) {
    return adviceFor(usual, {
      kind: 'unknown',
      prominent: false,
      headline: `${usualPhrase}: no live crowd data for this route right now, so there's no crowding advice.`,
      reason: `${usual.routeLabel}, ${rangeText(usual.durationRange, usual.durationMinutes)} (estimate). ${checkedText}`,
    });
  }

  const quieter = candidates
    .slice(1)
    .filter((candidate) => candidate.available && !candidate.disrupted && BAND_ORDER[candidate.load.key] !== undefined
      && BAND_ORDER[candidate.load.key] < usualBand)
    .sort((a, b) => BAND_ORDER[a.load.key] - BAND_ORDER[b.load.key] || Date.parse(a.departAt) - Date.parse(b.departAt));

  if (quieter.length > 0) {
    const best = quieter[0];
    const laterMinutes = Math.round((Date.parse(best.departAt) - Date.parse(usual.departAt)) / MINUTE);
    return adviceFor(best, {
      kind: 'crowded',
      prominent: true,
      headline: `Leave ${clockSg(best.departAt)} instead: quieter (${BAND_WORDS[usual.load.key]} → ${BAND_WORDS[best.load.key]}), `
        + `${signed(best.durationMinutes - usual.durationMinutes)}.`,
      reason: `${usualPhrase} is ${usual.load.label.toLowerCase()} on ${usual.routeLabel}; ${clockSg(best.departAt)} is ${best.load.label.toLowerCase()} on ${best.routeLabel}. `
        + `Leaving ${laterMinutes} min later means arriving about ${clockSg(best.arriveAt)} instead of ${clockSg(usual.arriveAt)}. `
        + `${best.usedForecast ? "Later departures use LTA's 30-minute crowd forecast. " : ''}${checkedText}`,
    });
  }

  if (usualBand === BAND_ORDER.limited) {
    return adviceFor(usual, {
      kind: 'busy',
      prominent: false,
      headline: `${usualPhrase} looks busy: limited standing likely.`
        + `${checked.length > 1 ? ' Nothing quieter is forecast within your window.' : ' You have not allowed any flexibility, so there is no quieter time to suggest.'}`,
      reason: `${usual.routeLabel}, ${rangeText(usual.durationRange, usual.durationMinutes)} (estimate). ${basis} ${checkedText}`,
    });
  }

  return adviceFor(usual, {
    kind: 'fine',
    prominent: false,
    headline: `${usualPhrase} looks fine: ${usual.load.key === 'seats' ? 'seats' : 'standing room'} likely.`,
    reason: `${usual.routeLabel}, ${rangeText(usual.durationRange, usual.durationMinutes)} (estimate). ${basis} ${checkedText}`,
  });
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

async function computeWindow({ origin, destination, usualMs, flexibilityMinutes, tolerance, avoidWeather, nowMs }) {
  const usual = { departAt: new Date(usualMs).toISOString(), label: clockSg(usualMs) };
  const { status, times } = buildCandidateTimes({ usualMs, flexibilityMinutes, nowMs });
  const meta = {
    generatedAt: new Date().toISOString(),
    timezone: 'Asia/Singapore',
    usual,
    flexibilityMinutes,
    cacheTtlMs: config.ttl.window,
  };

  if (status === 'passed') {
    return {
      ...meta,
      status: 'passed',
      candidates: [],
      advice: {
        kind: 'passed',
        prominent: false,
        simulated: false,
        departAt: null,
        signature: null,
        routeLabel: null,
        headline: `Today's window for your usual ${usual.label} trip has passed.`,
        reason: "TranZip's advice covers the rest of today only: LTA's crowd forecast doesn't reach tomorrow.",
      },
      upstream: { maxCalls: WINDOW_LIMITS.maxUpstreamCalls, usedCalls: 0, truncated: false },
    };
  }

  const planOne = async (time) => {
    try {
      const plan = await planJourneyRoutes({
        origin,
        destination,
        dateTime: new Date(time.ms),
        tolerance,
        modes: ['TRANSIT'],
        maxRoutes: 4,
        includeServiceInfo: false,
        includeStationInfo: false,
        avoidWeather,
      });
      return summarizeCandidate(plan, time, nowMs);
    } catch (error) {
      console.warn(`[window] planning ${new Date(time.ms).toISOString()} failed: ${error.message}`);
      return {
        departAt: new Date(time.ms).toISOString(), isUsual: time.isUsual, isNow: time.isNow, available: false,
      };
    }
  };

  const { value: candidates, used, max, exhausted } = await runWithCallBudget(WINDOW_LIMITS.maxUpstreamCalls, async () => {
    // The usual time first and alone, so the shared caches (disruptions,
    // weather, bus arrivals, crowd) are warm for the rest, which then run together.
    const first = await planOne(times[0]);
    const rest = await Promise.all(times.slice(1).map(planOne));
    return [first, ...rest];
  });

  return {
    ...meta,
    status: candidates[0]?.available ? 'ok' : 'unavailable',
    candidates,
    advice: buildAdvice({ candidates, flexibilityMinutes }),
    upstream: { maxCalls: max, usedCalls: used, truncated: exhausted },
  };
}

/**
 * @param {object} input
 * @param {{latitude:number,longitude:number,name?:string}} input.origin
 * @param {{latitude:number,longitude:number,name?:string}} input.destination
 * @param {Date}    input.usualDepartAt         today's usual departure time
 * @param {number}  [input.flexibilityMinutes]  0-60, how much later they can leave
 */
export function planJourneyWindow({
  origin,
  destination,
  usualDepartAt,
  flexibilityMinutes = 0,
  tolerance = DEFAULT_TOLERANCE,
  avoidWeather = false,
  nowMs = Date.now(),
}) {
  const flex = normaliseFlexibility(flexibilityMinutes);
  const usualMs = usualDepartAt.getTime();
  const point = (p) => `${p.latitude.toFixed(5)},${p.longitude.toFixed(5)}`;
  // The demo disruption switch is part of the key so flipping it shows up
  // immediately instead of after the 45 s cache expires.
  const key = [
    point(origin), point(destination), Math.floor(usualMs / MINUTE), flex, tolerance, avoidWeather,
    getDemoDisruptionActive(),
  ].join('|');

  return memoize({
    cache: CACHE,
    key,
    ttlMs: config.ttl.window,
    loader: () => computeWindow({ origin, destination, usualMs, flexibilityMinutes: flex, tolerance, avoidWeather, nowMs }),
  });
}
