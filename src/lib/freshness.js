import { createContext, useContext } from 'react';

/**
 * How current the live data on screen is. Crowd levels, bus arrivals and
 * service alerts are only "live" while the app is online and the data is
 * recent; otherwise components dim them and label their age instead of
 * presenting them as current.
 */

/** Live crowd/arrival data older than this is treated as out of date even when online. */
export const STALE_AFTER_MS = 10 * 60 * 1000;

export const NOT_STALE = Object.freeze({
  stale: false, offline: false, asOfMs: null, ageLabel: '', asOfClock: '',
});

export const FreshnessContext = createContext(NOT_STALE);
export const useFreshness = () => useContext(FreshnessContext);

export function formatAge(ageMs) {
  const minutes = Math.floor(Math.max(0, ageMs) / 60000);
  if (minutes < 1) return 'under 1 min old';
  if (minutes < 60) return `${minutes} min old`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `${hours} h old` : `${hours} h ${rest} min old`;
  }
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} old`;
}

const clock = (ms) => new Date(ms).toLocaleTimeString('en-SG', { hour: '2-digit', minute: '2-digit', hour12: false });

/** `at 08:12` for today, `18 Sep at 08:12` otherwise - for "Saved ___." */
export function describeSavedAt(ms, nowMs = Date.now()) {
  const date = new Date(ms);
  if (date.toDateString() === new Date(nowMs).toDateString()) return `at ${clock(ms)}`;
  const day = date.toLocaleDateString('en-SG', { day: '2-digit', month: 'short' });
  return `${day} at ${clock(ms)}`;
}

export function computeFreshness({ asOfMs, offline, nowMs }) {
  if (!Number.isFinite(asOfMs)) return { ...NOT_STALE, offline: Boolean(offline) };
  const age = Math.max(0, nowMs - asOfMs);
  return {
    stale: Boolean(offline) || age > STALE_AFTER_MS,
    offline: Boolean(offline),
    asOfMs,
    ageLabel: formatAge(age),
    asOfClock: clock(asOfMs),
  };
}
