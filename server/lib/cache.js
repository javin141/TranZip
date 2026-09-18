/**
 * Small in-memory TTL cache with single-flight de-duplication.
 *
 * Why: LTA DataMall reference data (bus stops / services) is effectively
 * static and OneMap enforces a request quota, so identical upstream calls
 * must never be issued twice concurrently.
 */

/** @type {Map<string, Map<string, { value: unknown, expiresAt: number }>>} */
const caches = new Map();

function namespace(name) {
  if (!caches.has(name)) caches.set(name, new Map());
  return caches.get(name);
}

export function createCache(name) {
  const store = namespace(name);
  return {
    name,
    get(key) {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (Date.now() > entry.expiresAt) {
        store.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value, ttlMs) {
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    },
    delete(key) {
      store.delete(key);
    },
    size() {
      return store.size;
    },
    stats() {
      let live = 0;
      for (const entry of store.values()) if (entry.expiresAt > Date.now()) live += 1;
      return { name, entries: store.size, live };
    },
  };
}

/** @type {Map<string, Promise<unknown>>} */
const inflight = new Map();

/**
 * Cache-aside loader: returns a cached value, joins an in-flight identical
 * request, or runs `loader` and caches the result. Errors are never cached.
 */
export async function memoize({ cache, key, ttlMs, loader }) {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const lockKey = `${cache.name}::${key}`;
  const pending = inflight.get(lockKey);
  if (pending) return pending;

  const promise = (async () => {
    const value = await loader();
    cache.set(key, value, ttlMs);
    return value;
  })();

  inflight.set(lockKey, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(lockKey);
  }
}

export function cacheStats() {
  return [...caches.keys()].map((name) => createCache(name).stats());
}