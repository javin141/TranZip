import { useEffect, useState } from 'react';
import { api, subscribeReachability } from '../api/client.js';

const PROBE_INTERVAL_MS = 15000;

/**
 * "No signal" detection. `navigator.onLine === false` is trustworthy (the
 * device knows it has no connection) but `true` is not (a phone on a train
 * platform can have a Wi-Fi link and no data), so a failed request to the
 * TranZip server also counts as offline. Once offline, a cheap health check
 * runs every 15 seconds and on the browser's `online` event; the first
 * request that gets through - that one or any other - clears it.
 */
export function useConnectivity() {
  const [browserOnline, setBrowserOnline] = useState(
    () => typeof navigator === 'undefined' || navigator.onLine !== false,
  );
  const [unreachable, setUnreachable] = useState(false);

  useEffect(() => subscribeReachability((reachable) => {
    setUnreachable(!reachable);
    // A request that got through proves there is a connection, whatever navigator.onLine says.
    if (reachable) setBrowserOnline(true);
  }), []);

  useEffect(() => {
    const goOnline = () => {
      setBrowserOnline(true);
      api.health().catch(() => {});
    };
    const goOffline = () => setBrowserOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  const offline = !browserOnline || unreachable;

  useEffect(() => {
    if (!offline) return undefined;
    const timer = setInterval(() => {
      api.health().catch(() => {});
    }, PROBE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [offline]);

  return { offline, browserOnline, unreachable };
}
