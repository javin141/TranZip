import { useEffect, useMemo } from 'react';
import { api } from '../api/client.js';
import { usualDepartureToday } from '../lib/usualTrip.js';
import { useAsyncResource } from './useJourney.js';

const REFRESH_MS = 5 * 60 * 1000;
const STALE_AFTER_MS = 2 * 60 * 1000;

/**
 * Fetches "Today" advice for the saved trip when the app opens, again every
 * 5 minutes while it stays open, and whenever the tab comes back into view
 * after being stale. There is no background push: nothing here runs unless
 * this page is open.
 */
export function useTodayAdvice(trip) {
  const tripKey = useMemo(() => (trip
    ? JSON.stringify([trip.origin.latitude, trip.origin.longitude, trip.destination.latitude, trip.destination.longitude, trip.departTime, trip.flexibilityMinutes])
    : ''), [trip]);

  const resource = useAsyncResource(
    (signal) => api.journeyWindow({
      origin: trip.origin,
      destination: trip.destination,
      usualDepartAt: usualDepartureToday(trip.departTime).toISOString(),
      flexibilityMinutes: trip.flexibilityMinutes,
    }, signal),
    [tripKey],
    { enabled: Boolean(trip) },
  );

  const { reload } = resource;
  const generatedAt = resource.data?.generatedAt;

  useEffect(() => {
    if (!trip) return undefined;
    const timer = setInterval(reload, REFRESH_MS);
    return () => clearInterval(timer);
  }, [trip, reload]);

  useEffect(() => {
    if (!trip) return undefined;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      const age = generatedAt ? Date.now() - Date.parse(generatedAt) : Infinity;
      if (age > STALE_AFTER_MS) reload();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [trip, reload, generatedAt]);

  return resource;
}
