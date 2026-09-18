import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client.js';

/** Debounces a rapidly changing value (used by the place search boxes). */
export function useDebouncedValue(value, delayMs = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/**
 * OneMap place search with debounce, request cancellation and stale-response
 * protection. Results are cached per query so repeating a search is instant.
 */
export function usePlaceSearch(query, { minLength = 2, limit = 8 } = {}) {
  const debounced = useDebouncedValue(query, 300);
  const [state, setState] = useState({ results: [], loading: false, error: null });
  const cacheRef = useRef(new Map());

  useEffect(() => {
    const term = (debounced || '').trim();
    if (term.length < minLength) {
      setState({ results: [], loading: false, error: null });
      return undefined;
    }

    const cacheKey = term.toLowerCase();
    const cached = cacheRef.current.get(cacheKey);
    if (cached) {
      setState({ results: cached, loading: false, error: null });
      return undefined;
    }

    const controller = new AbortController();
    let active = true;
    setState((previous) => ({ ...previous, loading: true, error: null }));

    api.searchPlaces(term, controller.signal)
      .then((payload) => {
        if (!active) return;
        const results = (payload?.results || []).slice(0, limit);
        cacheRef.current.set(cacheKey, results);
        setState({ results, loading: false, error: null });
      })
      .catch((error) => {
        if (!active || error.name === 'AbortError') return;
        setState({ results: [], loading: false, error });
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [debounced, limit, minLength]);

  return state;
}

/** Latest value that survives re-renders without re-triggering effects. */
export function useLatest(value) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}

/** Simple async loader with manual `reload`, used for line loads and alerts. */
export function useAsyncResource(loader, deps = [], { enabled = true } = {}) {
  const [state, setState] = useState({ data: null, loading: enabled, error: null });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setState({ data: null, loading: false, error: null });
      return undefined;
    }
    const controller = new AbortController();
    let active = true;
    setState((previous) => ({ ...previous, loading: true, error: null }));

    loader(controller.signal)
      .then((data) => {
        if (active) setState({ data, loading: false, error: null });
      })
      .catch((error) => {
        if (!active || error.name === 'AbortError') return;
        setState({ data: null, loading: false, error });
      });

    return () => {
      active = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce, enabled]);

  const reload = useMemo(() => () => setNonce((value) => value + 1), []);
  return { ...state, reload };
}